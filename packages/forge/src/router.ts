import { isValidName } from "@op/core";
import type { GitHost } from "@op/git";
import type { UserRow } from "@op/store";
import type { ForgeError } from "./errors.ts";
import type { Forge } from "./forge.ts";

const ERROR_STATUS: Record<ForgeError["code"], number> = {
  conflict: 409,
  not_found: 404,
  unauthorized: 403,
  invalid: 400,
};

const WWW_AUTH = { "www-authenticate": 'Basic realm="op"' } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function fail(err: ForgeError): Response {
  return json(
    { error: err.code, message: err.message },
    ERROR_STATUS[err.code],
  );
}

function unauthorized(): Response {
  return new Response("authentication required", {
    status: 401,
    headers: WWW_AUTH,
  });
}

// password_hash never crosses the HTTP boundary.
function publicUser(u: UserRow): unknown {
  return {
    id: u.id,
    username: u.username,
    is_admin: u.is_admin,
    created_at: u.created_at,
  };
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const GIT_URL_RE = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;
const TOKENS_URL_RE = /^\/api\/v1\/users\/([^/]+)\/tokens$/;
const REPO_URL_RE = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)$/;

export function forgeRouter(
  forge: Forge,
  git: GitHost,
): (req: Request) => Promise<Response | null> {
  const userCount = (): number =>
    forge.store.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users")
      .get()?.n ?? 0;

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    const path = url.pathname;

    const gitMatch = path.match(GIT_URL_RE);
    if (gitMatch !== null) {
      const owner = gitMatch[1]!;
      const name = gitMatch[2]!;
      const sub = gitMatch[3] ?? "";
      if (!isValidName(owner) || !isValidName(name)) {
        return new Response("not found", { status: 404 });
      }
      const wantsReceivePack =
        (req.method === "GET" &&
          url.searchParams.get("service") === "git-receive-pack") ||
        (req.method === "POST" && sub === "/git-receive-pack");
      const user = await forge.authenticate(req);
      const perms = {
        read: forge.authorize(user, owner, name, "read"),
        write: forge.authorize(user, owner, name, "write"),
      };
      if (!(wantsReceivePack ? perms.write : perms.read)) {
        if (user === null) return unauthorized();
        return forge.store.getRepo(owner, name) !== null
          ? new Response("forbidden", { status: 403 })
          : new Response("not found", { status: 404 });
      }
      return git.handleSmartHttp(req, owner, name, perms);
    }

    if (path === "/api/v1/users" && req.method === "POST") {
      // First boot: an empty platform accepts one unauthenticated user, who
      // becomes the admin. Everything after that is admin-gated.
      const firstBoot = userCount() === 0;
      if (!firstBoot) {
        const caller = await forge.authenticate(req);
        if (caller === null) return unauthorized();
        if (caller.is_admin !== 1)
          return new Response("admin only", { status: 403 });
      }
      const b = await body(req);
      if (
        b === null ||
        typeof b["username"] !== "string" ||
        typeof b["password"] !== "string"
      ) {
        return json(
          { error: "invalid", message: "expected {username, password}" },
          400,
        );
      }
      const admin = firstBoot ? true : b["admin"] === true;
      const created = await forge.createUser(b["username"], b["password"], {
        admin,
      });
      if (created.status === "error") return fail(created.error);
      return json(publicUser(created.value), 201);
    }

    const tokensMatch = path.match(TOKENS_URL_RE);
    if (tokensMatch !== null && req.method === "POST") {
      const username = tokensMatch[1]!;
      const caller = await forge.authenticate(req);
      if (caller === null) return unauthorized();
      if (caller.username !== username && caller.is_admin !== 1) {
        return new Response("forbidden", { status: 403 });
      }
      const target =
        caller.username === username ? caller : forge.store.getUser(username);
      if (target === null)
        return json({ error: "not_found", message: "no such user" }, 404);
      const b = await body(req);
      if (b === null || typeof b["name"] !== "string") {
        return json({ error: "invalid", message: "expected {name}" }, 400);
      }
      const pat = await forge.createPat(target.id, b["name"]);
      if (pat.status === "error") return fail(pat.error);
      return json(pat.value, 201);
    }

    if (path === "/api/v1/repos" && req.method === "POST") {
      const caller = await forge.authenticate(req);
      if (caller === null) return unauthorized();
      const b = await body(req);
      if (b === null || typeof b["name"] !== "string") {
        return json({ error: "invalid", message: "expected {name}" }, 400);
      }
      if (typeof b["template"] === "string") {
        const [tplOwner, tplName, ...rest] = b["template"].split("/");
        if (
          tplOwner === undefined ||
          tplName === undefined ||
          rest.length > 0
        ) {
          return json(
            { error: "invalid", message: "template must be owner/name" },
            400,
          );
        }
        const created = await forge.createFromTemplate(
          caller,
          { owner: tplOwner, name: tplName },
          b["name"],
        );
        return created.status === "error"
          ? fail(created.error)
          : json(created.value, 201);
      }
      const created = await forge.createRepo(
        caller,
        caller.username,
        b["name"],
        {
          isTemplate: b["isTemplate"] === true,
        },
      );
      return created.status === "error"
        ? fail(created.error)
        : json(created.value, 201);
    }

    const repoMatch = path.match(REPO_URL_RE);
    if (repoMatch !== null && req.method === "GET") {
      const row = forge.store.getRepo(repoMatch[1]!, repoMatch[2]!);
      return row !== null
        ? json(row)
        : json({ error: "not_found", message: "no such repo" }, 404);
    }

    return null;
  };
}
