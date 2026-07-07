import type { Log, StateDir } from "@op/core";
import { buildLogPath, isValidName } from "@op/core";
import { listSnapshots, snapshot } from "@op/data";
import type { Engine } from "@op/engine";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import type { Store } from "@op/store";
import { appSpecPath, commitFiles, readAppSpecs, TEMPLATE } from "./gitops.ts";
import { hostFor, type AppSpec } from "./policy.ts";
import type { Reconciler } from "./reconcile.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

export interface ApiDeps {
  sd: StateDir;
  store: Store;
  forge: Forge;
  git: GitHost;
  engine: Engine;
  reconciler: Reconciler;
  domain: string;
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

    // POST /api/v1/apps {name} — template → repo → spec → reconcile.
    if (req.method === "POST" && path === "/api/v1/apps") {
      const user = await deps.forge.authenticate(req);
      if (!user) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as {
        name?: string;
      } | null;
      const name = body?.name;
      if (!name || !isValidName(name))
        return json({ error: "invalid app name" }, 400);

      const repo = await deps.forge.createFromTemplate(user, TEMPLATE, name);
      if (repo.status === "error") {
        return json(
          { error: repo.error.message },
          repo.error.code === "conflict" ? 409 : 400,
        );
      }

      const spec: AppSpec = {
        owner: user.username,
        app: name,
        repo: { owner: user.username, name },
        ref: "main",
        containerPort: 8080,
        data: true,
      };
      const committed = await commitFiles(
        deps.sd,
        { owner: "sys", name: "gitops" },
        { [appSpecPath(user.username, name)]: JSON.stringify(spec, null, 2) },
        `apps: register ${user.username}/${name}`,
      );
      if (committed.status === "error")
        return json({ error: committed.error.message }, 500);

      // Local commits bypass smart-HTTP, so no push event fires — kick directly.
      void deps.reconciler.kickAll();
      return json(
        {
          owner: user.username,
          app: name,
          host: hostFor(spec, deps.domain),
          // Honor the port the client actually reached us on (local high-port
          // dev vs a real :443 deploy) — the domain alone loses it.
          cloneUrl: `https://${url.host}/${user.username}/${name}.git`,
        },
        201,
      );
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
