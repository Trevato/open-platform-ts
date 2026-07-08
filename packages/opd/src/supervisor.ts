import { join } from "node:path";
import type { Log } from "@op/core";

// Self-upgrade: the platform ships its OWN code changes. The daemon runs from a
// MANAGED source clone of plat/opd (never the operator's working tree); a merge
// to plat/opd makes the running daemon exit UPGRADE_EXIT; this supervisor pulls
// the new source and re-execs. If the new daemon fails to stay up, it rolls the
// source back to the last-good ref and re-execs that — a bad commit degrades to
// the previous binary, never to a dead platform. Apps are containers with
// --restart=always, so they outlive the re-exec.

/** The daemon exits with this code to ask the supervisor to re-exec from the
 *  updated source. Distinct from 0 (clean stop) and crash codes. */
export const UPGRADE_EXIT = 75;

/** How long a freshly-upgraded daemon must stay up to be considered healthy.
 *  A non-zero exit inside this window triggers a rollback. */
export const HEALTH_GRACE_MS = 20_000;

export type SuperAction = "upgrade" | "rollback" | "stop" | "restart";

/** Pure decision core (unit-tested): given how the child exited, what next? */
export function nextAction(
  exitCode: number | null,
  uptimeMs: number,
  pendingRollback: boolean,
  graceMs = HEALTH_GRACE_MS,
): SuperAction {
  if (exitCode === UPGRADE_EXIT) return "upgrade";
  if (exitCode === 0) return "stop";
  // Non-zero / signal: if we JUST upgraded and it died fast, revert; else the
  // daemon crashed on its own — restart it (crash-only supervision).
  if (pendingRollback && uptimeMs < graceMs) return "rollback";
  return "restart";
}

export interface SupervisorDeps {
  /** Managed source dir (a git clone of plat/opd) the daemon runs from. */
  src: string;
  domain: string;
  log: Log;
  /** Spawn the daemon; resolves with its exit code. Injectable for tests. */
  spawnDaemon: (src: string, domain: string) => Promise<number | null>;
  /** git HEAD sha of the managed source. */
  headRef: (src: string) => Promise<string>;
  /** Fast-forward the managed source to its origin's latest main. */
  pullLatest: (src: string) => Promise<void>;
  /** Hard-reset the managed source to a specific ref (rollback). */
  resetTo: (src: string, ref: string) => Promise<void>;
  /** Wall clock (injectable for tests). */
  now?: () => number;
  /** Backoff between crash restarts. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run the supervision loop. Returns the exit code to propagate when the daemon
 * stops cleanly. Never returns on upgrade/rollback/crash — it re-execs.
 */
export async function supervise(deps: SupervisorDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let rollbackRef: string | null = null;

  for (;;) {
    const startedAt = now();
    const code = await deps.spawnDaemon(deps.src, deps.domain);
    const uptimeMs = now() - startedAt;
    const action = nextAction(code, uptimeMs, rollbackRef !== null);

    if (action === "stop") return 0;

    if (action === "upgrade") {
      rollbackRef = await deps.headRef(deps.src); // last-good, for rollback
      try {
        await deps.pullLatest(deps.src);
        deps.log.info("self-upgrade: pulled new source, re-execing", {
          from: rollbackRef.slice(0, 8),
        });
      } catch (e) {
        deps.log.error("self-upgrade: pull failed, staying on current source", {
          err: String(e),
        });
        rollbackRef = null;
      }
      continue;
    }

    if (action === "rollback" && rollbackRef) {
      deps.log.error("self-upgrade: new daemon died fast — rolling back", {
        to: rollbackRef.slice(0, 8),
        uptimeMs,
      });
      try {
        await deps.resetTo(deps.src, rollbackRef);
      } catch (e) {
        deps.log.error("self-upgrade: rollback reset failed", {
          err: String(e),
        });
      }
      rollbackRef = null;
      continue;
    }

    // restart (crash-only supervision) — small backoff so a boot-loop doesn't spin.
    rollbackRef = null;
    deps.log.warn("daemon exited, restarting", { code, uptimeMs });
    await sleep(1_000);
  }
}

/** Default git/spawn wiring for the real supervisor (Bun subprocesses). */
export function bunSupervisorIo(): Pick<
  SupervisorDeps,
  "spawnDaemon" | "headRef" | "pullLatest" | "resetTo"
> {
  const git = async (src: string, args: string[]): Promise<string> => {
    const p = Bun.spawn(["git", "-C", src, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if ((await p.exited) !== 0)
      throw new Error(`git ${args[0]}: ${await new Response(p.stderr).text()}`);
    return (await new Response(p.stdout).text()).trim();
  };
  return {
    spawnDaemon: async (src, domain) => {
      const child = Bun.spawn(
        ["bun", join(src, "packages/opd/src/cli.ts"), "serve"],
        {
          stdout: "inherit",
          stderr: "inherit",
          stdin: "inherit",
          env: { ...process.env, DOMAIN: domain, OP_SUPERVISED: "1" },
        },
      );
      return child.exited;
    },
    headRef: (src) => git(src, ["rev-parse", "HEAD"]),
    pullLatest: async (src) => {
      await git(src, ["fetch", "origin", "main"]);
      await git(src, ["reset", "--hard", "origin/main"]);
    },
    resetTo: async (src, ref) => {
      await git(src, ["reset", "--hard", ref]);
    },
  };
}
