import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { ensureCa, Gate } from "@op/gate";
import { Store } from "@op/store";

// Hermetic: no DNS — we fetch 127.0.0.1 and route via the Host header, which
// Bun's fetch also uses for SNI + certificate hostname verification (so the
// wildcard leaf is fully validated against the CA on every request).
const DOMAIN = "op-test.localtest.me";

let ca = "";
let store: Store;
let upstream: ReturnType<typeof Bun.serve>;
let gate: Gate;
let httpsPort = 0;
let httpPort = 0;

const gfetch = (host: string, path: string, init: RequestInit = {}) =>
  fetch(`https://127.0.0.1:${httpsPort}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Host: host },
    redirect: "manual",
    tls: { ca },
  });

beforeAll(async () => {
  const certs = Result.unwrap(
    await ensureCa(mkdtempSync(join(tmpdir(), "op-gate-")), DOMAIN),
  );
  ca = certs.caCert;

  upstream = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      return Response.json({
        method: req.method,
        path: u.pathname,
        query: u.search,
        xPlatUser: req.headers.get("x-plat-user"),
        xPlatEvil: req.headers.get("x-plat-evil"),
        xfProto: req.headers.get("x-forwarded-proto"),
        xfHost: req.headers.get("x-forwarded-host"),
        body: await req.text(),
      });
    },
  });

  const upstreamPort = upstream.port ?? 0;
  store = new Store(":memory:");
  store.setHost(
    `public-alice.${DOMAIN}`,
    "alice",
    "public",
    "c1",
    upstreamPort,
  );
  store.setHost(`private-bob.${DOMAIN}`, "bob", "private", "c2", upstreamPort);

  gate = new Gate({
    store,
    domain: DOMAIN,
    httpPort: 0,
    httpsPort: 0,
    tls: { cert: certs.cert, key: certs.key },
    platformHandler: async () => new Response("platform-ok"),
    resolveUser: async (req) => {
      const auth = req.headers.get("authorization");
      if (auth === "Bearer bob-token") return { username: "bob" };
      if (auth === "Bearer alice-token") return { username: "alice" };
      return null;
    },
    authorizeApp: (user, owner, app) =>
      app === "public" ? true : user?.username === owner,
  });
  gate.start();
  httpsPort = gate.boundHttpsPort;
  httpPort = gate.boundHttpPort;
});

afterAll(() => {
  gate.stop();
  upstream.stop(true);
  store.close();
});

describe("platform host", () => {
  test("Host === domain hits platformHandler", async () => {
    const res = await gfetch(DOMAIN, "/anything");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("platform-ok");
  });

  test("Host port is stripped before matching", async () => {
    const res = await gfetch(`${DOMAIN}:${httpsPort}`, "/");
    expect(await res.text()).toBe("platform-ok");
  });
});

describe("app hosts", () => {
  test("anon on a public app proxies through; client X-Plat-* stripped", async () => {
    const res = await gfetch(`public-alice.${DOMAIN}`, "/hello?a=1", {
      headers: { "X-Plat-User": "forged-admin", "X-Plat-Evil": "1" },
    });
    expect(res.status).toBe(200);
    const echo = (await res.json()) as Record<string, unknown>;
    expect(echo["path"]).toBe("/hello");
    expect(echo["query"]).toBe("?a=1");
    expect(echo["xPlatUser"]).toBeNull();
    expect(echo["xPlatEvil"]).toBeNull();
    expect(echo["xfProto"]).toBe("https");
    expect(echo["xfHost"]).toBe(`public-alice.${DOMAIN}`);
  });

  test("authenticated user gets X-Plat-User injected (forgery overwritten)", async () => {
    const res = await gfetch(`private-bob.${DOMAIN}`, "/", {
      headers: { Authorization: "Bearer bob-token", "X-Plat-User": "forged" },
    });
    expect(res.status).toBe(200);
    const echo = (await res.json()) as Record<string, unknown>;
    expect(echo["xPlatUser"]).toBe("bob");
  });

  test("method, query and body are preserved", async () => {
    const res = await gfetch(`public-alice.${DOMAIN}`, "/submit?x=1&y=2", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello world",
    });
    const echo = (await res.json()) as Record<string, unknown>;
    expect(echo["method"]).toBe("POST");
    expect(echo["path"]).toBe("/submit");
    expect(echo["query"]).toBe("?x=1&y=2");
    expect(echo["body"]).toBe("hello world");
  });

  test("unknown host → 404", async () => {
    const res = await gfetch(`nope.${DOMAIN}`, "/");
    expect(res.status).toBe(404);
  });

  test("denied authenticated user → 403", async () => {
    const res = await gfetch(`private-bob.${DOMAIN}`, "/", {
      headers: { Authorization: "Bearer alice-token" },
    });
    expect(res.status).toBe(403);
  });

  test("denied anonymous → 302 to the platform login with next=", async () => {
    const res = await gfetch(`private-bob.${DOMAIN}`, "/secret?p=1");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith(`https://${DOMAIN}:${httpsPort}/login?next=`)).toBe(
      true,
    );
    const next = decodeURIComponent(loc.split("next=")[1] ?? "");
    expect(next).toInclude(`private-bob.${DOMAIN}`);
    expect(next).toInclude("/secret?p=1");
  });
});

describe("http → https redirect", () => {
  test("301 to https with the bound https port, path and query kept", async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/x/y?z=1`, {
      headers: { Host: `public-alice.${DOMAIN}` },
      redirect: "manual",
    });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(
      `https://public-alice.${DOMAIN}:${httpsPort}/x/y?z=1`,
    );
  });
});
