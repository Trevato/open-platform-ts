import type { Log, StateDir } from "@op/core";
import { buildLogPath, isReservedAppName, isValidName } from "@op/core";
import { listSnapshots, snapshot } from "@op/data";
import type { Engine } from "@op/engine";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import type { IssueRow, Store, UserRow, WorkPhase } from "@op/store";
import type { GuideEvent, GuideMessage } from "./crew/guide.ts";
import { appSpecPath, commitFiles, readAppSpecs, TEMPLATE } from "./gitops.ts";
import { computeIntegrationMap } from "./integration.ts";
import type { AppPolicy } from "./manifest.ts";
import { hostFor, type AppSpec } from "./policy.ts";
import type { Reconciler } from "./reconcile.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

// The work-item phase vocabulary (mirrors the store's legal-edge table) and
// the non-terminal subset the platform-wide queue reports by default.
const WORK_PHASES: ReadonlySet<string> = new Set([
  "intent",
  "queued",
  "building",
  "reviewing",
  "reworking",
  "shipped",
  "parked",
  "closed",
]);
const ACTIVE_PHASES: readonly WorkPhase[] = [
  "intent",
  "queued",
  "building",
  "reviewing",
  "reworking",
  "parked",
];

// Derive a short, valid app name from a plain-English workflow description, so
// a non-technical user never has to "name an app". Takes the first couple of
// content words (dropping filler), slugifies, and clamps to the DNS-safe
// grammar. Falls back to "tool" when nothing usable survives; the caller
// de-duplicates against existing apps.
const NAME_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "i",
  "my",
  "we",
  "our",
  "to",
  "for",
  "of",
  "and",
  "in",
  "on",
  "with",
  "that",
  "this",
  "some",
  "keep",
  "track",
  "tracking",
  "manage",
  "managing",
  "list",
  "log",
  "logging",
  "tool",
  "app",
  "simple",
  "record",
  "records",
  "recording",
  "want",
  "need",
  "handle",
  "handling",
  "do",
]);
function deriveAppName(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !NAME_STOPWORDS.has(w));
  const picked = words.slice(0, 2).join("-").slice(0, 30);
  const cleaned = picked.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return cleaned && isValidName(cleaned) && !isReservedAppName(cleaned)
    ? cleaned
    : "tool";
}

// Derive an app name from a clone URL: last path segment, minus a trailing
// ".git", lowercased. Non-name chars become hyphens so the caller's isValidName
// check is the single source of truth on what's acceptable.
function repoNameFromUrl(url: string): string {
  let last = url;
  try {
    last = new URL(url).pathname;
  } catch {
    /* fall through: treat the raw string's tail as the name */
  }
  const seg = last.split("/").filter(Boolean).pop() ?? "";
  return seg
    .replace(/\.git$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ApiDeps {
  sd: StateDir;
  store: Store;
  forge: Forge;
  git: GitHost;
  engine: Engine;
  reconciler: Reconciler;
  /** Wake the crew dispatcher (issue labeled agent-work). */
  kickCrew: () => void;
  /** Compose a rough idea into a structured issue draft, or null if the
   *  composer isn't credentialed (the console then files the idea as-is). */
  draftIssue:
    | ((
        idea: string,
        context?: string,
        onEvent?: (ev: {
          phase: "thinking" | "drafting";
          text?: string;
        }) => void,
      ) => Promise<{
        title: string;
        body: string;
        labels: string[];
        acceptanceChecks: string[];
      } | null>)
    | null;
  domain: string;
  /** Operator bounds for op.json — used to admit manifests when deriving
   *  the integration map. */
  appPolicy: () => AppPolicy;
  /** The in-console guide agent, or null when no Claude credential is
   *  configured (the console then hides the Ask affordance). */
  guide:
    | ((opts: {
        user: UserRow;
        messages: GuideMessage[];
        pagePath: string | null;
        onEvent: (ev: GuideEvent) => void;
      }) => Promise<{ ok: boolean; error?: string }>)
    | null;
  log: Log;
}

// Platform API: the mediated surface. Every mutation authenticates via the
// forge and is authorized against git permissions before it touches state.
export function apiRouter(
  deps: ApiDeps,
): (req: Request) => Promise<Response | null> {
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return json({ ok: true, domain: deps.domain });

    // GET /api/v1/integration-map[?owner=] — the derived app graph. Public
    // read under M1 (it derives from public-read repos and statuses), which
    // doubles as runtime discovery for apps themselves: a hub filters
    // provides by name and sees new peers with no redeploy.
    if (req.method === "GET" && path === "/api/v1/integration-map") {
      const owner = url.searchParams.get("owner");
      const map = await computeIntegrationMap({
        git: deps.git,
        store: deps.store,
        domain: deps.domain,
        policy: deps.appPolicy(),
        ...(owner ? { owner } : {}),
      });
      return json(map);
    }

    // POST /api/v1/apps {name} — template → repo → spec → reconcile.
    if (req.method === "POST" && path === "/api/v1/apps") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as {
        name?: string;
        owner?: string;
      } | null;
      const name = body?.name;
      if (!name || !isValidName(name))
        return json({ error: "invalid app name" }, 400);
      if (isReservedAppName(name))
        return json(
          {
            error: `'${name}' is reserved (names starting 'pr-<n>' collide with preview hosts)`,
          },
          400,
        );
      // An app may be owned by the user or by an org they belong to.
      // createFromTemplate re-checks membership; this is the fast, clear reject.
      const owner = body?.owner ?? user.username;
      if (!deps.forge.canWriteOwner(user, owner))
        return json({ error: `not a member of '${owner}'` }, 403);

      const repo = await deps.forge.createFromTemplate(
        user,
        TEMPLATE,
        name,
        owner,
      );
      if (repo.status === "error") {
        return json(
          { error: repo.error.message },
          repo.error.code === "conflict" ? 409 : 400,
        );
      }

      const spec: AppSpec = {
        owner,
        app: name,
        repo: { owner, name },
        ref: "main",
        containerPort: 8080,
        data: true,
      };
      const committed = await commitFiles(
        deps.sd,
        { owner: "sys", name: "gitops" },
        { [appSpecPath(owner, name)]: JSON.stringify(spec, null, 2) },
        `apps: register ${owner}/${name}`,
      );
      if (committed.status === "error")
        return json({ error: committed.error.message }, 500);

      // Local commits bypass smart-HTTP, so no push event fires — kick directly.
      void deps.reconciler.kickAll();
      return json(
        {
          owner,
          app: name,
          host: hostFor(spec, deps.domain),
          // Honor the port the client actually reached us on (local high-port
          // dev vs a real :443 deploy) — the domain alone loses it.
          cloneUrl: `https://${url.host}/${owner}/${name}.git`,
        },
        201,
      );
    }

    // POST /api/v1/onramp {description, owner?, name?} — the one-motion start
    // for a non-technical user: describe a workflow in plain English and get a
    // named, deployed app PLUS a filed first build, in a single call. Removes
    // the "name an app, then separately describe a feature" two-step.
    if (req.method === "POST" && path === "/api/v1/onramp") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as {
        description?: string;
        owner?: string;
        name?: string;
      } | null;
      const description = body?.description?.trim();
      if (!description) return json({ error: "description required" }, 400);
      const owner = body?.owner ?? user.username;
      if (!deps.forge.canWriteOwner(user, owner))
        return json({ error: `not a member of '${owner}'` }, 403);

      // Name it FOR them: an explicit name wins; otherwise derive from the
      // description and de-duplicate against the owner's existing apps.
      let name = body?.name
        ? body.name.toLowerCase()
        : deriveAppName(description);
      if (!isValidName(name) || isReservedAppName(name))
        return json({ error: `could not derive a valid app name` }, 400);
      if (!body?.name) {
        const taken = new Set(
          deps.store.listReposByOwner(owner).map((r) => r.name),
        );
        if (taken.has(name)) {
          let n = 2;
          while (taken.has(`${name}-${n}`) && n < 100) n++;
          name = `${name}-${n}`;
        }
      }

      const repo = await deps.forge.createFromTemplate(
        user,
        TEMPLATE,
        name,
        owner,
      );
      if (repo.status === "error")
        return json(
          { error: repo.error.message },
          repo.error.code === "conflict" ? 409 : 400,
        );

      const spec: AppSpec = {
        owner,
        app: name,
        repo: { owner, name },
        ref: "main",
        containerPort: 8080,
        data: true,
      };
      const committed = await commitFiles(
        deps.sd,
        { owner: "sys", name: "gitops" },
        { [appSpecPath(owner, name)]: JSON.stringify(spec, null, 2) },
        `apps: onramp ${owner}/${name}`,
      );
      if (committed.status === "error")
        return json({ error: committed.error.message }, 500);
      void deps.reconciler.kickAll();

      // File the build from their words RIGHT NOW and return — the request must
      // not block on a model call (the composer is a thinking call up to 30s;
      // blocking on it made submit feel hung). The builder reads the raw
      // description directly and builds it. A clean title is the first line.
      const firstLine = description.split(/[.\n]/)[0]!.trim();
      const title =
        firstLine.length > 4 ? firstLine.slice(0, 72) : "Build my tool";
      // agent-work is the enqueue verb: the item is born at phase `queued`.
      const issue = await deps.forge.createWork(user, owner, name, {
        title,
        body: description,
        labels: ["agent-work"],
      });
      if (issue.status === "error")
        return json({ error: issue.error.message }, 400);
      deps.kickCrew();

      return json(
        {
          owner,
          app: name,
          issue: issue.value.number,
          host: hostFor(spec, deps.domain),
        },
        201,
      );
    }

    // POST /api/v1/apps/import {url, owner?, name?} — clone an external repo,
    // register it as an app, and file an agent-import issue so the crew tunes
    // it to platform conventions (Dockerfile serving PORT, DATA_DIR sqlite).
    if (req.method === "POST" && path === "/api/v1/apps/import") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as {
        url?: string;
        owner?: string;
        name?: string;
      } | null;
      const gitUrl = body?.url?.trim();
      if (!gitUrl) return json({ error: "url required" }, 400);
      const owner = body?.owner ?? user.username;
      if (!deps.forge.canWriteOwner(user, owner))
        return json({ error: `not a member of '${owner}'` }, 403);
      const name = (body?.name ?? repoNameFromUrl(gitUrl)).toLowerCase();
      if (!isValidName(name))
        return json(
          { error: `could not derive a valid app name from the URL` },
          400,
        );
      if (isReservedAppName(name))
        return json({ error: `'${name}' is reserved` }, 400);

      const imported = await deps.forge.importFromRemote(
        user,
        owner,
        name,
        gitUrl,
      );
      if (imported.status === "error")
        return json(
          { error: imported.error.message },
          imported.error.code === "conflict"
            ? 409
            : imported.error.code === "unauthorized"
              ? 403
              : 400,
        );

      const spec: AppSpec = {
        owner,
        app: name,
        repo: { owner, name },
        ref: "main",
        containerPort: 8080,
        data: true,
      };
      const committed = await commitFiles(
        deps.sd,
        { owner: "sys", name: "gitops" },
        { [appSpecPath(owner, name)]: JSON.stringify(spec, null, 2) },
        `apps: import ${owner}/${name} from ${gitUrl}`,
      );
      if (committed.status === "error")
        return json({ error: committed.error.message }, 500);

      // File the conversion work as an agent-import work item, born queued
      // (agent-work is the enqueue verb). The dispatcher maps agent-import to
      // the importer crew role; the normal preview→review→merge pipeline
      // ships the tuned app.
      const issue = await deps.forge.createWork(user, owner, name, {
        title: `Tune imported app to platform conventions`,
        body: [
          `This repo was imported from ${gitUrl}.`,
          ``,
          `Make it run as a platform app:`,
          `- A Dockerfile that builds and starts the server, listening on the port in the PORT env var (default 8080).`,
          `- Persist any data under the directory in the DATA_DIR env var (SQLite file and/or files/ subdir). Do not write elsewhere.`,
          `- The container must run as a non-root user and start with no manual steps.`,
          `- If the app has its own port in the code, either read PORT or update app.json's containerPort to match — keep them consistent.`,
          `- Keep the app's existing functionality intact; only adapt packaging/config.`,
          ``,
          `Acceptance: the preview builds, serves HTTP 200 on / (or a documented health path), and survives a restart with its data intact.`,
        ].join("\n"),
        labels: ["agent-import", "agent-work"],
      });
      if (issue.status === "error")
        return json({ error: issue.error.message }, 400);

      void deps.reconciler.kickAll();
      deps.kickCrew();
      return json(
        {
          owner,
          app: name,
          issue: issue.value.number,
          host: hostFor(spec, deps.domain),
          cloneUrl: `https://${url.host}/${owner}/${name}.git`,
        },
        201,
      );
    }

    // ── orgs ─────────────────────────────────────────────────────────────
    // POST /api/v1/orgs {name, displayName?}
    if (req.method === "POST" && path === "/api/v1/orgs") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as {
        name?: string;
        displayName?: string;
      } | null;
      if (!body?.name) return json({ error: "org name required" }, 400);
      const org = await deps.forge.createOrg(
        user,
        body.name,
        body.displayName ?? "",
      );
      if (org.status === "error")
        return json(
          { error: org.error.message },
          org.error.code === "conflict" ? 409 : 400,
        );
      return json(
        { name: org.value.name, displayName: org.value.display_name },
        201,
      );
    }

    // POST /api/v1/orgs/:org/members {username}
    const om = path.match(/^\/api\/v1\/orgs\/([^/]+)\/members$/);
    if (req.method === "POST" && om) {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as {
        username?: string;
      } | null;
      if (!body?.username) return json({ error: "username required" }, 400);
      const added = deps.forge.addOrgMember(user, om[1]!, body.username);
      if (added.status === "error")
        return json(
          { error: added.error.message },
          added.error.code === "unauthorized"
            ? 403
            : added.error.code === "not_found"
              ? 404
              : 400,
        );
      return json({ ok: true }, 201);
    }

    // ── work items ──────────────────────────────────────────────────────
    // One noun: work. A work item = intent + at most one live change + an
    // append-only attempts ledger; `phase` is the process truth. This family
    // replaces the parallel /issues + /pulls write families (kept below as
    // thin reads for one release).
    const port = url.port ? `:${url.port}` : "";
    const blockersOf = (owner: string, repo: string, number: number) =>
      deps.store.openWorkBlockers(owner, repo, number).map((b) => ({
        owner: b.on_owner,
        repo: b.on_repo,
        number: b.on_number,
        phase: b.phase,
      }));
    const workJson = (row: IssueRow) => ({
      number: row.number,
      owner: row.owner,
      repo: row.repo,
      title: row.title,
      body: row.body,
      author: row.author,
      state: row.state,
      labels: row.labels.split(",").filter(Boolean),
      phase: row.phase,
      parkedReason: row.parked_reason,
      createdAt: row.created_at,
      change: row.head_ref
        ? {
            head: row.head_ref,
            base: row.base_ref,
            state: row.change_state,
            preview:
              row.change_state === "open"
                ? `https://pr-${row.number}-${row.repo}-${row.owner}.${deps.domain}${port}/`
                : null,
          }
        : null,
      blockedBy: blockersOf(row.owner, row.repo, row.number),
    });
    const fail = (e: { message: string; code: string }) =>
      json(
        { error: e.message },
        e.code === "unauthorized" ? 403 : e.code === "not_found" ? 404 : 400,
      );

    // POST/GET /api/v1/repos/:o/:r/work — file work, list work.
    let wm = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/work$/);
    if (wm) {
      const [, owner, repo] = wm as unknown as [string, string, string];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      if (req.method === "GET") {
        const user = await deps.forge.authenticate(req);
        if (!user || !deps.forge.authorize(user, owner, repo, "read"))
          return json({ error: "unauthorized" }, user ? 403 : 401);
        const state = url.searchParams.get("state") ?? undefined;
        const phase = url.searchParams.get("phase");
        if (phase && !WORK_PHASES.has(phase))
          return json({ error: `unknown phase '${phase}'` }, 400);
        const items = deps.store
          .listIssues(owner, repo, state)
          .filter((i) => !phase || i.phase === phase);
        return json({ work: items.map(workJson) });
      }
      if (req.method === "POST") {
        const user = await deps.forge.authenticate(req);
        if (!user) return json({ error: "unauthorized" }, 401);
        const body = (await req.json().catch(() => null)) as {
          title?: string;
          body?: string;
          labels?: string[];
          head?: string;
          base?: string;
        } | null;
        if (!body?.title) return json({ error: "title required" }, 400);
        const created = await deps.forge.createWork(user, owner, repo, {
          title: body.title,
          ...(body.body ? { body: body.body } : {}),
          ...(body.labels ? { labels: body.labels } : {}),
          ...(body.head ? { head: body.head } : {}),
          ...(body.base ? { base: body.base } : {}),
        });
        if (created.status === "error") return fail(created.error);
        // Born reviewing (a change came attached) → build its preview; born
        // queued (the agent-work verb) → wake the crew.
        if (created.value.phase === "reviewing") void deps.reconciler.kickAll();
        if (created.value.phase === "queued") deps.kickCrew();
        return json(workJson(created.value), 201);
      }
    }

    // GET /api/v1/work?phase= — the platform-wide queue (dashboard/heartbeat).
    if (req.method === "GET" && path === "/api/v1/work") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const phase = url.searchParams.get("phase");
      if (phase && !WORK_PHASES.has(phase))
        return json({ error: `unknown phase '${phase}'` }, 400);
      const phases = phase ? [phase as WorkPhase] : ACTIVE_PHASES;
      return json({
        work: phases
          .flatMap((p) => deps.store.listWorkByPhase(p))
          .map(workJson),
      });
    }

    // GET /api/v1/repos/:o/:r/work/:n — the whole work item: intent, change
    // (+ diff), attempts ledger, blockers, comments.
    wm = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/work\/(\d+)$/);
    if (req.method === "GET" && wm) {
      const [, owner, repo, num] = wm as unknown as [
        string,
        string,
        string,
        string,
      ];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user || !deps.forge.authorize(user, owner, repo, "read"))
        return json({ error: "unauthorized" }, user ? 403 : 401);
      const n = Number(num);
      const item = deps.store.getIssue(owner, repo, n);
      if (!item) return json({ error: "not found" }, 404);
      const shaped = workJson(item);
      const diff =
        item.head_ref && item.base_ref
          ? await deps.git.diffStat(owner, repo, item.base_ref, item.head_ref)
          : null;
      return json({
        ...shaped,
        change: shaped.change
          ? {
              ...shaped.change,
              diffStat:
                diff?.status === "ok" ? diff.value : { files: [], patch: "" },
            }
          : null,
        attempts: deps.store.listAttempts(owner, repo, n).map((a) => ({
          attempt: a.attempt,
          headSha: a.head_sha,
          verdict: a.verdict,
          verdictLine: a.verdict_line,
          builderCostUsd: a.builder_cost_usd,
          reviewerCostUsd: a.reviewer_cost_usd,
          createdAt: a.created_at,
        })),
        comments: deps.store.listComments(owner, repo, n),
      });
    }

    // POST /api/v1/repos/:o/:r/work/:n/{queue,comments,close,merge,deps}
    wm = path.match(
      /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/work\/(\d+)\/(queue|comments|close|merge|deps)$/,
    );
    if (req.method === "POST" && wm) {
      const [, owner, repo, num, action] = wm as unknown as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const n = Number(num);
      if (action === "queue") {
        const r = deps.forge.queueWork(user, owner, repo, n);
        if (r.status === "error") return fail(r.error);
        deps.kickCrew();
        return json({ ok: true, phase: "queued" });
      }
      if (action === "comments") {
        const body = (await req.json().catch(() => null)) as {
          body?: string;
        } | null;
        const c = deps.forge.comment(user, owner, repo, n, body?.body ?? "");
        if (c.status === "error") return fail(c.error);
        return json(c.value, 201);
      }
      if (action === "close") {
        const r = deps.forge.closeWork(user, owner, repo, n);
        if (r.status === "error") return fail(r.error);
        void deps.reconciler.kickAll(); // an open change closed too — prune its preview
        return json({ ok: true });
      }
      if (action === "merge") {
        const merged = await deps.forge.mergeWork(user, owner, repo, n);
        if (merged.status === "error") return fail(merged.error);
        void deps.reconciler.kickAll(); // ship the merge + tear down the preview
        deps.kickCrew(); // shipping may unblock dependent work
        return json(workJson(merged.value));
      }
      // deps: declare "blocked by owner/repo#n" (same-owner, enforced in forge).
      const body = (await req.json().catch(() => null)) as {
        on?: string;
      } | null;
      const on = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/.exec(body?.on ?? "");
      if (!on) return json({ error: 'dep must be {on: "owner/repo#n"}' }, 400);
      const r = deps.forge.addWorkDep(
        user,
        { owner, repo, number: n },
        { owner: on[1]!, repo: on[2]!, number: Number(on[3]) },
      );
      if (r.status === "error") return fail(r.error);
      return json({ ok: true, blockedBy: blockersOf(owner, repo, n) }, 201);
    }

    // DELETE /api/v1/repos/:o/:r/work/:n/deps/:do/:dr/:dn
    wm = path.match(
      /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/work\/(\d+)\/deps\/([^/]+)\/([^/]+)\/(\d+)$/,
    );
    if (req.method === "DELETE" && wm) {
      const [, owner, repo, num, dOwner, dRepo, dNum] = wm as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const n = Number(num);
      const r = deps.forge.removeWorkDep(
        user,
        { owner, repo, number: n },
        { owner: dOwner, repo: dRepo, number: Number(dNum) },
      );
      if (r.status === "error") return fail(r.error);
      deps.kickCrew(); // a now-unblocked item may be ready
      return json({ ok: true, blockedBy: blockersOf(owner, repo, n) });
    }

    // ── compat, one release: /pulls as thin reads ────────────────────────
    // The list is work items with a live change shaped like the old PR JSON;
    // :num resolves via the FROZEN pull_requests table (historic numbers only
    // — no new PR numbers are ever minted).
    let pm = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    if (req.method === "GET" && pm) {
      const [, owner, repo] = pm as unknown as [string, string, string];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user || !deps.forge.authorize(user, owner, repo, "read"))
        return json({ error: "unauthorized" }, user ? 403 : 401);
      const pulls = deps.store
        .listOpenChanges()
        .filter((w) => w.owner === owner && w.repo === repo)
        .map((w) => ({
          owner: w.owner,
          repo: w.repo,
          number: w.number,
          title: w.title,
          head_ref: w.head_ref,
          base_ref: w.base_ref,
          state: "open",
          author: w.author,
          created_at: w.created_at,
        }));
      return json({ pulls });
    }

    pm = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (req.method === "GET" && pm) {
      const [, owner, repo, num] = pm as unknown as [
        string,
        string,
        string,
        string,
      ];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user || !deps.forge.authorize(user, owner, repo, "read"))
        return json({ error: "unauthorized" }, user ? 403 : 401);
      const pr = deps.store.getPr(owner, repo, Number(num));
      if (!pr) return json({ error: "not found" }, 404);
      const diff = await deps.git.diffStat(
        owner,
        repo,
        pr.base_ref,
        pr.head_ref,
      );
      return json({
        ...pr,
        diff: diff.status === "ok" ? diff.value : { files: [], patch: "" },
      });
    }

    // POST /api/v1/repos/:o/:r/issues/draft — compose a rough idea into a
    // structured issue draft (does NOT create it; the console files it via the
    // issues route). 503 when the composer isn't credentialed → file as-is.
    const dm = path.match(
      /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/draft$/,
    );
    if (req.method === "POST" && dm) {
      const [, owner, repo] = dm as unknown as [string, string, string];
      const user = await deps.forge.authenticate(req);
      if (!user || !deps.forge.authorize(user, owner, repo, "write"))
        return json({ error: "unauthorized" }, user ? 403 : 401);
      if (!deps.draftIssue) return json({ error: "composer_offline" }, 503);
      const body = (await req.json().catch(() => null)) as {
        idea?: string;
      } | null;
      if (!body?.idea?.trim()) return json({ error: "idea required" }, 400);
      const ctx = await deps.git.readFile(owner, repo, "main", "server.ts");
      const context =
        ctx.status === "ok" ? new TextDecoder().decode(ctx.value) : undefined;
      const idea = body.idea;
      const compose = deps.draftIssue;

      // Streaming: reflect the model's real state (thinking → drafting → draft)
      // so the console UI is responsive instead of frozen on a skeleton.
      if (req.headers.get("accept")?.includes("text/event-stream")) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (o: unknown) => {
              try {
                controller.enqueue(
                  enc.encode(`data: ${JSON.stringify(o)}\n\n`),
                );
              } catch {
                /* client gone */
              }
            };
            try {
              const draft = await compose(idea, context, (ev) =>
                send({ type: "event", ...ev }),
              );
              send(
                draft
                  ? { type: "draft", draft }
                  : { type: "error", error: "composer_offline" },
              );
            } catch (e) {
              send({ type: "error", error: String(e) });
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          },
        });
      }

      const draft = await compose(idea, context);
      if (!draft) return json({ error: "composer_offline" }, 503);
      return json(draft);
    }

    // ── compat, one release: /issues as thin reads over the same rows ─────
    // Work items ARE issues (identity — same numbers). Two verbs survive:
    // create (delegates to createWork semantics, so birth phase applies) and
    // the label write (the agent-work queue verb external clients speak).
    const sameRepoBlockers = (owner: string, repo: string, n: number) =>
      deps.store
        .openWorkBlockers(owner, repo, n)
        .filter((b) => b.on_owner === owner && b.on_repo === repo)
        .map((b) => b.on_number);
    let im = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/issues$/);
    if (im) {
      const [, owner, repo] = im as unknown as [string, string, string];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      if (req.method === "GET") {
        const user = await deps.forge.authenticate(req);
        if (!user || !deps.forge.authorize(user, owner, repo, "read"))
          return json({ error: "unauthorized" }, user ? 403 : 401);
        const state = url.searchParams.get("state") ?? undefined;
        const issues = deps.store.listIssues(owner, repo, state).map((i) => ({
          ...i,
          openBlockers: sameRepoBlockers(owner, repo, i.number),
        }));
        return json({ issues });
      }
      if (req.method === "POST") {
        const user = await deps.forge.authenticate(req);
        if (!user) return json({ error: "unauthorized" }, 401);
        const body = (await req.json().catch(() => null)) as {
          title?: string;
          body?: string;
          labels?: string[];
        } | null;
        if (!body?.title) return json({ error: "title required" }, 400);
        const issue = await deps.forge.createWork(user, owner, repo, {
          title: body.title,
          ...(body.body ? { body: body.body } : {}),
          ...(body.labels ? { labels: body.labels } : {}),
        });
        if (issue.status === "error") return fail(issue.error);
        if (issue.value.phase === "queued") deps.kickCrew(); // born queued wakes the crew
        return json(issue.value, 201);
      }
    }

    // GET /api/v1/repos/:o/:n/issues/:num  (+ comments)
    im = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
    if (req.method === "GET" && im) {
      const [, owner, repo, num] = im as unknown as [
        string,
        string,
        string,
        string,
      ];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user || !deps.forge.authorize(user, owner, repo, "read"))
        return json({ error: "unauthorized" }, user ? 403 : 401);
      const issue = deps.store.getIssue(owner, repo, Number(num));
      if (!issue) return json({ error: "not found" }, 404);
      return json({
        ...issue,
        comments: deps.store.listComments(owner, repo, Number(num)),
        blockedBy: deps.store
          .listWorkDeps(owner, repo, Number(num))
          .filter((d) => d.on_owner === owner && d.on_repo === repo)
          .map((d) => d.on_number),
        openBlockers: sameRepoBlockers(owner, repo, Number(num)),
      });
    }

    // POST /api/v1/repos/:o/:n/issues/:num/labels — the queue verb external
    // clients still speak. Labels are taxonomy; the ONLY phase effect is the
    // intent → queued edge when agent-work appears. A label write never moves
    // any other phase.
    im = path.match(
      /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/,
    );
    if (req.method === "POST" && im) {
      const [, owner, repo, num] = im as unknown as [
        string,
        string,
        string,
        string,
      ];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const n = Number(num);
      const body = (await req.json().catch(() => null)) as {
        labels?: string[];
      } | null;
      const labels = body?.labels ?? [];
      const r = deps.forge.setIssueLabels(user, owner, repo, n, labels);
      if (r.status === "error") return fail(r.error);
      if (
        labels.some((l) => l.trim().toLowerCase() === "agent-work") &&
        deps.store.getIssue(owner, repo, n)?.phase === "intent"
      )
        deps.forge.queueWork(user, owner, repo, n);
      deps.kickCrew(); // labeling agent-work wakes the crew
      return json(r.value);
    }

    // POST /api/v1/guide — the in-console guide agent, SSE. The conversation
    // travels in the body (nothing persists server-side); events stream back
    // in the composer's wire shape: thinking → text deltas → tool markers →
    // sources → done. 503 when no Claude credential is configured.
    if (req.method === "POST" && path === "/api/v1/guide") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const runGuide = deps.guide;
      if (!runGuide) return json({ error: "guide_offline" }, 503);
      const body = (await req.json().catch(() => null)) as {
        messages?: Array<{ role?: string; content?: string }>;
        page?: string;
      } | null;
      const messages: GuideMessage[] = (body?.messages ?? [])
        .slice(-20)
        .map((m) => ({
          role:
            m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: String(m.content ?? "").slice(0, 8_000),
        }))
        .filter((m) => m.content.trim().length > 0);
      if (!messages.length) return json({ error: "messages required" }, 400);
      const pagePath =
        typeof body?.page === "string" &&
        body.page.startsWith("/") &&
        body.page.length < 300
          ? body.page
          : null;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (o: unknown) => {
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            } catch {
              /* client gone */
            }
          };
          try {
            const out = await runGuide({
              user,
              messages,
              pagePath,
              onEvent: send,
            });
            if (!out.ok)
              send({ type: "error", error: out.error ?? "guide failed" });
          } catch (e) {
            send({ type: "error", error: String(e) });
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      });
    }

    // GET /api/v1/crew — the crew's cross-app queue by phase: what's actively
    // building/reviewing/reworking/queued, and what's parked on a human.
    // Feeds the header pill (counts) and the /crew page (items).
    if (req.method === "GET" && path === "/api/v1/crew") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const shape = (i: IssueRow) => ({
        owner: i.owner,
        repo: i.repo,
        number: i.number,
        title: i.title,
        phase: i.phase,
        parkedReason: i.parked_reason,
      });
      // Parked first (needs a human), then in-flight.
      const blocked = deps.store.listWorkByPhase("parked").map(shape);
      const working = (
        ["building", "reworking", "reviewing", "queued"] as const
      ).flatMap((p) => deps.store.listWorkByPhase(p).map(shape));
      return json({
        working: working.length,
        blocked: blocked.length,
        items: [...blocked, ...working],
      });
    }

    // GET /api/v1/apps — desired apps (from gitops) overlaid with observed state.
    if (req.method === "GET" && path === "/api/v1/apps") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const specs = await readAppSpecs(deps.git, deps.domain);
      if (specs.status === "error")
        return json({ error: specs.error.message }, 500);
      const apps = specs.value.map((s) => {
        const status = deps.store.getAppStatus(s.owner, s.app);
        return {
          owner: s.owner,
          app: s.app,
          host: hostFor(s, deps.domain),
          state: status?.state ?? "pending",
          message: status?.message ?? null,
          updatedAt: status?.updated_at ?? null,
        };
      });
      return json({ apps });
    }

    // GET /api/v1/apps/:owner/:app/events — the deploy timeline (newest first).
    let m = path.match(/^\/api\/v1\/apps\/([^/]+)\/([^/]+)\/events$/);
    if (req.method === "GET" && m) {
      const [, owner, app] = m as unknown as [string, string, string];
      if (!isValidName(owner) || !isValidName(app))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user || !deps.forge.authorize(user, owner, app, "read"))
        return json({ error: "unauthorized" }, user ? 403 : 401);
      const events = deps.store.listEvents(owner, app).map((e) => ({
        ts: e.ts,
        phase: e.phase,
        message: e.message,
        sha: e.sha,
      }));
      return json({ events });
    }

    // GET /api/v1/apps/:owner/:app/buildlog — the last build's output.
    m = path.match(/^\/api\/v1\/apps\/([^/]+)\/([^/]+)\/buildlog$/);
    if (req.method === "GET" && m) {
      const [, owner, app] = m as unknown as [string, string, string];
      if (!isValidName(owner) || !isValidName(app))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user || !deps.forge.authorize(user, owner, app, "read"))
        return json({ error: "unauthorized" }, user ? 403 : 401);
      const file = Bun.file(buildLogPath(deps.sd, owner, app));
      const text = (await file.exists()) ? await file.text() : "(no build yet)";
      return new Response(text, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // GET /api/v1/apps/:owner/:app/logs — tail the running container.
    m = path.match(/^\/api\/v1\/apps\/([^/]+)\/([^/]+)\/logs$/);
    if (req.method === "GET" && m) {
      const [, owner, app] = m as unknown as [string, string, string];
      if (!isValidName(owner) || !isValidName(app))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user || !deps.forge.authorize(user, owner, app, "read"))
        return json({ error: "unauthorized" }, user ? 403 : 401);
      const status = deps.store.getAppStatus(owner, app);
      if (!status?.container_id)
        return new Response("(no running container)", { status: 200 });
      const logs = await deps.engine.logs(status.container_id, { tail: 200 });
      return new Response(
        logs.status === "ok"
          ? logs.value
          : `(logs unavailable: ${logs.error.message})`,
        {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    // GET /api/v1/apps/:owner/:app — status.
    m = path.match(/^\/api\/v1\/apps\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const [, owner, app] = m as unknown as [string, string, string];
      if (!isValidName(owner) || !isValidName(app))
        return json({ error: "invalid" }, 400);
      const status = deps.store.getAppStatus(owner, app);
      if (!status) return json({ error: "not found" }, 404);
      return json({ ...status, host: `${app}-${owner}.${deps.domain}` });
    }

    // POST /api/v1/apps/:owner/:app/snapshots — checkpoint + clone + verify.
    m = path.match(/^\/api\/v1\/apps\/([^/]+)\/([^/]+)\/snapshots$/);
    if (m) {
      const [, owner, app] = m as unknown as [string, string, string];
      if (!isValidName(owner) || !isValidName(app))
        return json({ error: "invalid" }, 400);
      const user = await deps.forge.authenticate(req);
      if (!user || !deps.forge.authorize(user, owner, app, "write")) {
        return json({ error: "unauthorized" }, user ? 403 : 401);
      }
      if (req.method === "POST") {
        const snap = await snapshot(deps.sd, owner, app);
        if (snap.status === "error")
          return json({ error: snap.error.message }, 500);
        return json({ id: snap.value.id }, 201);
      }
      if (req.method === "GET") {
        const list = await listSnapshots(deps.sd, owner, app);
        return json({ snapshots: list.status === "ok" ? list.value : [] });
      }
    }

    return null;
  };
}
