import { homedir } from "node:os";
import { join } from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import {
  buildLogPath,
  Result,
  TaggedError,
  type Log,
  type StateDir,
} from "@op/core";
import type { Engine } from "@op/engine";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import type { Store, UserRow, WorkPhase } from "@op/store";
import { z } from "zod";
import type { DocsSource } from "../console/docs.ts";
import { readAppSpecs } from "../gitops.ts";
import { computeIntegrationMap } from "../integration.ts";
import type { AppPolicy } from "../manifest.ts";
import type { LoadAgent } from "../platform-config.ts";
import { hostFor } from "../policy.ts";

// The guide: the in-console agent that has read the manual and can see the
// asking user's platform. It runs in-process through the Agent SDK (the OAuth
// token only works via the SDK/CLI) with a set of READ-ONLY tools closed over
// the authenticated user — every tool authorizes through the forge exactly as
// the API routes do, so the guide can never show a user something the API
// would refuse them. It explains and diagnoses; the crew builds.
//
// Instructions are hot-editable at crew/guide/instructions.md in
// plat/platform (loadAgent), like every crew role. The compiled-in SYSTEM
// below is the fail-open fallback.

export class GuideError extends TaggedError("GuideError")<{
  message: string;
}>() {}

/** One streamed event, mirrored onto the SSE wire by the API route. */
export type GuideEvent =
  | { type: "thinking" }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "sources"; sources: GuideSource[] }
  | { type: "done"; costUsd: number | null };

export interface GuideSource {
  kind: "doc" | "code";
  /** doc slug, or repo-relative source path. */
  ref: string;
  title: string;
}

export interface GuideMessage {
  role: "user" | "assistant";
  content: string;
}

const MODEL_ENV = "OP_GUIDE_MODEL";
const MAX_TURNS = 16;
const MAX_SOURCE_LINES = 250;

// Fail-open fallback for crew/guide/instructions.md (the PlatformConfig
// convention — genesis seeds the git copy; keep the two in step).
const SYSTEM = `You are the platform guide — the built-in assistant of this Open Platform instance. You have the manual (docs_search/docs_read), the platform's own source code (source_read), and read-only sight of the asking user's live platform (platform_overview, app_inspect, app_logs, work_list, work_read, integration_map).

Ground every answer: search or read the docs first; check live state when the question is about THEIR apps; read the source when they ask how something is implemented. Reference docs pages inline as absolute links like /docs/quickstart, and code as repo paths like packages/opd/src/api.ts:159. Never invent a page, route, flag, or behavior — if the docs and code don't show it, say so plainly and suggest filing an issue from the app's Work tab.

Be concise. Lead with the answer, then the reasoning if it helps. Use short paragraphs and inline code for anything typeable. You are read-only: you cannot change apps, files, or settings — when a change is wanted, point to the exact console action or command that does it.`;

export interface GuideDeps {
  sd: StateDir;
  store: Store;
  forge: Forge;
  git: GitHost;
  engine: Engine;
  docs: DocsSource;
  domain: string;
  /** Repo root of the RUNNING source — what source_read serves. */
  srcDir: string;
  appPolicy: () => AppPolicy;
  loadAgent: LoadAgent;
  oauthToken: string;
  model: () => string;
  log: Log;
}

export type RunQuery = typeof query;

async function systemFrom(deps: GuideDeps): Promise<string> {
  const agent = await deps.loadAgent("guide");
  if (agent.status === "error") return SYSTEM;
  return [agent.value.instructions, ...agent.value.skills].join("\n\n---\n\n");
}

/** The read-only tool belt, closed over the asking user. Every repo-scoped
 *  tool checks forge read authorization — the guide sees exactly what the
 *  user's own API calls would see. */
function makeTools(deps: GuideDeps, user: UserRow, sources: GuideSource[]) {
  const text = (s: string) => ({
    content: [{ type: "text" as const, text: s }],
  });
  const denied = text("not authorized for that repo");
  const canRead = (owner: string, repo: string) =>
    deps.forge.authorize(user, owner, repo, "read");
  const addSource = (s: GuideSource) => {
    if (!sources.some((x) => x.kind === s.kind && x.ref === s.ref))
      sources.push(s);
  };

  const docsSearch = tool(
    "docs_search",
    "Search the platform manual. Returns matching pages with their slugs — read the promising ones with docs_read.",
    { query: z.string() },
    async ({ query: q }) => {
      const tree = await deps.docs.tree();
      const needle = q.toLowerCase();
      const hits = tree.order
        .map((p) => {
          const inTitle = p.title.toLowerCase().includes(needle) ? 3 : 0;
          const inHead = p.headings.some((h) =>
            h.text.toLowerCase().includes(needle),
          )
            ? 2
            : 0;
          const inBody = p.plain.toLowerCase().includes(needle) ? 1 : 0;
          return { p, score: inTitle + inHead + inBody };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      return text(
        hits.length
          ? hits
              .map(
                (h) =>
                  `${h.p.slug} — ${h.p.title}: ${h.p.description} [section: ${h.p.section}]`,
              )
              .join("\n")
          : "no pages match; try docs_read on 'index' for the full map",
      );
    },
  );

  const docsRead = tool(
    "docs_read",
    "Read one manual page as markdown, by slug (e.g. 'quickstart').",
    { slug: z.string() },
    async ({ slug }) => {
      const tree = await deps.docs.tree();
      const pg = tree.bySlug.get(slug);
      if (!pg) return text(`no such page '${slug}'`);
      addSource({ kind: "doc", ref: pg.slug, title: pg.title });
      return text(`# ${pg.title}\n\n${pg.raw}`);
    },
  );

  const overview = tool(
    "platform_overview",
    "The user's platform at a glance: every app with its state, plus the crew queue.",
    {},
    async () => {
      const specs = await readAppSpecs(deps.git, deps.domain);
      const apps = (specs.status === "ok" ? specs.value : [])
        .filter((s) => canRead(s.owner, s.app))
        .map((s) => {
          const st = deps.store.getAppStatus(s.owner, s.app);
          return `${s.owner}/${s.app}: ${st?.state ?? "pending"}${st?.message ? ` (${st.message})` : ""} — https://${hostFor(s, deps.domain)}`;
        });
      const phases: WorkPhase[] = [
        "queued",
        "building",
        "reviewing",
        "reworking",
        "parked",
      ];
      const work = phases.flatMap((ph) =>
        deps.store
          .listWorkByPhase(ph)
          .filter((w) => canRead(w.owner, w.repo))
          .map((w) => `${w.owner}/${w.repo}#${w.number} ${ph}: ${w.title}`),
      );
      return text(
        `domain: ${deps.domain}\n\napps:\n${apps.join("\n") || "(none)"}\n\nactive work:\n${work.join("\n") || "(none)"}`,
      );
    },
  );

  const appInspect = tool(
    "app_inspect",
    "One app in detail: status, recent deploy events, and open work items.",
    { owner: z.string(), app: z.string() },
    async ({ owner, app }) => {
      if (!canRead(owner, app)) return denied;
      const st = deps.store.getAppStatus(owner, app);
      const events = deps.store
        .listEvents(owner, app)
        .slice(0, 12)
        .map(
          (e) =>
            `${new Date(e.ts).toISOString()} ${e.phase}${e.message ? ` — ${e.message}` : ""}${e.sha ? ` [${e.sha.slice(0, 8)}]` : ""}`,
        );
      const work = deps.store
        .listIssues(owner, app, "open")
        .map((w) => `#${w.number} [${w.phase}] ${w.title}`);
      return text(
        `status: ${st ? `${st.state}${st.message ? ` — ${st.message}` : ""}` : "no status (never deployed?)"}\n\nrecent deploy events:\n${events.join("\n") || "(none)"}\n\nopen work:\n${work.join("\n") || "(none)"}`,
      );
    },
  );

  const appLogs = tool(
    "app_logs",
    "Tail an app's logs: 'build' (last image build) or 'runtime' (running container).",
    { owner: z.string(), app: z.string(), kind: z.enum(["build", "runtime"]) },
    async ({ owner, app, kind }) => {
      if (!canRead(owner, app)) return denied;
      if (kind === "build") {
        const f = Bun.file(buildLogPath(deps.sd, owner, app));
        const t = (await f.exists()) ? await f.text() : "(no build yet)";
        return text(t.split("\n").slice(-120).join("\n"));
      }
      const st = deps.store.getAppStatus(owner, app);
      if (!st?.container_id) return text("(no running container)");
      const logs = await deps.engine.logs(st.container_id, { tail: 120 });
      return text(
        logs.status === "ok"
          ? logs.value
          : `(logs unavailable: ${logs.error.message})`,
      );
    },
  );

  const workList = tool(
    "work_list",
    "List work items for a repo (open by default).",
    {
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).optional(),
    },
    async ({ owner, repo, state }) => {
      if (!canRead(owner, repo)) return denied;
      const items = deps.store.listIssues(
        owner,
        repo,
        state === "all" ? undefined : (state ?? "open"),
      );
      return text(
        items
          .map(
            (w) =>
              `#${w.number} [${w.phase}${w.parked_reason ? `:${w.parked_reason}` : ""}] ${w.title}`,
          )
          .join("\n") || "(none)",
      );
    },
  );

  const workRead = tool(
    "work_read",
    "One work item in full: intent, change, attempts, and the latest activity.",
    { owner: z.string(), repo: z.string(), number: z.number() },
    async ({ owner, repo, number }) => {
      if (!canRead(owner, repo)) return denied;
      const it = deps.store.getIssue(owner, repo, number);
      if (!it) return text("no such work item");
      const attempts = deps.store
        .listAttempts(owner, repo, number)
        .map(
          (a) =>
            `attempt ${a.attempt}: ${a.verdict ?? "in progress"}${a.verdict_line ? ` — ${a.verdict_line}` : ""}`,
        );
      const comments = deps.store
        .listComments(owner, repo, number)
        .slice(-12)
        .map((c) => `${c.author}: ${c.body.slice(0, 300)}`);
      return text(
        `#${it.number} ${it.title}\nphase: ${it.phase}${it.parked_reason ? ` (${it.parked_reason})` : ""} · state: ${it.state}\nlabels: ${it.labels || "(none)"}\n${it.head_ref ? `change: ${it.head_ref} → ${it.base_ref} (${it.change_state})\n` : ""}\n${it.body}\n\nattempts:\n${attempts.join("\n") || "(none)"}\n\nlatest activity:\n${comments.join("\n") || "(none)"}`,
      );
    },
  );

  const integrations = tool(
    "integration_map",
    "The derived app graph: what each app provides/consumes and every peer edge.",
    {},
    async () => {
      const map = await computeIntegrationMap({
        git: deps.git,
        store: deps.store,
        domain: deps.domain,
        policy: deps.appPolicy(),
      });
      const apps = map.apps.map(
        (a) =>
          `${a.owner}/${a.app} [${a.state ?? "pending"}] provides: ${a.provides.map((p) => p.name).join(", ") || "—"}${a.tcp.length ? ` tcp: ${a.tcp.map((t) => `${t.publicPort}→${t.containerPort}`).join(", ")}` : ""}${a.manifestError ? ` MANIFEST ERROR: ${a.manifestError}` : ""}`,
      );
      const edges = map.edges.map(
        (e) =>
          `${e.from.owner}/${e.from.app} consumes ${e.to.owner}/${e.to.app} (${e.satisfied ? "deployed" : "NOT deployed"})`,
      );
      return text(
        `apps:\n${apps.join("\n") || "(none)"}\n\nedges:\n${edges.join("\n") || "(none)"}`,
      );
    },
  );

  const sourceRead = tool(
    "source_read",
    "Read the platform's OWN source (the code this platform is running). Repo-rooted path like packages/opd/src/api.ts; optional line range.",
    {
      path: z.string(),
      start: z.number().optional(),
      end: z.number().optional(),
    },
    async ({ path, start, end }) => {
      if (
        path.includes("..") ||
        !/^(packages|genesis|test|docs)\/[A-Za-z0-9._/-]+$|^(README\.md|package\.json|tsconfig\.json)$/.test(
          path,
        )
      )
        return text(
          "path must be repo-rooted (packages/, genesis/, test/, docs/)",
        );
      const f = Bun.file(join(deps.srcDir, path));
      if (!(await f.exists())) return text(`no such file: ${path}`);
      const lines = (await f.text()).split("\n");
      const a = Math.max(1, start ?? 1);
      const b = Math.min(
        lines.length,
        end ?? a + MAX_SOURCE_LINES - 1,
        a + MAX_SOURCE_LINES - 1,
      );
      addSource({
        kind: "code",
        ref: path,
        title: path.split("/").pop() ?? path,
      });
      return text(
        lines
          .slice(a - 1, b)
          .map((l, i) => `${a + i}\t${l}`)
          .join("\n") +
          (b < lines.length ? `\n… (${lines.length} lines total)` : ""),
      );
    },
  );

  return [
    docsSearch,
    docsRead,
    overview,
    appInspect,
    appLogs,
    workList,
    workRead,
    integrations,
    sourceRead,
  ];
}

const TOOL_NAMES = [
  "docs_search",
  "docs_read",
  "platform_overview",
  "app_inspect",
  "app_logs",
  "work_list",
  "work_read",
  "integration_map",
  "source_read",
];

function promptFrom(
  user: UserRow,
  domain: string,
  pagePath: string | null,
  messages: GuideMessage[],
): string {
  const convo = messages
    .slice(-12)
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Guide"}: ${m.content.slice(0, 6000)}`,
    )
    .join("\n\n");
  return `Signed-in user: ${user.username} · platform: ${domain}${pagePath ? ` · currently viewing: ${pagePath}` : ""}

${convo}

Reply to the user's last message as the guide.`;
}

export async function runGuide(
  deps: GuideDeps,
  opts: {
    user: UserRow;
    messages: GuideMessage[];
    pagePath?: string | null;
    onEvent: (ev: GuideEvent) => void;
    deadlineMs?: number;
    runQuery?: RunQuery; // test seam
  },
): Promise<Result<{ costUsd: number | null }, GuideError>> {
  const messages = opts.messages.filter((m) => m.content.trim());
  if (!messages.length)
    return Result.err(new GuideError({ message: "empty conversation" }));
  const system = await systemFrom(deps);
  const sources: GuideSource[] = [];
  const server = createSdkMcpServer({
    name: "platform",
    tools: makeTools(deps, opts.user, sources),
    // Nine small tools — always in the prompt, never behind tool search (a
    // deferral round-trip is a whole wasted turn on every conversation).
    alwaysLoad: true,
  });

  const run = opts.runQuery ?? query;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.deadlineMs ?? 120_000);
  try {
    const q = run({
      prompt: promptFrom(
        opts.user,
        deps.domain,
        opts.pagePath ?? null,
        messages,
      ),
      options: {
        model: process.env[MODEL_ENV] ?? deps.model(),
        systemPrompt: system,
        mcpServers: { platform: server },
        allowedTools: TOOL_NAMES.map((t) => `mcp__platform__${t}`),
        maxTurns: MAX_TURNS,
        permissionMode: "bypassPermissions",
        settingSources: [],
        thinking: { type: "adaptive" },
        includePartialMessages: true,
        strictMcpConfig: true,
        abortController: abort,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? "/tmp",
          LANG: process.env["LANG"] ?? "C.UTF-8",
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_OAUTH_TOKEN: deps.oauthToken,
          CLAUDE_CONFIG_DIR: join(homedir(), ".op-guide-cfg"),
        },
      },
    } as Parameters<typeof query>[0]);

    let costUsd: number | null = null;
    let errored = false;
    let sawText = false;
    for await (const m of q) {
      if (m.type === "stream_event") {
        const ev = (
          m as {
            event?: {
              type?: string;
              delta?: { type?: string; text?: string };
              content_block?: { type?: string; name?: string };
            };
          }
        ).event;
        const d = ev?.delta;
        if (d?.type === "thinking_delta") opts.onEvent({ type: "thinking" });
        else if (d?.type === "text_delta" && d.text) {
          sawText = true;
          opts.onEvent({ type: "text", text: d.text });
        } else if (
          ev?.type === "content_block_start" &&
          ev.content_block?.type === "tool_use" &&
          // Only OUR tools surface in the UI — SDK plumbing (tool search)
          // is not something the user should see the guide "doing".
          ev.content_block.name?.startsWith("mcp__platform__")
        ) {
          opts.onEvent({
            type: "tool",
            name: ev.content_block.name.replace(/^mcp__platform__/, ""),
            detail: "",
          });
        }
      }
      if (m.type === "result") {
        errored = m.subtype !== "success";
        costUsd =
          "total_cost_usd" in m
            ? ((m as { total_cost_usd?: number }).total_cost_usd ?? null)
            : null;
        // Non-streaming runs (a test seam, or partial messages missing) still
        // deliver the final text.
        const resultText =
          "result" in m ? String((m as { result?: unknown }).result ?? "") : "";
        if (!sawText && resultText)
          opts.onEvent({ type: "text", text: resultText });
      }
    }
    if (errored && !sawText)
      return Result.err(
        new GuideError({ message: "guide returned no result" }),
      );
    if (sources.length) opts.onEvent({ type: "sources", sources });
    opts.onEvent({ type: "done", costUsd });
    return Result.ok({ costUsd });
  } catch (cause) {
    return Result.err(new GuideError({ message: String(cause) }));
  } finally {
    clearTimeout(timer);
  }
}
