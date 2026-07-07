// Open Platform app template: zero npm dependencies, one file, real data, and
// "Sign in with your platform" (OIDC + PKCE) — all on Bun built-ins.
//
// The platform injects: DATA_DIR, PORT, and (when signed in is wanted)
// OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI,
// OP_CA_FILE (trust the platform's own HTTPS), APP_SECRET (sign our session).
import { Database } from "bun:sqlite";
import { join } from "node:path";

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

// Trust the platform CA for the server-to-server token/userinfo calls.
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
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const [user, sig] = decodeURIComponent(m[1]).split(".");
  if (!user || !sig) return null;
  return (await hmac(APP_SECRET, user)) === sig ? user : null;
}

// PKCE verifiers awaiting their callback, keyed by state (single instance).
const pending = new Map<string, string>();

function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

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

    const auth = !oidcEnabled
      ? `<p class="muted">OIDC not configured for this app.</p>`
      : signedIn
        ? `<p>Signed in as <b>${signedIn}</b> — via your platform. <a href="/logout">Sign out</a></p>`
        : `<p><a class="btn" href="/login">Sign in with your platform</a></p>`;
    return new Response(
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${process.env.OP_APP ?? "app"}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:34rem;margin:14vh auto;padding:0 1.4rem;
background:#0b0d0e;color:#e6edef}h1{font-weight:640}.muted{color:#8b9599}b{color:#3fb950}
.btn{display:inline-block;background:#2ea043;color:#04140a;padding:.6rem 1rem;border-radius:8px;font-weight:600;text-decoration:none}
code{font-family:ui-monospace,monospace;color:#8b9599}</style>
<h1>${process.env.OP_APP ?? "app"}</h1>
${auth}
<p class="muted">Served from your own data directory · <code>${visits.n}</code> visits.</p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});

console.log("app listening");
