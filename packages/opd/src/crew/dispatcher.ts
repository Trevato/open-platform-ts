import type { Log, StateDir } from "@op/core";
import type { RunAgent } from "@op/crew";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import type { IssueRow, Store, UserRow } from "@op/store";
import {
  PLAT,
  isSelfRepo,
  type LoadAgent,
  type PlatformSettings,
} from "../platform-config.ts";
import { runBuilder } from "./builder.ts";
import { runReviewer } from "./reviewer.ts";

const WORK_LABEL = "agent-work";
const BUILDING_LABEL = "agent-building";
const REVIEWING_LABEL = "agent-reviewing";
const REWORK_LABEL = "agent-reworking";
const SHIPPED_LABEL = "agent-shipped";
const FAILED_LABEL = "agent-failed";
const REVIEW_FAILED_LABEL = "agent-review-failed";

export interface DispatcherDeps {
  sd: StateDir;
  store: Store;
  forge: Forge;
  git: GitHost;
  domain: string;
  httpsPort: number;
  systemActor: UserRow;
  /** Bound model runner, or null when no Claude credential is configured. */
  runAgent: RunAgent | null;
  /** The crew role prompts, from git (plat/platform) — hot-reloadable. */
  loadAgent: LoadAgent;
  /** Live platform settings (crew.maxRework, sweepMs), re-read from git on push. */
  config: () => PlatformSettings;
  oauthToken: string | null;
  /** Platform CA (path + text) for the reviewer's TLS to the preview/issuer. */
  caFile: string;
  ca: string;
  /** Low-privilege QA identity the reviewer signs in as. */
  qaUser: string;
  qaPassword: string;
  /** Kick the deploy reconciler so a crew-opened PR gets its preview built
   *  (the builder opens the PR in-process, so no push event fires). */
  kickReconciler: () => void;
  /** Override the "is the preview serving?" probe (tests inject a stub). */
  previewIsUp?: (previewHost: string) => Promise<boolean>;
  /** How many times to feed a ❌ verdict back to the builder before parking
   *  for a human. 0 disables rework. Defaults to 2. */
  maxRework?: number;
  /** Ops/demo hook: when set, the FIRST review of each issue is skipped and
   *  returns this string as a ❌ blocker, so the rework loop can be exercised
   *  end-to-end against a real (fixable) requirement. Later reviews are real. */
  forceFirstReviewFail?: string;
  log: Log;
}

/**
 * The crew dispatcher: watches for `agent-work` issues and drives the builder.
 * It is the SOLE writer of labels/comments for a run, so exactly one build
 * happens per issue even under concurrent sweep + kick. Runs on its own loop,
 * independent of the deploy reconciler.
 */
export class Dispatcher {
  private readonly inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private notifiedNoCred = false;

  constructor(private readonly deps: DispatcherDeps) {}

  start(sweepMs = this.deps.config().crew.sweepMs): void {
    this.timer = setInterval(() => void this.tick(), sweepMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Explicit wake (called when an issue is labeled agent-work). */
  kick(): void {
    void this.tick();
  }

  private key(i: IssueRow): string {
    return `${i.owner}/${i.repo}#${i.number}`;
  }

  async tick(): Promise<void> {
    const issues = this.deps.store.listIssuesByLabel(WORK_LABEL);
    for (const issue of issues) {
      const k = this.key(issue);
      if (this.inflight.has(k)) continue;
      // DAG flow control: don't start an issue while any blocker is still open.
      // When the blocker ships (issue closed), a later tick picks this up — no
      // explicit unblock needed, since openBlockers filters on state.
      const blockers = this.deps.store.openBlockers(
        issue.owner,
        issue.repo,
        issue.number,
      );
      if (blockers.length > 0) continue;
      // Claim BEFORE any await so a concurrent tick can't double-pick.
      this.inflight.add(k);
      void this.process(issue).finally(() => this.inflight.delete(k));
    }
  }

  private setLabels(issue: IssueRow, labels: string[]): void {
    this.deps.store.setIssueLabels(
      issue.owner,
      issue.repo,
      issue.number,
      labels,
    );
  }

  private comment(issue: IssueRow, body: string): void {
    this.deps.store.addComment(
      issue.owner,
      issue.repo,
      issue.number,
      "crew",
      body,
    );
  }

  private async process(issue: IssueRow): Promise<void> {
    const { log } = this.deps;

    if (!this.deps.runAgent || !this.deps.oauthToken) {
      if (!this.notifiedNoCred) {
        this.notifiedNoCred = true;
        this.comment(
          issue,
          "🤖 The crew isn't credentialed yet — set `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token`) and restart the platform. This issue will build once it's set.",
        );
      }
      return;
    }

    // Only build issues on repos that are deployed apps (so a preview appears).
    if (!this.deps.store.getRepo(issue.owner, issue.repo)) return;

    // Move agent-work → agent-building so a sweep won't re-pick, and log start.
    const labels = issue.labels.split(",").filter((l) => l && l !== WORK_LABEL);
    this.setLabels(issue, [...labels, BUILDING_LABEL]);
    this.comment(
      issue,
      "🏗️ Build crew picked this up. Writing the change on a branch…",
    );
    log.info("crew: building", { issue: this.key(issue) });

    const built = await runBuilder(this.builderDeps(issue), issue);

    if (built.status === "error") {
      log.error("crew: build failed", {
        issue: this.key(issue),
        error: built.error.message,
      });
      this.setLabels(issue, [...labels, FAILED_LABEL]);
      this.comment(
        issue,
        `❌ Build failed: ${built.error.message}\n\nRe-add the \`agent-work\` label to retry.`,
      );
      return;
    }

    const pr = built.value.prNumber;
    const port = this.portSuffix();
    const prUrl = `https://${this.deps.domain}${port}/apps/${issue.owner}/${issue.repo}/pulls/${pr}`;

    // Self-modification: the platform's own config (plat/platform) or source
    // (plat/opd) is not a deployed app — there's no live preview to review. The
    // crew PROPOSES the change; a human reviews the diff and merges. Higher
    // stakes, human gate — no auto-merge, no preview.
    if (isSelfRepo(issue.owner, issue.repo)) {
      const isConfig = issue.repo === PLAT.name;
      this.setLabels(issue, [...labels, REVIEW_FAILED_LABEL]);
      this.comment(
        issue,
        `🛠️ Proposed the change in PR #${pr} → ${prUrl} (cost $${built.value.costUsd.toFixed(2)}). This edits the platform's own ${isConfig ? "config" : "source"} (\`${issue.owner}/${issue.repo}\`) — review the diff and merge. ${isConfig ? `A push to \`${PLAT.name}\` hot-reloads it; no restart.` : "Applying source changes needs `op upgrade` or a restart."}`,
      );
      log.info("crew: self-change proposed", { issue: this.key(issue), pr });
      return;
    }

    // The PR was opened in-process (no push event), so kick the reconciler to
    // build its preview environment with forked data.
    this.deps.kickReconciler();
    const previewHost = `pr-${pr}-${issue.repo}-${issue.owner}.${this.deps.domain}`;
    this.setLabels(issue, [...labels, REVIEWING_LABEL]);
    this.comment(
      issue,
      `🏗️ Opened PR #${pr} → ${prUrl} (cost $${built.value.costUsd.toFixed(2)}). Preview spinning up; the reviewer will test it.`,
    );
    log.info("crew: PR opened", {
      issue: this.key(issue),
      pr,
      cost: built.value.costUsd,
    });

    // Build → review → (rework on ❌)* until it passes or we give up.
    const maxRework = this.deps.maxRework ?? this.deps.config().crew.maxRework;
    let attempt = 0;
    if (!(await this.waitForPreview(previewHost)))
      return this.park(
        issue,
        labels,
        pr,
        "the preview never came up",
        FAILED_LABEL,
      );

    while (true) {
      this.comment(
        issue,
        "🔍 Reviewer testing the preview (sign-in, feature, injection, bad input)…",
      );
      let v: {
        kind: "pass" | "concerns" | "fail" | "untestable" | "unknown";
        line: string;
        costUsd: number;
      };
      if (attempt === 0 && this.deps.forceFirstReviewFail) {
        // Ops/demo hook: force a real, fixable blocker on the FIRST review so
        // the auto-rework loop runs end-to-end. The re-review below is real.
        v = {
          kind: "fail",
          line: `❌ FAIL — ${this.deps.forceFirstReviewFail}`,
          costUsd: 0,
        };
        this.comment(
          issue,
          `${v.line}\n\n(injected to demonstrate auto-rework end-to-end)`,
        );
      } else {
        const verdict = await runReviewer(this.reviewerDeps(issue), {
          owner: issue.owner,
          repo: issue.repo,
          prNumber: pr,
          issueBody: issue.body,
          issueTitle: issue.title,
        });
        if (verdict.status === "error")
          return this.park(
            issue,
            labels,
            pr,
            `the review couldn't run (${verdict.error.message})`,
            FAILED_LABEL,
          );
        v = verdict.value;
        this.comment(
          issue,
          `${v.line}\n\n(reviewer cost $${v.costUsd.toFixed(2)})`,
        );
      }

      // ✅/⚠️ → auto-merge, ship, done. EXCEPT the platform's own config repo:
      // a change to plat/platform alters the running daemon (prompts, tunables),
      // so it never auto-merges — the crew PROPOSES, a human merges (the merge
      // triggers the hot-reload). Higher stakes → a human gate.
      if (v.kind === "pass" || v.kind === "concerns") {
        const merged = await this.deps.forge.mergePr(
          this.deps.systemActor,
          issue.owner,
          issue.repo,
          pr,
        );
        if (merged.status === "error")
          return this.park(
            issue,
            labels,
            pr,
            `merge failed after a passing review (${merged.error.message})`,
            FAILED_LABEL,
          );
        this.deps.kickReconciler(); // ship the merge + tear down the preview
        this.setLabels(issue, [...labels, SHIPPED_LABEL]);
        this.deps.store.setIssueState(
          issue.owner,
          issue.repo,
          issue.number,
          "closed",
        );
        this.comment(
          issue,
          `🚀 Merged PR #${pr} and shipping to production. Issue closed.`,
        );
        log.info("crew: shipped", {
          issue: this.key(issue),
          pr,
          attempts: attempt + 1,
        });
        return;
      }

      // UNTESTABLE → a human is needed; we can't trust a fix we can't verify.
      if (v.kind === "untestable")
        return this.park(
          issue,
          labels,
          pr,
          "the reviewer couldn't test the preview",
          REVIEW_FAILED_LABEL,
        );

      // ❌ FAIL — rework if attempts remain, else park.
      if (attempt >= maxRework) {
        this.setLabels(issue, [...labels, REVIEW_FAILED_LABEL]);
        this.comment(
          issue,
          `The reviewer still finds blockers after ${attempt + 1} attempt${attempt ? "s" : ""}. PR #${pr} is left open for a human.`,
        );
        log.info("crew: rework exhausted", {
          issue: this.key(issue),
          pr,
          attempts: attempt + 1,
        });
        return;
      }
      attempt++;
      this.setLabels(issue, [...labels, REWORK_LABEL]);
      this.comment(
        issue,
        `🔧 Reworking to fix the reviewer's blockers (attempt ${attempt}/${maxRework})…`,
      );
      const sinceTs = this.now();
      const reworked = await runBuilder(this.builderDeps(issue), issue, {
        rework: { verdict: v.line, prNumber: pr, attempt },
      });
      if (reworked.status === "error")
        return this.park(
          issue,
          labels,
          pr,
          `the rework failed (${reworked.error.message})`,
          FAILED_LABEL,
        );
      this.deps.kickReconciler(); // rebuild the preview from the updated branch
      this.setLabels(issue, [...labels, REVIEWING_LABEL]);
      this.comment(
        issue,
        `Pushed the fix to PR #${pr}; rebuilding the preview to re-review…`,
      );
      if (
        !(await this.waitForPreviewRebuild(
          issue.owner,
          issue.repo,
          pr,
          sinceTs,
        ))
      )
        return this.park(
          issue,
          labels,
          pr,
          "the reworked preview never came up",
          FAILED_LABEL,
        );
    }
  }

  private park(
    issue: IssueRow,
    labels: string[],
    pr: number,
    why: string,
    label: string,
  ): void {
    this.setLabels(issue, [...labels, label]);
    this.comment(
      issue,
      `⚠️ Parked: ${why}. PR #${pr} is left open for a human.`,
    );
    this.deps.log.info("crew: parked", { issue: this.key(issue), pr, why });
  }

  private builderDeps(issue: IssueRow) {
    return {
      sd: this.deps.sd,
      forge: this.deps.forge,
      domain: this.deps.domain,
      systemActor: this.deps.systemActor,
      runAgent: this.deps.runAgent!,
      loadAgent: this.deps.loadAgent,
      // The platform's own repos get the platform-dev prompt, not the app builder.
      // Role by context: the platform's own repos → platform-dev; a fresh
      // import (agent-import label, present only on the first conversion issue)
      // → importer; everything else → the app builder.
      role: isSelfRepo(issue.owner, issue.repo)
        ? "platform-dev"
        : issue.labels.split(",").includes("agent-import")
          ? "importer"
          : "builder",
      oauthToken: this.deps.oauthToken!,
      model: this.deps.config().crew.model,
      log: this.deps.log,
      onProgress: (line: string) => this.comment(issue, line),
    };
  }

  private reviewerDeps(issue: IssueRow) {
    return {
      domain: this.deps.domain,
      httpsPort: this.deps.httpsPort,
      caFile: this.deps.caFile,
      runAgent: this.deps.runAgent!,
      loadAgent: this.deps.loadAgent,
      oauthToken: this.deps.oauthToken!,
      model: this.deps.config().crew.model,
      qaUser: this.deps.qaUser,
      qaPassword: this.deps.qaPassword,
      log: this.deps.log,
      onProgress: (line: string) => this.comment(issue, line),
    };
  }

  // Wall clock — overridable so tests don't depend on real time.
  private now(): number {
    return Date.now();
  }

  /** After a rework push, wait for the reconciler to actually REBUILD the
   *  preview (a fresh preview-ready/preview-failed event) so the reviewer tests
   *  the new code, not the still-running old container. */
  private async waitForPreviewRebuild(
    owner: string,
    repo: string,
    pr: number,
    sinceTs: number,
  ): Promise<boolean> {
    const previewHost = `pr-${pr}-${repo}-${owner}.${this.deps.domain}`;
    if (this.deps.previewIsUp) return this.deps.previewIsUp(previewHost);
    const ready = `preview-ready (pr-${pr})`;
    const failed = `preview-failed (pr-${pr})`;
    for (let i = 0; i < 150; i++) {
      const ev = this.deps.store
        .listEvents(owner, repo, 20)
        .find(
          (e) => e.ts > sinceTs && (e.phase === ready || e.phase === failed),
        );
      if (ev) return ev.phase === ready;
      await Bun.sleep(2000);
    }
    return false;
  }

  /** Poll the preview host until it serves (or give up). Reaches it via the
   *  gate on 127.0.0.1 (the pr- host resolves there through *.localtest.me). */
  private async waitForPreview(previewHost: string): Promise<boolean> {
    if (this.deps.previewIsUp) return this.deps.previewIsUp(previewHost);
    const url = `https://${previewHost}${this.portSuffix()}/`;
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(url, {
          tls: { ca: this.deps.ca },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) return true;
      } catch {
        /* not up yet */
      }
      await Bun.sleep(2000);
    }
    return false;
  }

  // Non-443 dev ports must appear in the console/preview links.
  private portSuffix(): string {
    return this.deps.httpsPort === 443 ? "" : `:${this.deps.httpsPort}`;
  }
}
