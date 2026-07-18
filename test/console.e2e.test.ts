// Console e2e: boot a platform, exercise orgs + issue-deps + the import control
// over the REAL server-rendered console (Basic-auth'd fetches), and assert the
// refreshed shadcn design tokens are present. Proves the UI wiring end to end.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir as _h } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { resolveEngineSocket } from "@op/engine";
import { Platform, readAdminPassword } from "@op/opd";

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

    // Two work items on the app, one blocked by the other (the /work family).
    const i1 = (await (
      await post(
        "/api/v1/repos/acme/store/work",
        { title: "ship checkout" },
        ada,
      )
    ).json()) as { number: number };
    const i2 = (await (
      await post("/api/v1/repos/acme/store/work", { title: "add cart" }, ada)
    ).json()) as { number: number };
    expect(
      (
        await post(
          `/api/v1/repos/acme/store/work/${i1.number}/deps`,
          { on: `acme/store#${i2.number}` },
          ada,
        )
      ).status,
    ).toBe(201);

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

    // The app page carries the ONE Work tab (the Issues/PRs twins are gone).
    const appPage = await getHtml("/apps/acme/store", ada);
    expect(appPage.status).toBe(200);
    const appHtml = await appPage.text();
    expect(appHtml).toContain('data-pane="work"');
    expect(appHtml).not.toContain('data-pane="issues"');
    expect(appHtml).not.toContain('data-pane="prs"');

    // The blocked item surfaces its open blocker via the work list the console
    // consumes (the pill is rendered client-side from blockedBy).
    const work = (await (
      await getHtml("/api/v1/repos/acme/store/work", ada)
    ).json()) as {
      work: Array<{ number: number; blockedBy: Array<{ number: number }> }>;
    };
    const blocked = work.work.find((i) => i.number === i1.number)!;
    expect(blocked.blockedBy.map((b) => b.number)).toEqual([i2.number]);

    // One-release compat: /issues reads the SAME rows and maps the same deps.
    const issues = (await (
      await getHtml("/api/v1/repos/acme/store/issues", ada)
    ).json()) as {
      issues: Array<{ number: number; openBlockers: number[] }>;
    };
    expect(
      issues.issues.find((i) => i.number === i1.number)!.openBlockers,
    ).toEqual([i2.number]);

    // ── crew queue: 'migrated' parks are residue, not a human ask ─────────
    // Reproduce the schema migration (raw SQL, as the migration does): one item
    // parked 'migrated', one parked for a real reason. Only the real one may
    // count toward the "N parked — need you" alarm.
    p.store.db.run(
      "UPDATE issues SET phase='parked', state='open', parked_reason='migrated' WHERE owner='acme' AND repo='store' AND number=?",
      [i1.number],
    );
    p.store.db.run(
      "UPDATE issues SET phase='parked', state='open', parked_reason='build-failed' WHERE owner='acme' AND repo='store' AND number=?",
      [i2.number],
    );
    const crew = (await (await getHtml("/api/v1/crew")).json()) as {
      blocked: number;
      items: Array<{ number: number; parkedReason: string | null }>;
    };
    expect(crew.items.some((i) => i.parkedReason === "migrated")).toBe(false);
    expect(crew.items.some((i) => i.number === i2.number)).toBe(true); // the genuine build-failed park is still surfaced
    expect(crew.blocked).toBe(
      crew.items.filter((i) => i.parkedReason !== "migrated").length,
    );

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
    // The first build was filed as agent-work on the new app — and BORN at
    // phase `queued` (the label is the verb; phase is the process truth).
    const filed = (await (
      await getHtml(`/api/v1/repos/ada/${onres.app}/issues/${onres.issue}`, ada)
    ).json()) as { labels: string };
    expect(filed.labels.split(",")).toContain("agent-work");
    const filedWork = (await (
      await getHtml(`/api/v1/repos/ada/${onres.app}/work/${onres.issue}`, ada)
    ).json()) as { phase: string };
    expect(filedWork.phase).toBe("queued");

    // Legacy issue URLs redirect to the one work surface.
    const rd = await fetch(
      api + `/apps/ada/${onres.app}/issues/${onres.issue}`,
      {
        tls: { ca },
        redirect: "manual",
        headers: { authorization: `Basic ${btoa(ada)}` },
      },
    );
    expect(rd.status).toBe(303);
    expect(rd.headers.get("location")).toBe(
      `/apps/ada/${onres.app}/work/${onres.issue}`,
    );
  }, 120_000);

  // ── the docs surface: public reading, machine mirrors, blob viewer, guide ─
  test("serves the manual, its machine mirrors, and the source viewer", async () => {
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(_h() + "/.op-e2e", { recursive: true }),
    );
    const base = await mkdtemp(join(_h(), ".op-e2e", "docs-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));

    const p = Result.unwrap(
      await Platform.up({
        root: join(base, "p"),
        domain: "docs.localtest.me",
        httpPort: 28097,
        httpsPort: 28460,
        custodyAck: true,
      }),
    );
    cleanup.push(() => p.stop());
    const api = "https://docs.localtest.me:28460";
    const ca = p.caCertPem;
    const admin = `plat:${p.freshAdminPassword}`;

    // `op admin-password` recovers the same password the boot card printed —
    // the way back when the card was missed.
    expect(p.freshAdminPassword).toBeString();
    expect(Result.unwrap(await readAdminPassword(join(base, "p")))).toBe(
      p.freshAdminPassword!,
    );

    const get = (path: string, auth?: string) =>
      fetch(api + path, {
        tls: { ca },
        ...(auth
          ? { headers: { authorization: `Basic ${btoa(auth)}` } }
          : { redirect: "manual" as const }),
      });

    // Docs are PUBLIC: an anonymous reader gets the page, with sign-in chrome.
    const anon = await get("/docs/quickstart");
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain('class="docs"');
    expect(anonHtml).toContain("Sign in");
    expect(anonHtml).not.toContain('id="gopen"'); // no session, no Ask

    // Signed in: the three-pane page with nav state, TOC, search palette.
    const authed = await get("/docs/quickstart", admin);
    const html = await authed.text();
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("dtoc-list");
    expect(html).toContain("dsearch-veil");
    expect(html).toContain('href="/docs"'); // Docs lives in the header nav
    // plat/opd is NOT hosted here, so code references render as plain code —
    // never a dead link. (Shape, not a specific anchor: the truth checker
    // owns anchors and corrects them as the source moves.)
    expect(html).toMatch(/<code>packages\/[^<]+\.ts:\d+<\/code>/);
    expect(html).not.toContain('class="code-ref"');

    // Machine mirrors: raw page, llms index, search index.
    const md = await get("/docs/quickstart.md");
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("# Quickstart");
    expect(await (await get("/docs/llms.txt")).text()).toContain(
      "/docs/quickstart.md",
    );
    const idx = (await (await get("/docs/search.json")).json()) as {
      pages: Array<{ slug: string }>;
    };
    expect(idx.pages.some((pg) => pg.slug === "quickstart")).toBe(true);

    // The blob viewer renders any readable repo file with line anchors —
    // plat/platform ships on every boot, so its docs manifest is a sure target.
    const blob = await get(
      "/apps/plat/platform/blob/main/docs/docs.json",
      admin,
    );
    expect(blob.status).toBe(200);
    const blobHtml = await blob.text();
    expect(blobHtml).toContain('class="blob mono"');
    expect(blobHtml).toContain('id="L1"');
    // Anonymous blob reads bounce to login (the console auth gate).
    expect(
      (await get("/apps/plat/platform/blob/main/docs/docs.json")).status,
    ).toBe(303);

    // The guide endpoint: 503 without a Claude credential, 400 on an empty
    // conversation when credentialed — never a silent hang.
    const g = await fetch(api + "/api/v1/guide", {
      method: "POST",
      tls: { ca },
      headers: {
        authorization: `Basic ${btoa(admin)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages: [] }),
    });
    expect(g.status).toBe(process.env["CLAUDE_CODE_OAUTH_TOKEN"] ? 400 : 503);
  }, 120_000);
});
