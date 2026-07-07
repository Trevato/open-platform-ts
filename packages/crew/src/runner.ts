import { rm } from "node:fs/promises";
import { Result, TaggedError, type Log } from "@op/core";

export class CrewError extends TaggedError("CrewError")<{
  message: string;
  op: string;
}>() {}

export interface AgentRun {
  /** Working directory the agent operates in (a checked-out repo). */
  cwd: string;
  /** Role instructions (from the agent-as-directory instructions.md). */
  systemPrompt: string;
  /** The task prompt. */
  prompt: string;
  /** Claude Code OAuth token (sk-ant-oat01…) — inference credential. */
  oauthToken: string;
  /** Tool allowlist, e.g. ["Read","Edit","Bash(git *)"]. */
  allowedTools: string[];
  /** Tool denylist, e.g. ["Bash(rm -rf *)","WebFetch"]. */
  disallowedTools?: string[];
  /** Kill the run if no output for this long (ms). */
  idleTimeoutMs: number;
  /** Hard cap on total wall-clock (ms). */
  hardTimeoutMs: number;
  /** Per-line stream callback (JSONL heartbeat). */
  onLine?: (line: string) => void;
  log?: Log;
}

export interface AgentResult {
  ok: boolean;
  /** The agent's final text (result message). */
  result: string;
  costUsd: number;
  numTurns: number;
}

/** A model runner: the real one spawns `claude`; tests inject a fake fn. */
export type RunAgent = (r: AgentRun) => Promise<Result<AgentResult, CrewError>>;

// The claude binary; overridable for pinning/tests.
const CLAUDE_BIN = process.env["OP_CLAUDE_BIN"] ?? "claude";

// A HERMETIC env allowlist. The agent runs with broad tool access and can read
// its own env, so we pass ONLY what the CLI needs plus its inference token —
// never `{...process.env}`, which would leak platform credentials to the model.
function agentEnv(run: AgentRun, configDir: string): Record<string, string> {
  const base = process.env;
  const env: Record<string, string> = {
    PATH: base["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
    HOME: base["HOME"] ?? "/tmp",
    LANG: base["LANG"] ?? "en_US.UTF-8",
    CLAUDE_CODE_OAUTH_TOKEN: run.oauthToken,
    // Isolate config so the agent never reads the operator's ~/.claude.
    CLAUDE_CONFIG_DIR: configDir,
  };
  if (base["SSL_CERT_FILE"]) env["SSL_CERT_FILE"] = base["SSL_CERT_FILE"];
  if (base["PLAYWRIGHT_BROWSERS_PATH"])
    env["PLAYWRIGHT_BROWSERS_PATH"] = base["PLAYWRIGHT_BROWSERS_PATH"];
  return env;
}

/**
 * Run an agent by spawning `claude -p` in print/stream mode. The OAuth token is
 * the ONLY way to spend an sk-ant-oat01 credential (the Messages API rejects
 * it) — so this CLI subprocess is the sanctioned engine. Streams stream-json;
 * the final {"type":"result"} line carries the verdict/output + cost.
 */
export const claudeRunner: RunAgent = async (run) => {
  const op = "claudeRunner";
  const configDir = `${run.cwd}/.op-claude-cfg`;
  const args = [
    "-p",
    run.prompt,
    "--append-system-prompt",
    run.systemPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    run.allowedTools.join(","),
    ...(run.disallowedTools?.length
      ? ["--disallowedTools", run.disallowedTools.join(",")]
      : []),
    // Hermetic: don't load ~/.claude or the repo's own .claude/ settings.
    "--setting-sources",
    "",
  ];

  return Result.tryPromise({
    try: async () => {
      const proc = Bun.spawn([CLAUDE_BIN, ...args], {
        cwd: run.cwd,
        env: agentEnv(run, configDir),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      let final: AgentResult | null = null;
      let killed: string | null = null;
      let lastActivity = performance.now();
      const started = performance.now();

      // Watchdogs: idle (no output) and a hard wall-clock backstop.
      const watchdog = setInterval(() => {
        const now = performance.now();
        if (now - lastActivity > run.idleTimeoutMs) {
          killed = `idle > ${Math.round(run.idleTimeoutMs / 1000)}s`;
          proc.kill();
        } else if (now - started > run.hardTimeoutMs) {
          killed = `hard timeout > ${Math.round(run.hardTimeoutMs / 1000)}s`;
          proc.kill();
        }
      }, 5_000);

      try {
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          lastActivity = performance.now();
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            run.onLine?.(line);
            try {
              const msg = JSON.parse(line) as {
                type?: string;
                subtype?: string;
                is_error?: boolean;
                result?: string;
                num_turns?: number;
                total_cost_usd?: number;
              };
              if (msg.type === "result") {
                final = {
                  ok: msg.is_error !== true && msg.subtype === "success",
                  result: msg.result ?? "",
                  costUsd: msg.total_cost_usd ?? 0,
                  numTurns: msg.num_turns ?? 0,
                };
              }
            } catch {
              /* non-JSON line (verbose noise) — ignore */
            }
          }
        }
        await proc.exited;
      } finally {
        clearInterval(watchdog);
        await rm(configDir, { recursive: true, force: true }).catch(() => {});
      }

      if (killed) throw new Error(`agent killed: ${killed}`);
      if (!final)
        throw new Error(`agent produced no result (exit ${proc.exitCode})`);
      return final;
    },
    catch: (cause) => new CrewError({ message: String(cause), op }),
  });
};
