import { sha256Hex, type Log } from "@op/core";
import type { Forge } from "@op/forge";
import {
  discoveryDocument,
  jwksDocument,
  randomOauthCode,
  signAccessToken,
  signIdToken,
  verifyAccessToken,
  verifyPkceS256,
  type SigningKey,
} from "@op/identity";
import type { Store } from "@op/store";

const json = (body: unknown, status = 200) => Response.json(body, { status });

const CODE_TTL_SEC = 60;
const ID_TTL_SEC = 3600;
const ACCESS_TTL_SEC = 3600;

// The external origin the caller reached us on — the issuer. Browser (authorize)
// and app-server (token) both hit the same host:port, so deriving it per-request
// keeps iss consistent across local high-port dev and a real :443 deploy.
function issuerOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function clientCredsFrom(
  req: Request,
  body: URLSearchParams,
): { id: string; secret: string } | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(auth.slice(6).trim());
      const i = decoded.indexOf(":");
      if (i >= 0)
        return {
          id: decodeURIComponent(decoded.slice(0, i)),
          secret: decodeURIComponent(decoded.slice(i + 1)),
        };
    } catch {
      /* fall through to body */
    }
  }
  const id = body.get("client_id");
  const secret = body.get("client_secret");
  if (id && secret) return { id, secret };
  return null;
}

export type AuthzOutcome =
  | { kind: "code"; location: string } // redirect_uri?code=…&state=…
  | { kind: "back"; location: string } // redirect_uri?error=…&state=…
  | { kind: "error"; response: Response }; // unvalidated client/redirect

// Validate an authorization request and, for an already-authenticated user,
// mint a single-use code. Shared by GET /oauth/authorize (session read from the
// cookie) and the login handler (which authenticates in-process, dodging the
// SameSite-on-redirect fragility of re-reading the cookie at /authorize).
export function authorizeFor(
  store: Store,
  params: URLSearchParams,
  userId: string,
): AuthzOutcome {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const client = store.getClient(clientId);
  if (!client)
    return { kind: "error", response: errorPage("unknown client", 400) };
  const allowed = JSON.parse(client.redirect_uris) as string[];
  if (!allowed.includes(redirectUri))
    return {
      kind: "error",
      response: errorPage("redirect_uri not registered", 400),
    };

  const state = params.get("state") ?? "";
  const back = (p: Record<string, string>): AuthzOutcome => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...p, state }))
      u.searchParams.set(k, v);
    return { kind: "back", location: u.toString() };
  };
  if (params.get("response_type") !== "code")
    return back({ error: "unsupported_response_type" });
  const challenge = params.get("code_challenge") ?? "";
  if (!challenge || params.get("code_challenge_method") !== "S256")
    return back({
      error: "invalid_request",
      error_description: "PKCE S256 required",
    });

  const code = randomOauthCode();
  store.createCode({
    code,
    client_id: clientId,
    user_id: userId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    scope: params.get("scope") ?? "openid",
    nonce: params.get("nonce"),
    expires_at: Date.now() + CODE_TTL_SEC * 1000,
  });
  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  return { kind: "code", location: u.toString() };
}

// The OIDC provider — "Sign in with your platform." Every hosted app is a
// first-party client (auto-consent); PKCE is required on every code.
export function oidcRouter(deps: {
  forge: Forge;
  store: Store;
  key: SigningKey;
  log: Log;
}): (req: Request) => Promise<Response | null> {
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const issuer = issuerOf(url);

    if (path === "/.well-known/openid-configuration") {
      return json(discoveryDocument(issuer));
    }
    if (path === "/oauth/jwks") {
      return json(jwksDocument(deps.key));
    }

    // ── authorize ─────────────────────────────────────────────────────────
    if (path === "/oauth/authorize" && req.method === "GET") {
      // Must be a logged-in platform user; bounce through login, then resume.
      // The login handler completes the authorization in-process, so this
      // cookie-read path is only hit on a direct (already-signed-in) visit.
      const user = await deps.forge.authenticate(req);
      if (!user) {
        const next = url.pathname + url.search;
        return Response.redirect(
          `${issuer}/login?next=${encodeURIComponent(next)}`,
          303,
        );
      }
      const outcome = authorizeFor(deps.store, url.searchParams, user.id);
      if (outcome.kind === "error") return outcome.response;
      return Response.redirect(outcome.location, 303);
    }

    // ── token ───────────────────────────────────────────────────────────
    if (path === "/oauth/token" && req.method === "POST") {
      const body = new URLSearchParams(await req.text());
      if (body.get("grant_type") !== "authorization_code")
        return json({ error: "unsupported_grant_type" }, 400);

      const creds = clientCredsFrom(req, body);
      if (!creds) return json({ error: "invalid_client" }, 401);
      const client = deps.store.getClient(creds.id);
      if (!client || client.secret_hash !== (await sha256Hex(creds.secret)))
        return json({ error: "invalid_client" }, 401);

      const codeRow = deps.store.consumeCode(body.get("code") ?? "");
      if (!codeRow || codeRow.client_id !== creds.id)
        return json({ error: "invalid_grant" }, 400);
      if (codeRow.expires_at < Date.now())
        return json(
          { error: "invalid_grant", error_description: "code expired" },
          400,
        );
      if (codeRow.redirect_uri !== body.get("redirect_uri"))
        return json(
          {
            error: "invalid_grant",
            error_description: "redirect_uri mismatch",
          },
          400,
        );

      const verifier = body.get("code_verifier") ?? "";
      if (!(await verifyPkceS256(codeRow.code_challenge, verifier)))
        return json(
          {
            error: "invalid_grant",
            error_description: "PKCE verification failed",
          },
          400,
        );

      const subject = deps.store.getUserById(codeRow.user_id);
      const username = subject?.username ?? "";

      const idToken = await signIdToken(deps.key, {
        issuer,
        clientId: creds.id,
        sub: codeRow.user_id,
        username,
        ...(codeRow.nonce ? { nonce: codeRow.nonce } : {}),
        ttlSec: ID_TTL_SEC,
      });
      const accessToken = await signAccessToken(deps.key, {
        issuer,
        sub: codeRow.user_id,
        username,
        scope: codeRow.scope,
        ttlSec: ACCESS_TTL_SEC,
      });
      return json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_SEC,
        id_token: idToken,
        scope: codeRow.scope,
      });
    }

    // ── userinfo ──────────────────────────────────────────────────────────
    if (path === "/oauth/userinfo") {
      const auth = req.headers.get("authorization") ?? "";
      if (!auth.toLowerCase().startsWith("bearer "))
        return json({ error: "invalid_token" }, 401);
      const token = auth.slice(7).trim();
      const verified = await verifyAccessToken(token, deps.key, issuer);
      if (verified.status === "error")
        return json({ error: "invalid_token" }, 401);
      return json({
        sub: verified.value.sub,
        preferred_username: verified.value.username,
        name: verified.value.username,
      });
    }

    return null;
  };
}

function errorPage(message: string, status: number): Response {
  return new Response(`OAuth error: ${message}`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
