// Console e2e: boot a platform, exercise orgs + issue-deps + the import control
// over the REAL server-rendered console (Basic-auth'd fetches), and assert the
// refreshed shadcn design tokens are present. Proves the UI wiring end to end.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir as _h } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { resolveEngineSocket } from "@op/engine";
import { Platform } from "@op/opd";

setDefaultTimeout(120_000);
const sock = resolveEngineSocket();

describe.skipIf(!sock)("console: orgs, deps, design", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }, 60_000);

  test("renders orgs, blocked-by pills, import control, and shadcn tokens", async () => {
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(_h() + "/.op-e2e", { recursive: true }),
    );
    const base = await mkdtemp(join(_h(), ".op-e2e", "console-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));

    const p = Result.unwrap(
      await Platform.up({
        root: join(base, "p"),
        domain: "console.localtest.me",
        httpPort: 28096,
        httpsPort: 28459,
        custodyAck: true,
      }),
    );
    cleanup.push(() => p.stop());
    const api = "https://console.localtest.me:28459";
    const ca = p.caCertPem;
    const admin = `plat:${p.freshAdminPassword}`;

    const post = (path: string, body: unknown, auth = admin) =>
      fetch(api + path, {
        method: "POST",
        tls: { ca },
        headers: {
          authorization: `Basic ${btoa(auth)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const getHtml = (path: string, auth = admin) =>
      fetch(api + path, {
        tls: { ca },
        headers: { authorization: `Basic ${btoa(auth)}` },
      });

    // A user, an org, and an app owned by the org.
    expect(
      (await post("/api/v1/users", { username: "ada", password: "pw-123456" }))
        .status,
    ).toBe(201);
    const patRes = await post("/api/v1/users/ada/tokens", { name: "e2e" });
    const { token } = (await patRes.json()) as { token: string };
    const ada = `ada:${token}`;
    expect(
      (
        await post(
          "/api/v1/orgs",
          { name: "acme", displayName: "Acme Inc" },
          ada,
        )
      ).status,
    ).toBe(201);
    expect(
      (await post("/api/v1/apps", { name: "store", owner: "acme" }, ada))
        .status,
    ).toBe(201);

    // Two issues on the app, one blocked by the other.
    const i1 = (await (
      await post(
        "/api/v1/repos/acme/store/issues",
        { title: "ship checkout" },
        ada,
      )
    ).json()) as { number: number };
    const i2 = (await (
      await post("/api/v1/repos/acme/store/issues", { title: "add cart" }, ada)
    ).json()) as { number: number };
    expect(
      (
        await post(
          `/api/v1/repos/acme/store/issues/${i1.number}/deps`,
          { blockedBy: i2.number },
          ada,
        )
      ).status,
    ).toBe(200);

    // ── console renders ──────────────────────────────────────────────────
    const dash = await getHtml("/", ada);
    expect(dash.status).toBe(200);
    const dashHtml = await dash.text();
    expect(dashHtml).toContain("Import from GitHub");
    // The on-ramp leads: describe-a-workflow box + starter chips.
    expect(dashHtml).toContain("Build my tool");
    expect(dashHtml).toContain("Vacation requests");
    // shadcn design language landed: OKLCH tokens + the ring variable.
    expect(dashHtml).toContain("oklch");
    expect(dashHtml).toContain("--ring");

    const orgsPage = await getHtml("/orgs", ada);
    expect(orgsPage.status).toBe(200);
    expect(await orgsPage.text()).toContain("acme");

    const orgPage = await getHtml("/orgs/acme", ada);
    expect(orgPage.status).toBe(200);
    const orgHtml = await orgPage.text();
    expect(orgHtml).toContain("Acme Inc");
    expect(orgHtml).toContain("store"); // the org's software shows up

    // The blocked issue surfaces its open blocker via the list API the console
    // consumes (the pill is rendered client-side from openBlockers).
    const issues = (await (
      await getHtml("/api/v1/repos/acme/store/issues", ada)
    ).json()) as {
      issues: Array<{ number: number; openBlockers: number[] }>;
    };
    const blocked = issues.issues.find((i) => i.number === i1.number)!;
    expect(blocked.openBlockers).toEqual([i2.number]);

    // ── on-ramp: describe a workflow → app + first build in one call ──────
    // (No Claude token here, so the composer is offline; the endpoint still
    // names the app, deploys it, and files the raw description as agent-work.)
    const on = await post(
      "/api/v1/onramp",
      {
        description:
          "I keep track of client intake forms and follow up after three days",
      },
      ada,
    );
    expect(on.status).toBe(201);
    const onres = (await on.json()) as {
      owner: string;
      app: string;
      issue: number;
    };
    expect(onres.owner).toBe("ada");
    // Name was derived from the description (filler words dropped), not "app".
    expect(onres.app).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(onres.app).not.toBe("tool");
    // The first build was filed as agent-work on the new app.
    const filed = (await (
      await getHtml(`/api/v1/repos/ada/${onres.app}/issues/${onres.issue}`, ada)
    ).json()) as { labels: string };
    expect(filed.labels.split(",")).toContain("agent-work");
  }, 120_000);
});
