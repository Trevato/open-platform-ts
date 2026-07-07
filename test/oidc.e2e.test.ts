// OIDC end-to-end: a hosted app signs a user in "with the platform", exercising
// the whole loop including the app container's server-to-server token exchange
// (host-gateway + mounted CA) — the integration curl-alone can't prove. Gated on
// docker; kept apart from the M1 <60s loop so a host-gateway hiccup never reddens it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Result } from "@op/core";
import { resolveEngineSocket } from "@op/engine";
import { Platform } from "@op/opd";

const sock = resolveEngineSocket();

function cookieFrom(res: Response, name: string): string | null {
  const set = res.headers.get("set-cookie") ?? "";
  const m = set.match(new RegExp(`${name}=([^;]+)`));
  return m ? `${name}=${m[1]}` : null;
}

describe.skipIf(!sock)("OIDC: sign in with your platform", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(
    async () => {
      for (const fn of cleanup.reverse()) await fn().catch(() => {});
    },
    { timeout: 60_000 },
  );

  test("hosted app authenticates a user through the platform", async () => {
    await Bun.spawn(["docker", "pull", "-q", "oven/bun:1-alpine"], {
      stdout: "ignore",
    }).exited;
    await mkdir(join(homedir(), ".op-e2e"), { recursive: true });
    const base = await mkdtemp(join(homedir(), ".op-e2e", "oidc-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));

    const domain = "plat.localtest.me";
    const httpsPort = 28543;
    const platform = Result.unwrap(
      await Platform.up({
        root: join(base, "p"),
        domain,
        httpPort: 28542,
        httpsPort,
        custodyAck: true,
      }),
    );
    cleanup.push(() => platform.stop());
    cleanup.push(async () => {
      const list = await platform.engine.listPlatformContainers(
        platform.platformId,
      );
      if (list.status === "ok")
        for (const c of list.value) await platform.engine.stopAndRemove(c.id);
    });
    const ca = platform.caCertPem;
    const api = `https://${domain}:${httpsPort}`;
    const admin = `Basic ${btoa(`plat:${platform.freshAdminPassword}`)}`;

    // Create an app; wait for it to serve.
    const created = await fetch(`${api}/api/v1/apps`, {
      method: "POST",
      tls: { ca },
      headers: { authorization: admin, "content-type": "application/json" },
      body: JSON.stringify({ name: "acct" }),
    });
    expect(created.status).toBe(201);
    const appBase = `https://acct-plat.${domain}:${httpsPort}`;
    for (let i = 0; ; i++) {
      const r = await fetch(`${appBase}/`, {
        tls: { ca },
        headers: { accept: "application/json" },
      }).catch(() => null);
      if (r?.ok) break;
      if (i > 200) throw new Error("app never served");
      await Bun.sleep(150);
    }

    // Walk the OIDC dance by hand (no browser): app/login → authorize → platform
    // login (which completes authz in-process) → app callback → signed-in.
    const noFollow = { tls: { ca }, redirect: "manual" as const };
    const r1 = await fetch(`${appBase}/login`, noFollow);
    const authzUrl = r1.headers.get("location")!;
    expect(authzUrl).toContain("/oauth/authorize");

    const r2 = await fetch(authzUrl, noFollow);
    const loginUrl = r2.headers.get("location")!;
    expect(loginUrl).toContain("/login?next=");

    const r3 = await fetch(loginUrl, {
      ...noFollow,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "plat",
        password: platform.freshAdminPassword ?? "",
      }),
    });
    const callbackUrl = r3.headers.get("location")!;
    // Login completes authorization inline → straight to the app callback.
    expect(callbackUrl).toContain(`acct-plat.${domain}`);
    expect(callbackUrl).toContain("/auth/callback?code=");

    // The app exchanges the code server-to-server (the hard part) and sets a session.
    const r4 = await fetch(callbackUrl, noFollow);
    expect(r4.status).toBe(303);
    const sid = cookieFrom(r4, "sid");
    expect(sid).toBeTruthy();

    const me = await fetch(`${appBase}/`, {
      tls: { ca },
      headers: { accept: "application/json", cookie: sid! },
    });
    expect(((await me.json()) as { signedIn: string | null }).signedIn).toBe(
      "plat",
    );
  }, 180_000);
});
