import type { Log, StateDir } from "@op/core";
import { buildLogPath, isReservedAppName, isValidName } from "@op/core";
import { listSnapshots, snapshot } from "@op/data";
import type { Engine } from "@op/engine";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import type { Store } from "@op/store";
import { appSpecPath, commitFiles, readAppSpecs, TEMPLATE } from "./gitops.ts";
import { computeIntegrationMap } from "./integration.ts";
import type { AppPolicy } from "./manifest.ts";
import { hostFor, type AppSpec } from "./policy.ts";
import type { Reconciler } from "./reconcile.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

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
      const issue = deps.forge.createIssue(user, owner, name, {
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

      // File the conversion work as an agent-import issue. The dispatcher maps
      // that label to the importer crew role; the normal preview→review→merge
      // pipeline ships the tuned app.
      const issue = deps.forge.createIssue(user, owner, name, {
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

    // ── pull requests ────────────────────────────────────────────────────
    // POST /api/v1/repos/:o/:n/pulls {title, head, base?}
    let pm = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    if (pm) {
      const [, owner, repo] = pm as unknown as [string, string, string];
      if (!isValidName(owner) || !isValidName(repo))
        return json({ error: "invalid" }, 400);
      if (req.method === "GET") {
        const user = await deps.forge.authenticate(req);
        if (!user || !deps.forge.authorize(user, owner, repo, "read"))
          return json({ error: "unauthorized" }, user ? 403 : 401);
        const state = url.searchParams.get("state") ?? undefined;
        return json({ pulls: deps.store.listPrs(owner, repo, state) });
      }
      if (req.method === "POST") {
        const user = await deps.forge.authenticate(req);
        if (!user) return json({ error: "unauthorized" }, 401);
        const body = (await req.json().catch(() => null)) as {
          title?: string;
          head?: string;
          base?: string;
        } | null;
        if (!body?.head) return json({ error: "head branch required" }, 400);
        const pr = await deps.forge.createPr(user, owner, repo, {
          title: body.title ?? "",
          head: body.head,
          ...(body.base ? { base: body.base } : {}),
        });
        if (pr.status === "error")
          return json(
            { error: pr.error.message },
            pr.error.code === "unauthorized" ? 403 : 400,
          );
        // Kick so a preview environment comes up for the new PR.
        void deps.reconciler.kickAll();
        return json(pr.value, 201);
      }
    }

    // GET /api/v1/repos/:o/:n/pulls/:num  (+ diff)
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

    // POST /api/v1/repos/:o/:n/pulls/:num/{merge,close}
    pm = path.match(
      /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/(merge|close)$/,
    );
    if (req.method === "POST" && pm) {
      const [, owner, repo, num, action] = pm as unknown as [
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
      if (action === "merge") {
        const merged = await deps.forge.mergePr(user, owner, repo, Number(num));
        if (merged.status === "error")
          return json(
            { error: merged.error.message },
            merged.error.code === "unauthorized" ? 403 : 400,
          );
        void deps.reconciler.kickAll(); // ship the merge + tear down the preview
        return json(merged.value);
      }
      const closed = deps.forge.closePr(user, owner, repo, Number(num));
      if (closed.status === "error")
        return json(
          { error: closed.error.message },
          closed.error.code === "unauthorized" ? 403 : 400,
        );
      void deps.reconciler.kickAll();
      return json({ ok: true });
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

    // ── issues ───────────────────────────────────────────────────────────
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
          openBlockers: deps.store.openBlockers(owner, repo, i.number),
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
        const issue = deps.forge.createIssue(user, owner, repo, {
          title: body.title,
          ...(body.body ? { body: body.body } : {}),
          ...(body.labels ? { labels: body.labels } : {}),
        });
        if (issue.status === "error")
          return json(
            { error: issue.error.message },
            issue.error.code === "not_found" ? 404 : 400,
          );
        deps.kickCrew(); // an agent-work issue wakes the crew
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
        blockedBy: deps.store.listIssueBlockers(owner, repo, Number(num)),
        openBlockers: deps.store.openBlockers(owner, repo, Number(num)),
      });
    }

    // POST /api/v1/repos/:o/:n/issues/:num/{comments,labels,close,deps}
    im = path.match(
      /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/(comments|labels|close|deps)$/,
    );
    if (req.method === "POST" && im) {
      const [, owner, repo, num, action] = im as unknown as [
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
      if (action === "comments") {
        const body = (await req.json().catch(() => null)) as {
          body?: string;
        } | null;
        const c = deps.forge.comment(user, owner, repo, n, body?.body ?? "");
        if (c.status === "error") return json({ error: c.error.message }, 400);
        return json(c.value, 201);
      }
      if (action === "labels") {
        const body = (await req.json().catch(() => null)) as {
          labels?: string[];
        } | null;
        const r = deps.forge.setIssueLabels(
          user,
          owner,
          repo,
          n,
          body?.labels ?? [],
        );
        if (r.status === "error")
          return json(
            { error: r.error.message },
            r.error.code === "unauthorized" ? 403 : 400,
          );
        deps.kickCrew(); // labeling agent-work wakes the crew
        return json(r.value);
      }
      if (action === "deps") {
        const body = (await req.json().catch(() => null)) as {
          blockedBy?: number;
          remove?: boolean;
        } | null;
        const blockedBy = Number(body?.blockedBy);
        if (!Number.isInteger(blockedBy))
          return json({ error: "blockedBy (issue number) required" }, 400);
        const r = body?.remove
          ? deps.forge.removeIssueDep(user, owner, repo, n, blockedBy)
          : deps.forge.setIssueDep(user, owner, repo, n, blockedBy);
        if (r.status === "error")
          return json(
            { error: r.error.message },
            r.error.code === "unauthorized"
              ? 403
              : r.error.code === "not_found"
                ? 404
                : 400,
          );
        // A now-unblocked issue may be ready — nudge the crew.
        deps.kickCrew();
        return json({
          ok: true,
          blockedBy: deps.store.listIssueBlockers(owner, repo, n),
        });
      }
      const closed = deps.forge.closeIssue(user, owner, repo, n);
      if (closed.status === "error")
        return json(
          { error: closed.error.message },
          closed.error.code === "unauthorized" ? 403 : 400,
        );
      return json({ ok: true });
    }

    // GET /api/v1/crew — the crew's cross-app queue: what's actively building/
    // reviewing/reworking/queued, and what's blocked on a human. Feeds the
    // header pill (counts) and the /crew page (items).
    if (req.method === "GET" && path === "/api/v1/crew") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const byLabel = (label: string, phase: string) =>
        deps.store.listIssuesByLabel(label).map((i) => ({
          owner: i.owner,
          repo: i.repo,
          number: i.number,
          title: i.title,
          phase,
        }));
      const blocked = [
        ...byLabel("agent-review-failed", "needs review"),
        ...byLabel("agent-failed", "failed"),
      ];
      const working = [
        ...byLabel("agent-building", "building"),
        ...byLabel("agent-reworking", "reworking"),
        ...byLabel("agent-reviewing", "reviewing"),
        ...byLabel("agent-work", "queued"),
      ];
      // Blocked first (needs attention), then in-progress.
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
