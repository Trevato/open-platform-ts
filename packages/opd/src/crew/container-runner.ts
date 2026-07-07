import { join } from "node:path";
import { Result, type Log } from "@op/core";
import type { AgentRun, AgentResult, CrewError, RunAgent } from "@op/crew";
import { CrewError as CrewErr } from "@op/crew";
import type { Engine } from "@op/engine";

export const AGENT_IMAGE = "op/agent:latest";
export const AGENT_NETWORK = "op-agents";

/**
 * Build the agent sandbox image if absent (from genesis/agent/Dockerfile) and
 * ensure the isolated agent network exists. Called before the first crew run;
 * the build is cached after the first ~1–2 min.
 */
export async function ensureAgentSandbox(
  engine: Engine,
  genesisDir: string,
  log: Log,
): Promise<Result<void, CrewError>> {
  const has = await engine.imageExists(AGENT_IMAGE);
  if (has.status === "error")
    return Result.err(
      new CrewErr({ message: has.error.message, op: "ensureAgentSandbox" }),
    );
  const net = await engine.ensureNetwork(AGENT_NETWORK);
  if (net.status === "error")
    return Result.err(
      new CrewErr({ message: net.error.message, op: "ensureAgentSandbox" }),
    );
  if (has.value) return Result.ok(undefined);

  log.info("crew: building agent sandbox image (first run, ~1-2 min)…");
  const built = await engine.buildImage({
    contextDir: join(genesisDir, "agent"),
    tag: AGENT_IMAGE,
    onLine: (l) => log.debug("agent-image", { l }),
  });
  if (built.status === "error")
    return Result.err(
      new CrewErr({
        message: `build agent image: ${built.error.message}`,
        op: "ensureAgentSandbox",
      }),
    );
  log.info("crew: agent sandbox image ready", { image: AGENT_IMAGE });
  return Result.ok(undefined);
}

// Parse the final stream-json {"type":"result"} line for the outcome + cost.
function parseResult(lines: string[]): AgentResult | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const msg = JSON.parse(lines[i]!) as {
        type?: string;
        subtype?: string;
        is_error?: boolean;
        result?: string;
        num_turns?: number;
        total_cost_usd?: number;
      };
      if (msg.type === "result") {
        return {
          ok: msg.is_error !== true && msg.subtype === "success",
          result: msg.result ?? "",
          costUsd: msg.total_cost_usd ?? 0,
          numTurns: msg.num_turns ?? 0,
        };
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * A RunAgent that runs claude WILD inside the caged sandbox container. The cwd
 * (a checkout the driver prepared, 0777 so the non-root agent can write) is
 * bind-mounted at /work; claude runs --dangerously-skip-permissions there. The
 * container is the boundary — no allowlist needed, and the agent holds no
 * platform credential, only its inference token. Its file edits land on the
 * host bind mount; the driver reads + pushes them afterward.
 */
export function makeContainerRunner(
  engine: Engine,
  genesisDir: string,
  log: Log,
): RunAgent {
  return async (run: AgentRun): Promise<Result<AgentResult, CrewError>> => {
    // Build the sandbox image on first use (cached after ~1-2 min).
    const ready = await ensureAgentSandbox(engine, genesisDir, log);
    if (ready.status === "error") return ready as Result<never, CrewError>;

    const lines: string[] = [];
    const task = await engine.runTask({
      image: AGENT_IMAGE,
      user: "1000:1000",
      network: AGENT_NETWORK,
      workdir: "/work",
      binds: [`${run.cwd}:/work`],
      env: {
        HOME: "/tmp",
        CLAUDE_CONFIG_DIR: "/tmp/.claude",
        CLAUDE_CODE_OAUTH_TOKEN: run.oauthToken,
        // The agent commits inside the box; give its commits an identity.
        GIT_AUTHOR_NAME: "crew",
        GIT_AUTHOR_EMAIL: "crew@platform",
        GIT_COMMITTER_NAME: "crew",
        GIT_COMMITTER_EMAIL: "crew@platform",
      },
      tmpfs: { "/tmp": "rw,size=1g" },
      memoryBytes: 4 * 1024 * 1024 * 1024,
      pidsLimit: 1024,
      labels: { "op.agentrun": "1" },
      hardTimeoutMs: run.hardTimeoutMs,
      onLine: (line) => {
        lines.push(line);
        run.onLine?.(line);
      },
      cmd: [
        "claude",
        "-p",
        run.prompt,
        "--append-system-prompt",
        run.systemPrompt,
        "--dangerously-skip-permissions", // safe: the container is the cage
        "--output-format",
        "stream-json",
        "--verbose",
        "--setting-sources",
        "", // hermetic: ignore any .claude/ in the repo
      ],
    });
    if (task.status === "error")
      return Result.err(
        new CrewErr({ message: task.error.message, op: "containerRunner" }),
      );

    const result = parseResult(lines);
    if (!result)
      return Result.err(
        new CrewErr({
          message: `agent produced no result (exit ${task.value.exitCode})`,
          op: "containerRunner",
        }),
      );
    void log;
    return Result.ok(result);
  };
}
