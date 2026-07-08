import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  repoPath,
  Result,
  TaggedError,
  type Log,
  type StateDir,
} from "@op/core";
import type { RunAgent } from "@op/crew";
import type { Forge } from "@op/forge";
import type { IssueRow, UserRow } from "@op/store";
import type { LoadAgent } from "../platform-config.ts";
import { makeHeartbeat } from "./heartbeat.ts";

export class BuilderError extends TaggedError("BuilderError")<{
  message: string;
  step: string;
}>() {}

// The builder agent only ever edits files + commits LOCALLY. It is handed a
// checkout with no git remote credential and no platform token — only its
// inference token. The driver (below) does the push + PR in-process, so the
// #16 boundary holds: the model cannot reach anything but its working tree.
const BUILDER_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(bun:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
];
const BUILDER_DENIED_TOOLS = [
  "Bash(git push:*)",
  "Bash(rm -rf:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "WebFetch",
];

async function makeWritable(dir: string): Promise<void> {
  // a+rwX so the container's uid-1000 agent can write every file + create in
  // every dir. Capital X adds execute ONLY to directories and already-
  // executable files, so a plain 0644 source file stays non-executable — git
  // records the execute bit, and flipping it would look like a spurious diff.
  const p = Bun.spawn(["chmod", "-R", "a+rwX", dir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await p.exited;
}

async function revParse(checkout: string): Promise<string> {
  const p = Bun.spawn(
    ["git", "-c", "safe.directory=*", "-C", checkout, "rev-parse", "HEAD"],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  return (await new Response(p.stdout).text()).trim();
}

async function git(cwd: string, args: string[]): Promise<void> {
  // safe.directory=* : the containerized agent (uid 1000) writes .git objects
  // into a checkout the driver (operator uid) owns — git would otherwise refuse
  // the mixed ownership as "dubious".
  const p = Bun.spawn(["git", "-c", "safe.directory=*", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if ((await p.exited) !== 0)
    throw new Error(`git ${args[0]}: ${await new Response(p.stderr).text()}`);
}

export interface BuilderDeps {
  sd: StateDir;
  forge: Forge;
  domain: string;
  systemActor: UserRow; // the platform admin the driver acts as for the push/PR
  runAgent: RunAgent;
  loadAgent: LoadAgent; // the builder role prompt, from git (plat/platform)
  oauthToken: string;
  log: Log;
  onProgress?: (line: string) => void;
}

/**
 * Build the change described by an issue: clone → feature branch → the agent
 * edits + commits → the driver pushes + opens a PR (which auto-creates a
 * preview env with forked data). Returns the PR number.
 *
 * In rework mode (opts.rework), it checks out the EXISTING PR branch and hands
 * the agent the reviewer's blockers to fix — a new commit on the same branch
 * updates the open PR (no new PR), which re-triggers the preview + review.
 */
export async function runBuilder(
  deps: BuilderDeps,
  issue: IssueRow,
  opts: {
    rework?: { verdict: string; prNumber: number; attempt: number };
  } = {},
): Promise<Result<{ prNumber: number; costUsd: number }, BuilderError>> {
  const fail = (step: string) => (cause: unknown) =>
    new BuilderError({ message: String(cause), step });
  const rework = opts.rework;

  // Work under $HOME (VM-backed engines only share $HOME) though the agent
  // never touches Docker — keeps every op's scratch space consistent.
  const workRoot = join(homedir(), ".op-crew");
  await mkdir(workRoot, { recursive: true });

  return Result.tryPromise({
    try: async () => {
      const work = await mkdtemp(join(workRoot, "build-"));
      try {
        const bare = repoPath(deps.sd, issue.owner, issue.repo);
        const checkout = join(work, "repo");
        await git(work, ["clone", "-q", bare, checkout]);

        const branch = `agent/issue-${issue.number}`;
        // Rework continues the EXISTING PR branch (keeping prior work); a fresh
        // build starts a new branch off main, overwriting any stale one.
        await git(
          checkout,
          rework
            ? ["checkout", "-q", "-B", branch, `origin/${branch}`]
            : ["checkout", "-q", "-B", branch],
        );

        // The spec the agent reads. Kept out of the commit (agents shouldn't
        // ship ISSUE.md) via .git/info/exclude.
        await writeFile(
          join(checkout, "ISSUE.md"),
          `# ${issue.title}\n\n${issue.body || "(no description)"}\n`,
        );
        await writeFile(
          join(checkout, ".git", "info", "exclude"),
          "ISSUE.md\n.op-claude-cfg/\n",
        );

        // The agent runs as a non-root container user (uid 1000); make the whole
        // checkout (source + .git) writable so it can edit and commit.
        await makeWritable(checkout);

        const agent = await deps.loadAgent("builder");
        if (agent.status === "error")
          throw new Error(`load builder: ${agent.error.message}`);

        // Capture the branch head so rework can detect a no-op fix.
        const headBefore = await revParse(checkout);

        deps.onProgress?.(
          rework
            ? `🔧 reworking (attempt ${rework.attempt})`
            : "🏗️ builder starting",
        );
        const run = await deps.runAgent({
          cwd: checkout,
          systemPrompt: agent.value.instructions,
          prompt: rework
            ? `Read ISSUE.md for the original spec. The adversarial reviewer FAILED your pull request with these blockers:\n\n${rework.verdict}\n\nFix EXACTLY these blockers in this app, keeping everything else working (auth, the OIDC login, the JSON/HTML contract, existing data). Read the current code first, make the smallest correct fix, then commit locally with a clear message. Do not push; do not open a pull request.`
            : "Read ISSUE.md and implement exactly what it asks in this app, then commit your work locally with a clear message. Do not push; do not open a pull request.",
          oauthToken: deps.oauthToken,
          allowedTools: BUILDER_ALLOWED_TOOLS,
          disallowedTools: BUILDER_DENIED_TOOLS,
          idleTimeoutMs: 8 * 60_000,
          hardTimeoutMs: 30 * 60_000,
          ...(deps.onProgress
            ? { onLine: makeHeartbeat(deps.onProgress) }
            : {}),
          log: deps.log,
        });
        if (run.status === "error")
          throw new Error(`agent: ${run.error.message}`);

        // Backstop: commit anything the agent left uncommitted so a forgotten
        // final commit doesn't lose work.
        await git(checkout, ["add", "-A"]);
        const dirty = Bun.spawn(
          [
            "git",
            "-c",
            "safe.directory=*",
            "-C",
            checkout,
            "status",
            "--porcelain",
          ],
          { stdout: "pipe" },
        );
        if ((await new Response(dirty.stdout).text()).trim()) {
          await git(checkout, [
            "-c",
            "user.email=crew@platform",
            "-c",
            "user.name=crew",
            "commit",
            "-q",
            "-m",
            `agent: ${issue.title}`,
          ]);
        }

        // The agent changed nothing ⇒ fail loudly rather than push an empty
        // change. Fresh build: no commits ahead of main. Rework: the branch
        // head didn't move.
        if (rework) {
          if ((await revParse(checkout)) === headBefore)
            throw new Error(
              "rework produced no changes (reviewer would fail again)",
            );
        } else {
          const revlist = Bun.spawn(
            [
              "git",
              "-c",
              "safe.directory=*",
              "-C",
              checkout,
              "rev-list",
              "--count",
              "origin/main..HEAD",
            ],
            { stdout: "pipe", stderr: "ignore" },
          );
          const ahead = Number(
            (await new Response(revlist.stdout).text()).trim() || "0",
          );
          if (ahead === 0)
            throw new Error(
              "agent produced no changes (no commits ahead of main)",
            );
        }

        // Driver push (local bare path — no network credential). A fresh build
        // opens a PR (auto-creating a preview with forked data); a rework just
        // updates the existing PR's branch, which re-triggers preview + review.
        await git(checkout, [
          "push",
          "-q",
          "--force",
          "origin",
          `${branch}:${branch}`,
        ]);
        if (rework)
          return { prNumber: rework.prNumber, costUsd: run.value.costUsd };
        const pr = await deps.forge.createPr(
          deps.systemActor,
          issue.owner,
          issue.repo,
          {
            title: `${issue.title} (#${issue.number})`,
            head: branch,
          },
        );
        if (pr.status === "error")
          throw new Error(`open PR: ${pr.error.message}`);
        return { prNumber: pr.value.number, costUsd: run.value.costUsd };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    catch: fail("runBuilder"),
  });
}
