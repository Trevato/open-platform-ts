// Open Platform app template: zero npm dependencies, real data, "Sign in with
// your platform" (OIDC + PKCE), and app-to-app calls (peerFetch) — all on Bun
// built-ins. The UI lives in ./ui.ts: the platform console's design language
// as a handful of template-literal helpers. Declare extra needs (memory, raw
// TCP ports, assets, peers) in op.json at the repo root — see README.md.
//
// The platform injects: DATA_DIR, PORT, and (when signed in is wanted)
// OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI,
// OP_CA_FILE (trust the platform's own HTTPS), APP_SECRET (sign our session).
// op.json adds OP_PEER_<APP>_URL per consumed peer and OP_TCP_PORT_<port>
// per public TCP port.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  button,
  card,
  esc,
  html,
  layout,
  pageHeader,
  pill,
  stat,
} from "./ui.ts";

const dataDir = process.env.DATA_DIR ?? "/data";
const db = new Database(join(dataDir, "app.db"), { create: true });
db.exec(
  "PRAGMA journal_mode = WAL;" +
    "PRAGMA busy_timeout = 5000;" +
    "CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL)",
);

const ISSUER = process.env.OIDC_ISSUER;
const CLIENT_ID = process.env.OIDC_CLIENT_ID;
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI;
const APP_SECRET = process.env.APP_SECRET ?? "dev-secret";
const oidcEnabled = !!(ISSUER && CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);

// Trust the platform CA for the server-to-server token/userinfo/peer calls.
let caText: string | undefined;
if (process.env.OP_CA_FILE) {
  try {
    caText = await Bun.file(process.env.OP_CA_FILE).text();
  } catch {}
}
const tls = caText ? { ca: caText } : undefined;

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString(
    "base64url",
  );
const rand = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(s: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}
async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)),
  );
}

// Signed session cookie: "<username>.<hmac>". No server-side session store.
async function makeSession(username: string) {
  return `${encodeURIComponent(username)}.${await hmac(APP_SECRET, username)}`;
}
async function readSession(req: Request): Promise<string | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  if (!m) return null;
  const [user, sig] = decodeURIComponent(m).split(".");
  if (!user || !sig) return null;
  return (await hmac(APP_SECRET, user)) === sig ? user : null;
}

// PKCE verifiers awaiting their callback, keyed by state (single instance).
const pending = new Map<string, string>();

function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// ── app-to-app calls ─────────────────────────────────────────────────────────
// Declare peers in op.json `consumes` and the platform injects
// OP_PEER_<APP>_URL. peerFetch mints a client_credentials token from this
// app's own OIDC client, audience-bound to that one peer (RFC 8707 resource):
// the peer sees a verified `x-plat-user: app:<owner>/<app>` header, and the
// token is useless anywhere else.
const peerTokens = new Map<string, { token: string; refreshAt: number }>();

async function peerToken(origin: string): Promise<string> {
  const cached = peerTokens.get(origin);
  if (cached && Date.now() < cached.refreshAt) return cached.token;
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      resource: origin,
    }),
    ...(tls ? { tls } : {}),
  });
  if (!res.ok)
    throw new Error(
      `token mint for ${origin} failed: ${res.status} ${await res.text()}`,
    );
  const { access_token, expires_in } = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  peerTokens.set(origin, {
    token: access_token,
    refreshAt: Date.now() + (expires_in - 30) * 1000,
  });
  return access_token;
}

/** Call a peer app declared in op.json `consumes`. `name` is the peer's app
 *  name ("shop" reads OP_PEER_SHOP_URL). Absent or down peers answer 404/502
 *  — that's normal; handle it. */
export async function peerFetch(
  name: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const envName = `OP_PEER_${name.toUpperCase().replaceAll("-", "_")}_URL`;
  const base = process.env[envName];
  if (!base)
    throw new Error(
      `${envName} is not set — add {"app":"${name}"} to "consumes" in op.json`,
    );
  if (!ISSUER || !CLIENT_ID || !CLIENT_SECRET)
    throw new Error(
      "peerFetch needs OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET (platform-injected)",
    );
  const origin = new URL(base).origin;
  const call = async () => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await peerToken(origin)}`);
    return fetch(origin + path, { ...init, headers, ...(tls ? { tls } : {}) });
  };
  let res = await call();
  if (res.status === 401) {
    // Token went stale mid-lifetime (rotation, redeploy): mint fresh, retry once.
    peerTokens.delete(origin);
    res = await call();
  }
  return res;
}

Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    // Log every request so the platform's runtime-logs view shows live traffic.
    console.log(`${new Date().toISOString()} ${req.method} ${path}`);

    if (oidcEnabled && path === "/login") {
      const verifier = rand(32);
      const state = rand(16);
      pending.set(state, verifier);
      const challenge = b64url(await sha256(verifier));
      const a = new URL(`${ISSUER}/oauth/authorize`);
      a.searchParams.set("response_type", "code");
      a.searchParams.set("client_id", CLIENT_ID!);
      a.searchParams.set("redirect_uri", REDIRECT_URI!);
      a.searchParams.set("scope", "openid profile");
      a.searchParams.set("state", state);
      a.searchParams.set("code_challenge", challenge);
      a.searchParams.set("code_challenge_method", "S256");
      return Response.redirect(a.toString(), 303);
    }

    if (oidcEnabled && path === "/auth/callback") {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const verifier = pending.get(state);
      pending.delete(state);
      if (!code || !verifier)
        return new Response("bad callback", { status: 400 });
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI!,
        client_id: CLIENT_ID!,
        client_secret: CLIENT_SECRET!,
        code_verifier: verifier,
      });
      const tok = await fetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        ...(tls ? { tls } : {}),
      });
      if (!tok.ok)
        return new Response(`token exchange failed: ${await tok.text()}`, {
          status: 502,
        });
      const { access_token } = (await tok.json()) as { access_token: string };
      const ui = await fetch(`${ISSUER}/oauth/userinfo`, {
        headers: { authorization: `Bearer ${access_token}` },
        ...(tls ? { tls } : {}),
      });
      if (!ui.ok) return new Response("userinfo failed", { status: 502 });
      const { preferred_username } = (await ui.json()) as {
        preferred_username: string;
      };
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": cookie(
            "sid",
            await makeSession(preferred_username),
            3600,
          ),
        },
      });
    }

    if (path === "/logout") {
      return new Response(null, {
        status: 303,
        headers: { location: "/", "set-cookie": cookie("sid", "", 0) },
      });
    }

    // Home. Count a visit; answer JSON for machines, HTML for browsers.
    db.run("INSERT INTO visits (at) VALUES (?)", [new Date().toISOString()]);
    const visits = db.query("SELECT COUNT(*) AS n FROM visits").get() as {
      n: number;
    };
    const signedIn = oidcEnabled ? await readSession(req) : null;
    const platformUser = req.headers.get("x-plat-user");

    const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
    if (!wantsHtml) {
      return Response.json({
        app: process.env.OP_APP ?? "app",
        owner: process.env.OP_OWNER ?? null,
        user: platformUser,
        signedIn,
        visits: visits.n,
      });
    }

    const app = process.env.OP_APP ?? "app";
    const owner = process.env.OP_OWNER;
    const authCard = !oidcEnabled
      ? card(`<p class="mut m0">OIDC is not configured for this app.</p>`, {
          title: "Sign in",
          desc: "The platform injects OIDC_* env when it provisions your OAuth client.",
        })
      : signedIn
        ? card(
            `<p class="m0">Signed in as <b>${esc(signedIn)}</b> — verified by your platform; no password ever touches this app.</p>`,
            {
              title: "Sign in",
              footer: button("Sign out", {
                href: "/logout",
                variant: "ghost",
                small: true,
              }),
            },
          )
        : card(
            `<p class="mut m0">One click — your platform is the identity provider.</p>`,
            {
              title: "Sign in",
              footer: button("Sign in with your platform", { href: "/login" }),
            },
          );
    const body =
      pageHeader({
        title: app,
        sub: owner
          ? `${owner}'s app — fresh from the template`
          : "fresh from the template",
        // The gate verifies callers at the edge: humans as "alice",
        // peer apps as "app:<owner>/<app>". Anonymous is a real state too.
        actions: platformUser ? pill(platformUser, "ok") : pill("anonymous"),
      }) +
      `<div class="grid">` +
      stat({
        label: "Visits",
        value: visits.n,
        hint: "counted in /data/app.db",
      }) +
      stat({
        label: "Signed in",
        value: signedIn ?? "—",
        hint: signedIn ? "HMAC-signed session cookie" : "no session yet",
      }) +
      `</div>` +
      `<div class="mt">${authCard}</div>`;
    return html(layout({ title: app, user: signedIn, body }));
  },
});

console.log("app listening");
