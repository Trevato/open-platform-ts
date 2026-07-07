import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, Result, stateDir } from "@op/core";
import { Forge } from "@op/forge";
import { GitHost } from "@op/git";
import { verifyIdToken } from "@op/identity";
import { Store } from "@op/store";
import { oidcRouter } from "../src/oidc.ts";
import { ensureSigningKey, provisionAppClient } from "../src/oidc-clients.ts";

const ISS = "https://plat.localtest.me:18443";
const APP_ORIGIN = "https://blog-ada.plat.localtest.me:18443";
const REDIRECT = `${APP_ORIGIN}/auth/callback`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "op-oidc-"));
  dirs.push(dir);
  const sd = stateDir(dir);
  const store = new Store(sd.dbFile);
  const git = new GitHost(sd, { log: createLog("t") });
  const forge = new Forge(store, git);
  const user = Result.unwrap(
    await forge.createUser("ada", "pw-123456", { admin: true }),
  );
  const session = forge.createSession(user.id);
  const key = await ensureSigningKey(sd);
  const client = await provisionAppClient(store, "ada", "blog", APP_ORIGIN);
  const router = oidcRouter({ forge, store, key, log: createLog("oidc") });
  return { router, key, user, session, client };
}

function pkce() {
  const verifier = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  return { verifier };
}
async function challengeOf(verifier: string) {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(new Uint8Array(d)).toString("base64url");
}

async function authorize(
  router: (r: Request) => Promise<Response | null>,
  opts: {
    cookie?: string;
    challenge: string;
    state: string;
    redirect?: string;
    clientId: string;
  },
) {
  const u = new URL(`${ISS}/oauth/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirect ?? REDIRECT);
  u.searchParams.set("scope", "openid profile");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return (await router(
    new Request(u, { headers: opts.cookie ? { cookie: opts.cookie } : {} }),
  ))!;
}

async function token(
  router: (r: Request) => Promise<Response | null>,
  body: Record<string, string>,
) {
  return (await router(
    new Request(`${ISS}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }),
  ))!;
}

describe("OIDC discovery + jwks", () => {
  test("discovery reflects the request origin; jwks omits the private key", async () => {
    const { router } = await harness();
    const d = await (await router(
      new Request(`${ISS}/.well-known/openid-configuration`),
    ))!.json();
    expect(d.issuer).toBe(ISS);
    expect(d.token_endpoint).toBe(`${ISS}/oauth/token`);
    const jwks = await (await router(new Request(`${ISS}/oauth/jwks`)))!.json();
    expect(jwks.keys[0].use).toBe("sig");
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });
});

describe("authorize", () => {
  test("bounces an unauthenticated user through login with a resume path", async () => {
    const { router, client } = await harness();
    const { verifier } = pkce();
    const res = await authorize(router, {
      challenge: await challengeOf(verifier),
      state: "st",
      clientId: client.clientId,
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("/login?next=");
    expect(decodeURIComponent(loc)).toContain("/oauth/authorize");
  });

  test("rejects an unregistered client and a bad redirect_uri without redirecting", async () => {
    const { router, session, client } = await harness();
    const cookie = `op_session=${session.id}`;
    const bad = await authorize(router, {
      cookie,
      challenge: "x",
      state: "s",
      clientId: "nope",
    });
    expect(bad.status).toBe(400);
    const badRedir = await authorize(router, {
      cookie,
      challenge: "x",
      state: "s",
      clientId: client.clientId,
      redirect: "https://evil.example/callback",
    });
    expect(badRedir.status).toBe(400);
  });

  test("issues a code to a logged-in user", async () => {
    const { router, session, client } = await harness();
    const { verifier } = pkce();
    const res = await authorize(router, {
      cookie: `op_session=${session.id}`,
      challenge: await challengeOf(verifier),
      state: "abc",
      clientId: client.clientId,
    });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("abc");
    expect(loc.searchParams.get("code")).toBeTruthy();
  });
});

describe("token + userinfo (full code exchange)", () => {
  async function getCode(
    h: Awaited<ReturnType<typeof harness>>,
    verifier: string,
  ) {
    const res = await authorize(h.router, {
      cookie: `op_session=${h.session.id}`,
      challenge: await challengeOf(verifier),
      state: "s",
      clientId: h.client.clientId,
    });
    return new URL(res.headers.get("location")!).searchParams.get("code")!;
  }

  test("exchanges a code for a valid id_token + access_token", async () => {
    const h = await harness();
    const { verifier } = pkce();
    const code = await getCode(h, verifier);
    const res = await token(h.router, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: h.client.clientId,
      client_secret: h.client.clientSecret,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id_token: string;
      access_token: string;
      token_type: string;
    };
    expect(body.token_type).toBe("Bearer");

    const claims = Result.unwrap(
      await verifyIdToken(body.id_token, h.key, {
        issuer: ISS,
        audience: h.client.clientId,
      }),
    );
    expect(claims.sub).toBe(h.user.id);
    expect(claims.username).toBe("ada");

    const ui = await (await h.router(
      new Request(`${ISS}/oauth/userinfo`, {
        headers: { authorization: `Bearer ${body.access_token}` },
      }),
    ))!;
    expect(ui.status).toBe(200);
    expect(
      ((await ui.json()) as { preferred_username: string }).preferred_username,
    ).toBe("ada");
  });

  test("rejects a wrong PKCE verifier", async () => {
    const h = await harness();
    const { verifier } = pkce();
    const code = await getCode(h, verifier);
    const res = await token(h.router, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: h.client.clientId,
      client_secret: h.client.clientSecret,
      code_verifier: "the-wrong-verifier",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("a code is single-use", async () => {
    const h = await harness();
    const { verifier } = pkce();
    const code = await getCode(h, verifier);
    const args = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: h.client.clientId,
      client_secret: h.client.clientSecret,
      code_verifier: verifier,
    };
    expect((await token(h.router, args)).status).toBe(200);
    expect((await token(h.router, args)).status).toBe(400); // replay rejected
  });

  test("rejects a wrong client secret", async () => {
    const h = await harness();
    const { verifier } = pkce();
    const code = await getCode(h, verifier);
    const res = await token(h.router, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: h.client.clientId,
      client_secret: "op_cs_wrong",
      code_verifier: verifier,
    });
    expect(res.status).toBe(401);
  });
});
