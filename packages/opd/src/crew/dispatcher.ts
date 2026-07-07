import type { Log, StateDir } from "@op/core";
import type { RunAgent } from "@op/crew";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import type { IssueRow, Store, UserRow } from "@op/store";
import { runBuilder } from "./builder.ts";
import { runReviewer } from "./reviewer.ts";

const WORK_LABEL = "agent-work";
const BUILDING_LABEL = "agent-building";
const REVIEWING_LABEL = "agent-reviewing";
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
  genesisDir: string;
  systemActor: UserRow;
  /** Bound model runner, or null when no Claude credential is configured. */
  runAgent: RunAgent | null;
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

  start(sweepMs = 30_000): void {
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

    const built = await runBuilder(
      {
        sd: this.deps.sd,
        forge: this.deps.forge,
        domain: this.deps.domain,
        genesisDir: this.deps.genesisDir,
        systemActor: this.deps.systemActor,
        runAgent: this.deps.runAgent,
        oauthToken: this.deps.oauthToken,
        log,
        onProgress: (line) => this.comment(issue, line),
      },
      issue,
    );

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

    // The PR was opened in-process (no push event), so kick the reconciler to
    // build its preview environment with forked data.
    this.deps.kickReconciler();

    const pr = built.value.prNumber;
    const port = this.portSuffix();
    const prUrl = `https://${this.deps.domain}${port}/apps/${issue.owner}/${issue.repo}/pulls/${pr}`;
    const previewHost = `pr-${pr}-${issue.repo}-${issue.owner}.${this.deps.domain}`;
    this.setLabels(issue, [...labels, REVIEWING_LABEL]);
    this.comment(
      issue,
      `🏗️ Opened PR #${pr} → ${prUrl} (cost $${built.value.costUsd.toFixed(2)}). Preview spinning up; the reviewer will browser-test it.`,
    );
    log.info("crew: PR opened", {
      issue: this.key(issue),
      pr,
      cost: built.value.costUsd,
    });

    // Wait for the preview to actually serve before reviewing it.
    const previewUp = await this.waitForPreview(previewHost);
    if (!previewUp) {
      this.setLabels(issue, [...labels, FAILED_LABEL]);
      this.comment(
        issue,
        `❌ PR #${pr}'s preview never came up — a human should look. PR left open.`,
      );
      return;
    }

    // Review: a caged agent tries to break the live preview and returns a verdict.
    this.comment(
      issue,
      "🔍 Reviewer testing the preview (sign-in, feature, injection, bad input)…",
    );
    const verdict = await runReviewer(
      {
        domain: this.deps.domain,
        httpsPort: this.deps.httpsPort,
        genesisDir: this.deps.genesisDir,
        caFile: this.deps.caFile,
        runAgent: this.deps.runAgent,
        oauthToken: this.deps.oauthToken,
        qaUser: this.deps.qaUser,
        qaPassword: this.deps.qaPassword,
        log,
        onProgress: (line) => this.comment(issue, line),
      },
      {
        owner: issue.owner,
        repo: issue.repo,
        prNumber: pr,
        issueBody: issue.body,
        issueTitle: issue.title,
      },
    );

    if (verdict.status === "error") {
      this.setLabels(issue, [...labels, FAILED_LABEL]);
      this.comment(
        issue,
        `❌ Review couldn't run: ${verdict.error.message}. PR #${pr} left open for a human.`,
      );
      return;
    }

    const v = verdict.value;
    this.comment(
      issue,
      `${v.line}\n\n(reviewer cost $${v.costUsd.toFixed(2)})`,
    );

    if (v.kind === "pass" || v.kind === "concerns") {
      // Auto-merge on a pass → ship to prod + tear down the preview.
      const merged = await this.deps.forge.mergePr(
        this.deps.systemActor,
        issue.owner,
        issue.repo,
        pr,
      );
      if (merged.status === "error") {
        this.setLabels(issue, [...labels, FAILED_LABEL]);
        this.comment(
          issue,
          `Reviewer passed, but merge failed: ${merged.error.message}. PR #${pr} left open.`,
        );
        return;
      }
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
      log.info("crew: shipped", { issue: this.key(issue), pr });
    } else {
      // ❌ FAIL / UNTESTABLE / unclear verdict — leave the PR for a human.
      this.setLabels(issue, [...labels, REVIEW_FAILED_LABEL]);
      this.comment(
        issue,
        `The reviewer did not pass this. PR #${pr} is left open for a human to decide.`,
      );
      log.info("crew: review not passed", {
        issue: this.key(issue),
        pr,
        verdict: v.kind,
      });
    }
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
