import type { Log, StateDir } from "@op/core";
import { isValidName } from "@op/core";
import { listSnapshots, snapshot } from "@op/data";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import type { Store } from "@op/store";
import { appSpecPath, commitFiles, TEMPLATE } from "./gitops.ts";
import { hostFor, type AppSpec } from "./policy.ts";
import type { Reconciler } from "./reconcile.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

// Platform API: the mediated surface. Every mutation authenticates via the
// forge and is authorized against git permissions before it touches state.
export function apiRouter(deps: {
  sd: StateDir;
  store: Store;
  forge: Forge;
  git: GitHost;
  reconciler: Reconciler;
  domain: string;
  log: Log;
}): (req: Request) => Promise<Response | null> {
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
          cloneUrl: `https://${deps.domain}/${user.username}/${name}.git`,
        },
        201,
      );
    }

    // GET /api/v1/apps/:owner/:app — status.
    let m = path.match(/^\/api\/v1\/apps\/([^/]+)\/([^/]+)$/);
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
