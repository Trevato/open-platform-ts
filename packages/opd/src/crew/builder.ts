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

// Platform-config allowlist (authored by the crew, plat/opd#1): the caged agent
// editing plat/platform may only change crew role prompts/skills or platform.json.
function isAllowedPlatformConfigPath(path: string): boolean {
  if (path === "platform.json") return true;
  return path.startsWith("crew/") && path.endsWith(".md");
}

async function changedPaths(checkout: string): Promise<string[]> {
  const p = Bun.spawn(
    [
      "git",
      "-c",
      "safe.directory=*",
      "-C",
      checkout,
      "diff",
      "--name-only",
      "origin/main..HEAD",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(p.stdout).text()).trim();
  return out ? out.split("\n") : [];
}

async function aheadOfMain(checkout: string): Promise<number> {
  const p = Bun.spawn(
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
  return Number((await new Response(p.stdout).text()).trim() || "0");
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
  loadAgent: LoadAgent; // the role prompt, from git (plat/platform)
  /** Agent role: "builder" for apps, "platform-dev" for the platform's own
   *  source/config repos. Defaults to "builder". */
  role?: string;
  oauthToken: string;
  /** Claude model for the agent run (platform config crew.model). */
  model?: string;
  log: Log;
  onProgress?: (line: string) => void;
}

// The mis-scope escape hatch, stated in the DRIVER prompt (not the role
// instructions) so detection and contract version together: an agent that
// can't correctly do the work in THIS repo declines instead of guessing, and
// the dispatcher parks the item with the explanation instead of a cryptic
// "produced no changes".
const DECLINE_CONTRACT =
  "If this issue cannot be correctly implemented in THIS repository — it is mis-scoped, belongs in a different repo, or needs a decision only a human can make — do NOT guess and do NOT commit anything. Instead end your final message with a line starting exactly `DECLINED: ` followed by a short explanation of why and where the work belongs.";

/** The agent's decline note, if its final message invoked the contract. */
function declineNote(finalText: string): string | undefined {
  const m = finalText.match(/^DECLINED:[ \t]*([\s\S]+)/m);
  return m ? m[1]!.trim() : undefined;
}

/**
 * Build the change described by a work item: clone → feature branch → the
 * agent edits + commits → the driver pushes + attaches the change (which
 * auto-creates a preview env with forked data and hands the item to review).
 *
 * In rework mode (opts.rework), it checks out the EXISTING change branch and
 * hands the agent the reviewer's blockers to fix — a new commit on the same
 * branch re-triggers the preview + review. One change per item, ever.
 *
 * A `declined` result means the agent invoked the decline contract instead of
 * committing: the note explains why, for the human who re-scopes the item.
 */
export async function runBuilder(
  deps: BuilderDeps,
  issue: IssueRow,
  opts: {
    rework?: { verdict: string; attempt: number };
  } = {},
): Promise<Result<{ costUsd: number; declined?: string }, BuilderError>> {
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

        const role = deps.role ?? "builder";
        const agent = await deps.loadAgent(role);
        if (agent.status === "error")
          throw new Error(`load ${role}: ${agent.error.message}`);

        // Capture the branch head so rework can detect a no-op fix.
        const headBefore = await revParse(checkout);

        deps.onProgress?.(
          rework
            ? `🔧 reworking (attempt ${rework.attempt})`
            : "🏗️ builder starting",
        );
        const run = await deps.runAgent({
          cwd: checkout,
          // Skills ride along from plat/platform (crew/<role>/skills/*.md) —
          // the hot-reloadable seam for teaching conventions without a deploy.
          systemPrompt: [agent.value.instructions, ...agent.value.skills].join(
            "\n\n---\n\n",
          ),
          prompt: rework
            ? `Read ISSUE.md for the original spec. The adversarial reviewer FAILED your pull request with these blockers:\n\n${rework.verdict}\n\nFix EXACTLY these blockers, keeping everything else working. Read the current code first, make the smallest correct fix, then commit locally with a clear message. Do not push; do not open a pull request.\n\n${DECLINE_CONTRACT}`
            : `Read ISSUE.md and implement exactly what it asks in this repository, then commit your work locally with a clear message. Do not push; do not open a pull request.\n\n${DECLINE_CONTRACT}`,
          oauthToken: deps.oauthToken,
          ...(deps.model ? { model: deps.model } : {}),
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

        // Guardrail (authored by the crew, issue plat/opd#1): when building the
        // platform CONFIG repo itself, the caged agent may only touch crew
        // prompts/skills and platform.json — never arbitrary files.
        if (issue.owner === "plat" && issue.repo === "platform") {
          for (const path of await changedPaths(checkout)) {
            if (!isAllowedPlatformConfigPath(path))
              throw new Error(
                `edit outside the allowlist: ${path} (platform config allows only crew/**/*.md and platform.json)`,
              );
          }
        }

        // The agent changed nothing ⇒ either an explicit decline (surface the
        // agent's own explanation) or a loud failure — never an empty change.
        // Fresh build: no commits ahead of main. Rework: the head didn't move.
        const noChanges = rework
          ? (await revParse(checkout)) === headBefore
          : (await aheadOfMain(checkout)) === 0;
        if (noChanges) {
          const declined = declineNote(run.value.result);
          if (declined) return { costUsd: run.value.costUsd, declined };
          const said = run.value.result.trim().slice(0, 200);
          throw new Error(
            rework
              ? "rework produced no changes (reviewer would fail again)"
              : `agent produced no changes${said ? ` — its final message: ${said}` : ""}`,
          );
        }

        // Driver push (local bare path — no network credential). A fresh build
        // attaches the change (auto-creating a preview with forked data); a
        // rework just updates the branch, which re-triggers preview + review.
        await git(checkout, [
          "push",
          "-q",
          "--force",
          "origin",
          `${branch}:${branch}`,
        ]);
        if (rework) return { costUsd: run.value.costUsd };
        const attached = await deps.forge.attachChange(
          deps.systemActor,
          issue.owner,
          issue.repo,
          issue.number,
          { head: branch },
        );
        if (attached.status === "error")
          throw new Error(`attach change: ${attached.error.message}`);
        return { costUsd: run.value.costUsd };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    catch: fail("runBuilder"),
  });
}
