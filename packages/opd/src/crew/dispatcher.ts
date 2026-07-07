import type { Log, StateDir } from "@op/core";
import type { RunAgent } from "@op/crew";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import type { IssueRow, Store, UserRow } from "@op/store";
import { runBuilder } from "./builder.ts";

const WORK_LABEL = "agent-work";
const BUILDING_LABEL = "agent-building";
const SHIPPED_LABEL = "agent-shipped";
const FAILED_LABEL = "agent-failed";

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

    const port = this.portSuffix();
    const prUrl = `https://${this.deps.domain}${port}/apps/${issue.owner}/${issue.repo}/pulls/${built.value.prNumber}`;
    const previewHost = `pr-${built.value.prNumber}-${issue.repo}-${issue.owner}.${this.deps.domain}${port}`;
    this.setLabels(issue, [...labels, SHIPPED_LABEL]);
    this.comment(
      issue,
      `✅ Opened PR #${built.value.prNumber} → ${prUrl}\n\nA preview with forked prod data is spinning up at https://${previewHost}/ (cost $${built.value.costUsd.toFixed(2)}). Review and merge to ship.`,
    );
    log.info("crew: PR opened", {
      issue: this.key(issue),
      pr: built.value.prNumber,
      cost: built.value.costUsd,
    });
  }

  // Non-443 dev ports must appear in the console/preview links.
  private portSuffix(): string {
    return this.deps.httpsPort === 443 ? "" : `:${this.deps.httpsPort}`;
  }
}
