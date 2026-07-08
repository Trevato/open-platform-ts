import { homedir } from "node:os";
import { join } from "node:path";
import { Result, TaggedError, type Log } from "@op/core";

// The "curating not building" composer: a fast model turns a rough one-line
// idea into a well-formed issue the human edits — a draft of the real object,
// not a chat reply. Runs through the `claude` CLI (the OAuth token only works
// there, never the raw Messages API) with a cheap model and NO tools — a pure
// text→JSON transform, so no sandbox is needed. Degrades to a plain issue.

export class ComposerError extends TaggedError("ComposerError")<{
  message: string;
}>() {}

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
  acceptanceChecks: string[];
}

// Read at call time (not module load) so tests can override the binary.
const claudeBin = () => process.env["OP_CLAUDE_BIN"] ?? "claude";
const MODEL = process.env["OP_COMPOSER_MODEL"] ?? "claude-haiku-4-5";

const SYSTEM = `You are the platform's issue composer. Turn a rough one-line idea into a crisp issue for a caged AI builder that implements it end to end in a single-file Bun + bun:sqlite app served over OIDC.

Emit an imperative title (<=60 chars); a 2-4 sentence body describing what to build; labels (always include "agent-work"); and 3-6 acceptance checks an adversary reviewer can verify over HTTP. ALWAYS fold the safety contract into the body: parameterized SQL only, escape user-controlled text, auth-gate every data path, keep the OIDC login and JSON-for-machines/HTML-for-browsers contract working, and idempotent migrations (preview runs on cloned prod data).

Respond with ONLY a JSON object: {"title": string, "body": string, "labels": string[], "acceptanceChecks": string[]}. No prose, no markdown fences.`;

// Parse the model's text into the strict shape, tolerating markdown fences and
// stray prose by extracting the outermost JSON object.
function parseDraft(text: string, idea: string): IssueDraft {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  const obj =
    s >= 0 && e > s
      ? (JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>)
      : {};
  const labels = Array.isArray(obj["labels"])
    ? (obj["labels"] as unknown[]).map(String)
    : [];
  if (!labels.includes("agent-work")) labels.unshift("agent-work");
  return {
    title: String(obj["title"] ?? idea).slice(0, 80),
    body: String(obj["body"] ?? idea),
    labels: [...new Set(labels)].slice(0, 6),
    acceptanceChecks: Array.isArray(obj["acceptanceChecks"])
      ? (obj["acceptanceChecks"] as unknown[]).map(String).slice(0, 8)
      : [],
  };
}

export async function draftIssue(opts: {
  idea: string;
  context?: string; // the app's server.ts, so drafts match its real routes
  oauthToken: string;
  log: Log;
  deadlineMs?: number;
}): Promise<Result<IssueDraft, ComposerError>> {
  const idea = opts.idea.trim().slice(0, 500);
  if (!idea) return Result.err(new ComposerError({ message: "empty idea" }));

  const prompt =
    (opts.context
      ? `The app's current server.ts (match its routes/helpers):\n\`\`\`\n${opts.context.slice(0, 6000)}\n\`\`\`\n\n`
      : "") + `Rough idea: "${idea}"\n\nReturn ONLY the JSON object.`;

  const proc = Bun.spawn(
    [
      claudeBin(),
      "-p",
      prompt,
      "--append-system-prompt",
      SYSTEM,
      "--model",
      MODEL,
      "--output-format",
      "json",
      "--disallowedTools",
      "Bash Read Write Edit Glob Grep WebFetch Task",
      "--setting-sources",
      "",
    ],
    {
      // Hermetic env — never the full process.env (agents can read their env).
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "/tmp",
        LANG: process.env["LANG"] ?? "C.UTF-8",
        CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken,
        // Isolate config from the operator's ~/.claude (avoids lock contention).
        CLAUDE_CONFIG_DIR: join(homedir(), ".op-composer-cfg"),
      },
      // Close stdin: with an open stdin pipe, `claude -p` waits for input and
      // never exits — the composer would hang until the deadline. This is THE
      // reliability fix.
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Haiku-via-CLI latency is variable (~5-25s). A generous deadline lets slow
  // calls finish behind the skeleton; the console degrades gracefully past it.
  const timer = setTimeout(() => proc.kill(), opts.deadlineMs ?? 35_000);
  try {
    // Drain stdout/stderr CONCURRENTLY with waiting for exit — reading only
    // after exit can deadlock if the child fills the pipe buffer.
    const stdoutP = new Response(proc.stdout).text();
    const stderrP = new Response(proc.stderr).text();
    const code = await proc.exited;
    const [out, err] = await Promise.all([stdoutP, stderrP]);
    if (code !== 0)
      return Result.err(
        new ComposerError({
          message: `composer exited ${code}: ${err.slice(0, 200)}`,
        }),
      );
    const wrap = JSON.parse(out) as { result?: string; is_error?: boolean };
    if (wrap.is_error || !wrap.result)
      return Result.err(
        new ComposerError({ message: "composer returned no result" }),
      );
    return Result.ok(parseDraft(wrap.result, idea));
  } catch (cause) {
    return Result.err(new ComposerError({ message: String(cause) }));
  } finally {
    clearTimeout(timer);
  }
}
