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

// Labels are taxonomy only — the work-item `phase` column is the process
// truth, enforced by the store's legal-edge table. `agent-import` survives
// as taxonomy (role selection), `agent-work` as the human enqueue verb.

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
 * The crew dispatcher: watches queued work items and drives the builder.
 * The store's claimWork CAS makes double-picks structurally impossible;
 * the inflight set just avoids wasted claims within this process. Runs on
 * its own loop, independent of the deploy reconciler.
 */
export class Dispatcher {
  private readonly inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DispatcherDeps) {}

  start(sweepMs = this.deps.config().crew.sweepMs): void {
    this.sweepStranded();
    this.timer = setInterval(() => void this.tick(), sweepMs);
    void this.tick();
  }

  /** Crash recovery: work stranded mid-flight by a daemon restart. Builds
   *  restart from queued (park → re-queue keeps the ledger honest); an item
   *  already in review resumes its review loop against the live preview; a
   *  merge whose bookkeeping the restart cut short is finished from git. */
  private sweepStranded(): void {
    const { store } = this.deps;
    // A self-repo merge stops THIS daemon (self-upgrade): the git merge can
    // land while the shipped/closed writes die with the process. Git is the
    // truth — a parked item whose branch is already an ancestor of main was
    // merged; finish its ledger here.
    for (const item of store.listWorkByPhase("parked")) {
      if (item.change_state !== "open" || !item.head_ref) continue;
      // Fire-and-forget, but FULLY guarded: isAncestor spawns git (tens of ms),
      // and in that window a human Close/Merge or another path can move this
      // item out of parked — making setWorkPhase(...,'shipped') an illegal
      // transition that throws. Uncaught in a bare .then() that would be an
      // unhandled rejection, which kills the daemon (fatal in unsupervised
      // mode). Re-read the row after the await and catch everything.
      void (async () => {
        try {
          const merged = await this.deps.git.isAncestor(
            item.owner,
            item.repo,
            item.head_ref!,
            item.base_ref ?? "main",
          );
          if (!merged) return;
          const cur = store.getIssue(item.owner, item.repo, item.number);
          if (!cur || cur.phase !== "parked" || cur.change_state !== "open")
            return; // moved on concurrently — nothing to repair
          store.setWorkPhase(item.owner, item.repo, item.number, "shipped");
          store.setChangeState(item.owner, item.repo, item.number, "merged");
          this.comment(
            item,
            "🚀 The merge landed just as the platform restarted (a self-upgrade does exactly that); the ledger is now caught up. Work item closed.",
          );
          this.deps.log.info("crew: repaired interrupted merge", {
            issue: this.key(item),
          });
        } catch (cause) {
          this.deps.log.warn("crew: merge-repair skipped", {
            issue: this.key(item),
            err: String(cause),
          });
        }
      })();
    }
    for (const phase of ["building", "reworking"] as const) {
      for (const item of store.listWorkByPhase(phase)) {
        store.setWorkPhase(item.owner, item.repo, item.number, "parked", {
          parkedReason: "daemon-restarted",
        });
        store.setWorkPhase(item.owner, item.repo, item.number, "queued");
        this.comment(
          item,
          "🔁 The platform restarted mid-build; this work item was re-queued.",
        );
      }
    }
    for (const item of store.listWorkByPhase("reviewing")) {
      const k = this.key(item);
      if (this.inflight.has(k)) continue;
      this.inflight.add(k);
      void this.resumeReview(item).finally(() => this.inflight.delete(k));
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Explicit wake (called when a work item is queued). */
  kick(): void {
    void this.tick();
  }

  private key(i: IssueRow): string {
    return `${i.owner}/${i.repo}#${i.number}`;
  }

  async tick(): Promise<void> {
    for (const item of this.deps.store.listWorkByPhase("queued")) {
      const k = this.key(item);
      if (this.inflight.has(k)) continue;
      // DAG flow control: a blocker counts as open until its phase is
      // terminal. When it ships, a later tick picks this up.
      const blockers = this.deps.store.openWorkBlockers(
        item.owner,
        item.repo,
        item.number,
      );
      if (blockers.length > 0) continue;
      // Only build on repos that are deployed apps (so a preview appears) or
      // the platform's own repos (proposed to a human).
      if (!this.deps.store.getRepo(item.owner, item.repo)) continue;
      if (!this.deps.runAgent || !this.deps.oauthToken) {
        // No credential: the item stays queued and builds the moment one
        // appears. The console's crew pill shows "needs a token" live — a
        // stored comment here would only linger and mislead once it's set.
        continue;
      }
      // The CAS claim: losing to a concurrent claimant is normal, not an error.
      if (!this.deps.store.claimWork(item.owner, item.repo, item.number))
        continue;
      this.inflight.add(k);
      // .catch is load-bearing: process() ends in a park()/merge() whose
      // setWorkPhase CAS THROWS on an illegal/late transition (e.g. a human
      // Close during a build). Unhandled, that rejection can take the whole
      // daemon down. Swallow-and-log here — the item's row is already
      // consistent (the CAS simply didn't apply), and the next tick re-picks
      // anything still actionable.
      void this.process(item)
        .catch((cause) =>
          this.deps.log.error("crew: process crashed", {
            issue: k,
            err: String(cause),
          }),
        )
        .finally(() => this.inflight.delete(k));
    }
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

  /** Resume a review interrupted by a restart: the change is attached and the
   *  preview (re)converges on boot, so pick the loop back up. */
  private async resumeReview(item: IssueRow): Promise<void> {
    if (!this.deps.runAgent || !this.deps.oauthToken) return; // stays reviewing
    if (!item.head_ref) return;
    this.comment(item, "🔁 The platform restarted; resuming the review.");
    this.deps.kickReconciler();
    const previewHost = `pr-${item.number}-${item.repo}-${item.owner}.${this.deps.domain}`;
    if (!(await this.waitForPreview(previewHost)))
      return this.park(
        item,
        "the preview never came back after a restart",
        "preview-never-up",
      );
    await this.reviewLoop(item);
  }

  private async process(issue: IssueRow): Promise<void> {
    const { log, store } = this.deps;

    this.comment(
      issue,
      "🏗️ Build crew picked this up. Writing the change on a branch…",
    );
    log.info("crew: building", { issue: this.key(issue) });

    const attempt = store.openWorkAttempt(
      issue.owner,
      issue.repo,
      issue.number,
    );
    const built = await runBuilder(this.builderDeps(issue), issue);

    if (built.status === "error") {
      log.error("crew: build failed", {
        issue: this.key(issue),
        error: built.error.message,
      });
      return this.park(
        issue,
        `the build failed (${built.error.message})`,
        "build-failed",
      );
    }
    store.setAttemptBuilder(issue.owner, issue.repo, issue.number, attempt, {
      builderCostUsd: built.value.costUsd,
    });

    // The agent invoked the decline contract: mis-scoped work, explained in
    // its own words. Park with the explanation — a human edits the issue (or
    // re-files it on the right repo) and Re-queues.
    if (built.value.declined) {
      this.park(
        issue,
        "the builder declined the work item",
        "declined",
        `🧭 The builder declined this work item (cost $${built.value.costUsd.toFixed(2)}):\n\n> ${built.value.declined.replace(/\n/g, "\n> ")}\n\nEdit the issue — or re-file it on the repo it belongs to — then Re-queue.`,
      );
      log.info("crew: declined", { issue: this.key(issue) });
      return;
    }

    const branch = `agent/issue-${issue.number}`;

    // Self-modification: the platform's own config (plat/platform) or source
    // (plat/opd) is not a deployed app — there's no live preview to review. The
    // crew PROPOSES the change; a human reviews the diff and merges. Higher
    // stakes, human gate — no auto-merge, no preview.
    if (isSelfRepo(issue.owner, issue.repo)) {
      const isConfig = issue.repo === PLAT.name;
      this.park(
        issue,
        `this edits the platform's own ${isConfig ? "config" : "source"}`,
        "self-repo-human-merge",
        `🛠️ Proposed the change on \`${branch}\` (cost $${built.value.costUsd.toFixed(2)}). This edits the platform's own ${isConfig ? "config" : "source"} (\`${issue.owner}/${issue.repo}\`) — review the diff and Merge. ${isConfig ? `A merge to \`${PLAT.name}\` hot-reloads it; no restart.` : "Applying source changes needs a supervised restart (`OP_SRC=… op up`) or a plain restart."}`,
      );
      log.info("crew: self-change proposed", { issue: this.key(issue) });
      return;
    }

    // Template repos (plat/app-template) are not deployed apps either — no
    // preview exists, and a merge changes every FUTURE app. Same human gate.
    if (this.deps.store.getRepo(issue.owner, issue.repo)?.is_template === 1) {
      this.park(
        issue,
        "this edits an app template",
        "template-human-merge",
        `🧬 Proposed the change on \`${branch}\` (cost $${built.value.costUsd.toFixed(2)}). This edits the template every future app starts from (\`${issue.owner}/${issue.repo}\`) — review the diff and Merge. Existing apps are unaffected.`,
      );
      log.info("crew: template change proposed", { issue: this.key(issue) });
      return;
    }

    // The change was attached in-process (no push event), so kick the
    // reconciler to build its preview environment with forked data.
    this.deps.kickReconciler();
    const previewHost = `pr-${issue.number}-${issue.repo}-${issue.owner}.${this.deps.domain}`;
    this.comment(
      issue,
      `🏗️ Change attached on \`${branch}\` (cost $${built.value.costUsd.toFixed(2)}). Preview spinning up; the reviewer will test it.`,
    );
    log.info("crew: change attached", {
      issue: this.key(issue),
      cost: built.value.costUsd,
    });

    if (!(await this.waitForPreview(previewHost)))
      return this.park(issue, "the preview never came up", "preview-never-up");

    await this.reviewLoop(issue);
  }

  /** Review → (rework on ❌)* until pass, park, or attempts run out. Shared
   *  by fresh builds and restart-resumed reviews; attempt state lives in the
   *  work_attempts ledger, so a crash never loses count. */
  private async reviewLoop(issue: IssueRow): Promise<void> {
    const { log, store } = this.deps;
    const maxRework = this.deps.maxRework ?? this.deps.config().crew.maxRework;

    while (true) {
      const priorAttempts = store.listAttempts(
        issue.owner,
        issue.repo,
        issue.number,
      );
      // Attempt numbers are 1-based and live in the ledger: attempt 1 is the
      // original build, each rework appends the next. attemptNo here is the
      // attempt UNDER REVIEW; human-facing rework messages print reworkNo - 1
      // ("rework k of maxRework") because the first attempt wasn't a rework.
      const attemptNo = priorAttempts.at(-1)?.attempt ?? 1;
      this.comment(
        issue,
        "🔍 Reviewer testing the preview (sign-in, feature, injection, bad input)…",
      );
      let v: {
        kind: "pass" | "concerns" | "fail" | "untestable" | "unknown";
        line: string;
        costUsd: number;
      };
      if (attemptNo === 1 && this.deps.forceFirstReviewFail) {
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
          workNumber: issue.number,
          issueBody: issue.body,
          issueTitle: issue.title,
          priorVerdicts: priorAttempts
            .filter((a) => a.verdict_line)
            .map((a) => a.verdict_line as string),
        });
        if (verdict.status === "error")
          return this.park(
            issue,
            `the review couldn't run (${verdict.error.message})`,
            "untestable",
          );
        v = verdict.value;
        this.comment(
          issue,
          `${v.line}\n\n(reviewer cost $${v.costUsd.toFixed(2)})`,
        );
      }
      store.setAttemptVerdict(
        issue.owner,
        issue.repo,
        issue.number,
        attemptNo,
        {
          verdict: v.kind,
          verdictLine: v.line,
          reviewerCostUsd: v.costUsd,
        },
      );

      // ✅/⚠️ → auto-merge, ship, done. (The platform's own repos never reach
      // this loop — they park for a human at build time.)
      if (v.kind === "pass" || v.kind === "concerns") {
        const merged = await this.deps.forge.mergeWork(
          this.deps.systemActor,
          issue.owner,
          issue.repo,
          issue.number,
        );
        if (merged.status === "error")
          return this.park(
            issue,
            `merge failed after a passing review (${merged.error.message})`,
            "merge-failed",
          );
        this.deps.kickReconciler(); // ship the merge + tear down the preview
        this.comment(
          issue,
          "🚀 Merged and shipping to production. Work item closed.",
        );
        log.info("crew: shipped", {
          issue: this.key(issue),
          attempts: attemptNo,
        });
        return;
      }

      // UNTESTABLE → a human is needed; we can't trust a fix we can't verify.
      if (v.kind === "untestable")
        return this.park(
          issue,
          "the reviewer couldn't test the preview",
          "untestable",
        );

      // ❌ FAIL — rework if attempts remain, else park. The ledger is the
      // counter, so a restart mid-loop can't reset it.
      if (attemptNo > maxRework) {
        return this.park(
          issue,
          `the reviewer still finds blockers after ${attemptNo} attempt${attemptNo > 1 ? "s" : ""}`,
          "rework-exhausted",
        );
      }
      store.setWorkPhase(issue.owner, issue.repo, issue.number, "reworking");
      const reworkNo = store.openWorkAttempt(
        issue.owner,
        issue.repo,
        issue.number,
      );
      this.comment(
        issue,
        `🔧 Reworking to fix the reviewer's blockers (attempt ${reworkNo - 1}/${maxRework})…`,
      );
      const sinceTs = this.now();
      const reworked = await runBuilder(this.builderDeps(issue), issue, {
        rework: { verdict: v.line, attempt: reworkNo - 1 },
      });
      if (reworked.status === "error")
        return this.park(
          issue,
          `the rework failed (${reworked.error.message})`,
          "build-failed",
        );
      store.setAttemptBuilder(issue.owner, issue.repo, issue.number, reworkNo, {
        builderCostUsd: reworked.value.costUsd,
      });
      if (reworked.value.declined)
        return this.park(
          issue,
          "the builder declined the rework",
          "declined",
          `🧭 The builder declined the rework:\n\n> ${reworked.value.declined.replace(/\n/g, "\n> ")}\n\nA human should resolve the blockers — Merge or Re-queue from the console.`,
        );
      this.deps.kickReconciler(); // rebuild the preview from the updated branch
      store.setWorkPhase(issue.owner, issue.repo, issue.number, "reviewing");
      this.comment(
        issue,
        "Pushed the fix; rebuilding the preview to re-review…",
      );
      if (
        !(await this.waitForPreviewRebuild(
          issue.owner,
          issue.repo,
          issue.number,
          sinceTs,
        ))
      )
        return this.park(
          issue,
          "the reworked preview never came up",
          "preview-never-up",
        );
    }
  }

  /** Park a work item for a human, from whatever active phase it's in. */
  private park(
    issue: IssueRow,
    why: string,
    reason: string,
    body?: string,
  ): void {
    this.deps.store.setWorkPhase(
      issue.owner,
      issue.repo,
      issue.number,
      "parked",
      { parkedReason: reason },
    );
    this.comment(
      issue,
      body ??
        `⚠️ Parked: ${why}. The change branch is left for a human — Merge or Re-queue from the console.`,
    );
    this.deps.log.info("crew: parked", { issue: this.key(issue), why });
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
