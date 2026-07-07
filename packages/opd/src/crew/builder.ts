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
import { loadAgent, type RunAgent } from "@op/crew";
import type { Forge } from "@op/forge";
import type { IssueRow, UserRow } from "@op/store";

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
  genesisDir: string;
  systemActor: UserRow; // the platform admin the driver acts as for the push/PR
  runAgent: RunAgent;
  oauthToken: string;
  log: Log;
  onProgress?: (line: string) => void;
}

/**
 * Build the change described by an issue: clone → feature branch → the agent
 * edits + commits → the driver pushes + opens a PR (which auto-creates a
 * preview env with forked data). Returns the PR number.
 */
export async function runBuilder(
  deps: BuilderDeps,
  issue: IssueRow,
): Promise<Result<{ prNumber: number; costUsd: number }, BuilderError>> {
  const fail = (step: string) => (cause: unknown) =>
    new BuilderError({ message: String(cause), step });

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
        // A fresh branch each attempt; overwrite a stale one from a prior try.
        await git(checkout, ["checkout", "-q", "-B", branch]);

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

        const agent = await loadAgent(join(deps.genesisDir, "crew"), "builder");
        if (agent.status === "error")
          throw new Error(`load builder: ${agent.error.message}`);

        deps.onProgress?.("🏗️ builder starting");
        const run = await deps.runAgent({
          cwd: checkout,
          systemPrompt: agent.value.instructions,
          prompt:
            "Read ISSUE.md and implement exactly what it asks in this app, then commit your work locally with a clear message. Do not push; do not open a pull request.",
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

        // No commits ahead of the base ⇒ the agent changed nothing; a PR would
        // be empty. Fail loudly rather than open a no-op PR.
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

        // Driver push (local bare path — no network credential) + PR. Opening
        // the PR auto-creates a preview env with forked prod data.
        await git(checkout, [
          "push",
          "-q",
          "--force",
          "origin",
          `${branch}:${branch}`,
        ]);
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

// Turn the JSONL stream into occasional human-readable progress lines.
function makeHeartbeat(emit: (line: string) => void): (line: string) => void {
  let lastEmit = 0;
  return (line) => {
    try {
      const msg = JSON.parse(line) as {
        type?: string;
        message?: {
          content?: Array<{ type?: string; text?: string; name?: string }>;
        };
      };
      if (msg.type !== "assistant" || !msg.message?.content) return;
      const now = Date.now();
      if (now - lastEmit < 20_000) return; // throttle
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          emit(`… ${block.text.slice(0, 120).replace(/\s+/g, " ")}`);
          lastEmit = now;
          return;
        }
        if (block.type === "tool_use" && block.name) {
          emit(`… using ${block.name}`);
          lastEmit = now;
          return;
        }
      }
    } catch {
      /* ignore */
    }
  };
}
