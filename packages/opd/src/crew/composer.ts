import { homedir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Result, TaggedError, type Log } from "@op/core";
import type { LoadAgent } from "../platform-config.ts";

// The "curating not building" composer: a fast model turns a rough one-line
// idea into a well-formed issue the human edits — a draft of the real object,
// not a chat reply. Runs in-process through the Claude Agent SDK (the OAuth
// token only works via the SDK/CLI, never the raw Messages API) with a fast
// model, NO tools, thinking disabled, and grammar-constrained JSON output. It
// never throws and never fabricates a bad issue — a failure degrades to the
// editable draft form in the console.

export class ComposerError extends TaggedError("ComposerError")<{
  message: string;
}>() {}

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
  acceptanceChecks: string[];
}

/** What kind of repo the issue targets — each kind carries a different build
 *  contract, so the composer must draft against the right one. Derived by the
 *  API from the repo row (self-repo → config/source, is_template → template);
 *  "app" is the default. */
export type ComposerTargetKind =
  | "app"
  | "platform-config"
  | "platform-source"
  | "template";

// Per-target contract, appended AFTER the (hot-reloadable) composer
// instructions. Compiled-in on purpose: it must stay in step with the
// dispatcher's routing and the builder's decline contract — code, not prompt
// config. Worded as an override so it also corrects an older git-hosted
// composer prompt that only knows the app contract.
const TARGET_CONTRACTS: Record<ComposerTargetKind, string> = {
  app: `TARGET — this issue is filed on a deployed app: a single-file Bun + bun:sqlite app served over OIDC (server.ts + Dockerfile). The caged builder implements it end to end; an adversarial reviewer verifies the acceptance checks over HTTP against a live preview, then it auto-merges and ships.`,
  "platform-config": `TARGET OVERRIDE — this issue is filed on plat/platform, the PLATFORM'S OWN CONFIG repo, not an app. Ignore any single-file-app contract above. Only these files exist and may change: crew role prompts (crew/<role>/instructions.md, crew/<role>/skills/*.md) and platform.json tunables (crew.model, crew.maxRework, crew.sweepMs, apps.* caps). Draft the issue strictly in those terms. If the idea needs daemon code (new features, UI, endpoints, new SDKs), say in the body that it belongs on plat/opd instead and keep this issue to any config part that remains. Acceptance checks are diff-review criteria for a human merger — there is no live preview.`,
  "platform-source": `TARGET OVERRIDE — this issue is filed on plat/opd, the PLATFORM DAEMON'S OWN SOURCE (a Bun + TypeScript monorepo under packages/*, strict types, Result-based errors, server-rendered console). Ignore any single-file-app contract above. Describe the change against the daemon's real architecture and name the packages/files likely to change. The change is proposed on a branch and PARKS FOR HUMAN REVIEW — no preview, no auto-merge — so acceptance checks are code-review criteria a human merger can verify by reading the diff (plus how to exercise it after a restart).`,
  template: `TARGET OVERRIDE — this issue is filed on plat/app-template, the template EVERY FUTURE APP starts from. The app contract above applies to the template's own files (server.ts, ui.ts, Dockerfile, README). Note in the body that merging changes only apps created afterwards — existing apps are untouched — and that the change parks for human review instead of shipping through a preview.`,
};

// How the optional context snippet is framed, per target.
const CONTEXT_LABELS: Record<ComposerTargetKind, string> = {
  app: "The app's current server.ts (match its routes/helpers):",
  "platform-config": "The repo's current platform.json and crew roles:",
  "platform-source": "The daemon repo's file layout (name real paths from it):",
  template: "The template's current server.ts (match its routes/helpers):",
};

// Live progress the console renders so the UI reflects the model's real state
// (thinking → drafting) instead of freezing on a skeleton.
export interface ComposerEvent {
  phase: "thinking" | "drafting";
  text?: string; // streamed reasoning, on `thinking`
}

const MODEL = process.env["OP_COMPOSER_MODEL"] ?? "claude-haiku-4-5";

// Compiled-in FALLBACK only: the live prompt is crew/composer/instructions.md
// in plat/platform (loaded per call via loadAgent, hot-editable like every
// crew role). This copy serves when that read fails — fail-open to last-good,
// the PlatformConfig convention. Genesis seeds the git copy from
// genesis/platform/crew/composer/instructions.md; keep the two in step.
const SYSTEM = `You are the platform's issue composer. Turn a rough one-line idea into a crisp issue for a caged AI builder. The build contract for the TARGET repo (an app, the platform's own config or source, or the app template) is appended below these instructions — draft against THAT contract.

Emit an imperative title (<=60 chars); a 2-4 sentence body describing what to build; labels (always include "agent-work"); and 3-6 acceptance checks a reviewer can verify — over HTTP against a live preview for apps, by reading the diff for the platform's own repos.

For app targets, ALWAYS fold the safety contract into the body: parameterized SQL only, escape user-controlled text, auth-gate every data path, keep the OIDC login and JSON-for-machines/HTML-for-browsers contract working, and idempotent migrations (preview runs on cloned prod data).`;

async function systemFrom(
  load: LoadAgent | undefined,
  target: ComposerTargetKind,
): Promise<string> {
  let base = SYSTEM;
  if (load) {
    const agent = await load("composer");
    if (agent.status === "ok")
      base = [agent.value.instructions, ...agent.value.skills].join(
        "\n\n---\n\n",
      );
  }
  const contract = TARGET_CONTRACTS[target];
  return contract ? `${base}\n\n---\n\n${contract}` : base;
}

// Grammar-constrained output — the SDK forces a synthetic tool matching this
// schema, so the result's `structured_output` is already a conformant object.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body", "labels", "acceptanceChecks"],
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    acceptanceChecks: { type: "array", items: { type: "string" } },
  },
} as const;

// The seam: tests inject a fake query() that yields scripted SDK messages.
export type RunQuery = typeof query;

// Clamp the model output to the schema AND the business rules — schema
// guarantees shape, this guarantees policy. Never throws; garbage degrades to a
// usable draft keyed on the raw idea.
function clamp(raw: unknown, idea: string): IssueDraft {
  try {
    const obj =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : typeof raw === "string"
          ? extractObject(raw)
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
  } catch {
    return {
      title: idea,
      body: idea,
      labels: ["agent-work"],
      acceptanceChecks: [],
    };
  }
}

// Fallback for a text (non-structured) result: extract the outermost JSON.
function extractObject(text: string): Record<string, unknown> {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  return s >= 0 && e > s
    ? (JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>)
    : {};
}

function userPrompt(
  idea: string,
  context: string | undefined,
  target: ComposerTargetKind,
): string {
  return (
    (context
      ? `${CONTEXT_LABELS[target]}\n\`\`\`\n${context.slice(0, 6000)}\n\`\`\`\n\n`
      : "") +
    `Rough idea: "${idea}"\n\nCompose the issue as the structured object.`
  );
}

export async function draftIssue(opts: {
  idea: string;
  context?: string; // the app's server.ts, so drafts match its real routes
  /** Which build contract the target repo carries; defaults to "app". */
  target?: ComposerTargetKind;
  oauthToken: string;
  log: Log;
  /** Git-hot-reloadable prompt (crew/composer/); absent or unreadable → the
   *  compiled-in SYSTEM. */
  loadAgent?: LoadAgent;
  deadlineMs?: number;
  runQuery?: RunQuery; // test seam
  fetchImpl?: typeof fetch; // test seam for the raw-API fast path
  /** Live progress for a responsive UI: the model's phase + streamed reasoning. */
  onEvent?: (ev: ComposerEvent) => void;
}): Promise<Result<IssueDraft, ComposerError>> {
  const idea = opts.idea.trim().slice(0, 500);
  if (!idea) return Result.err(new ComposerError({ message: "empty idea" }));
  const target = opts.target ?? "app";
  const system = await systemFrom(opts.loadAgent, target);

  // Fast lane: a REAL api key (not the oat token) skips the whole SDK subprocess
  // + cached-prompt tax — the raw Messages API with grammar-constrained output
  // returns in ~1-3s. The oat token can't use this (the API rejects it).
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey && apiKey.startsWith("sk-ant-api"))
    return draftViaApi(
      idea,
      system,
      apiKey,
      opts.context,
      target,
      opts.deadlineMs ?? 30_000,
      opts.fetchImpl ?? fetch,
    );

  const run = opts.runQuery ?? query;
  const prompt = userPrompt(idea, opts.context, target);
  const emit = opts.onEvent;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.deadlineMs ?? 30_000);
  try {
    const q = run({
      prompt,
      options: {
        model: MODEL,
        systemPrompt: system,
        allowedTools: [],
        maxTurns: 4, // the structured-output tool call + finalize
        permissionMode: "bypassPermissions",
        settingSources: [], // skip ~/.claude — a real latency tax
        thinking: { type: "adaptive" }, // think for correctness; the UI shows it
        includePartialMessages: !!emit, // stream reasoning to the console
        outputFormat: { type: "json_schema", schema: SCHEMA },
        strictMcpConfig: true,
        abortController: abort,
        // The oat token authenticates via the SDK's subprocess; blank the API
        // key so it resolves OAuth, isolate config from the operator's ~/.claude.
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? "/tmp",
          LANG: process.env["LANG"] ?? "C.UTF-8",
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken,
          CLAUDE_CONFIG_DIR: join(homedir(), ".op-composer-cfg"),
        },
      },
    } as Parameters<typeof query>[0]);

    let structured: unknown = null;
    let resultText = "";
    let errored = false;
    let phase = "";
    for await (const m of q) {
      if (emit && m.type === "stream_event") {
        // thinking_delta = the model reasoning; input_json_delta = drafting the
        // structured output. Surface both as phases (+ live reasoning text).
        const d = (
          m as { event?: { delta?: { type?: string; thinking?: string } } }
        ).event?.delta;
        if (d?.type === "thinking_delta") {
          if (phase !== "thinking") emit({ phase: (phase = "thinking") });
          if (d.thinking) emit({ phase: "thinking", text: d.thinking });
        } else if (d?.type === "input_json_delta" && phase !== "drafting") {
          emit({ phase: (phase = "drafting") });
        }
      }
      if (m.type === "result") {
        errored = m.subtype !== "success";
        structured =
          (m as { structured_output?: unknown }).structured_output ?? null;
        resultText =
          "result" in m ? String((m as { result?: unknown }).result ?? "") : "";
      }
    }
    if (errored && structured == null && !resultText)
      return Result.err(
        new ComposerError({ message: "composer returned no result" }),
      );
    return Result.ok(clamp(structured ?? resultText, idea));
  } catch (cause) {
    return Result.err(new ComposerError({ message: String(cause) }));
  } finally {
    clearTimeout(timer);
  }
}

// The raw Messages API fast lane — used only when a real ANTHROPIC_API_KEY is
// configured (the oat token is rejected here). Grammar-constrained output
// (output_config.format) returns valid JSON in ~1-3s with no subprocess.
async function draftViaApi(
  idea: string,
  system: string,
  apiKey: string,
  context: string | undefined,
  target: ComposerTargetKind,
  deadlineMs: number,
  fetchImpl: typeof fetch,
): Promise<Result<IssueDraft, ComposerError>> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadlineMs);
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: [
          { role: "user", content: userPrompt(idea, context, target) },
        ],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    });
    if (!res.ok)
      return Result.err(
        new ComposerError({ message: `messages api ${res.status}` }),
      );
    const body = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = body.content?.[0]?.text ?? "";
    return Result.ok(clamp(text, idea));
  } catch (cause) {
    return Result.err(new ComposerError({ message: String(cause) }));
  } finally {
    clearTimeout(timer);
  }
}
