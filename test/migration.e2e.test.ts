// App migration, end to end: a SELLER platform ships an app with live data,
// exports it as a portable artifact, and a separate CLIENT platform (its own
// sovereign instance, different key) ingests it and serves it — with the data
// intact. This is the "sell what you built; the buyer runs it themselves" loop.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { resolveEngineSocket } from "@op/engine";
import { Platform } from "@op/opd";

setDefaultTimeout(180_000);
const sock = resolveEngineSocket();

async function until<T>(
  what: string,
  deadlineMs: number,
  fn: () => Promise<T | null>,
): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const out = await fn().catch(() => null);
    if (out !== null) return out;
    if (performance.now() - t0 > deadlineMs)
      throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(150);
  }
}

async function makeUserWithPat(
  api: string,
  ca: string,
  adminAuth: string,
  username: string,
): Promise<{ api: string; ca: string; auth: string }> {
  const mk = await fetch(`${api}/api/v1/users`, {
    method: "POST",
    tls: { ca },
    headers: {
      authorization: `Basic ${btoa(adminAuth)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ username, password: "test-password-123" }),
  });
  expect(mk.status).toBe(201);
  const tok = await fetch(`${api}/api/v1/users/${username}/tokens`, {
    method: "POST",
    tls: { ca },
    headers: {
      authorization: `Basic ${btoa(adminAuth)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "e2e" }),
  });
  expect(tok.status).toBe(201);
  const { token } = (await tok.json()) as { token: string };
  return { api, ca, auth: `${username}:${token}` };
}

async function gitPush(
  creds: { api: string; ca: string; auth: string },
  app: string,
  caFile: string,
): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "op-mig-push-"));
  const [user] = creds.auth.split(":") as [string];
  const apiHost = new URL(creds.api).host;
  const cloneUrl = `https://${creds.auth}@${apiHost}/${user}/${app}.git`;
  const env = {
    ...process.env,
    GIT_SSL_CAINFO: caFile,
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (...argv: string[]) => {
    const p = Bun.spawn(["git", ...argv], {
      cwd: work,
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await p.exited) !== 0)
      throw new Error(
        `git ${argv[0]} failed: ${await new Response(p.stderr).text()}`,
      );
  };
  await git("clone", "-q", cloneUrl, "src");
  await writeFile(join(work, "src", "SHIPPED.md"), `shipped ${Date.now()}\n`);
  await git("-C", join(work, "src"), "add", "-A");
  await git(
    "-C",
    join(work, "src"),
    "-c",
    "user.email=e2e@test",
    "-c",
    "user.name=e2e",
    "commit",
    "-q",
    "-m",
    "ship",
  );
  await git("-C", join(work, "src"), "push", "-q", "origin", "main");
  await rm(work, { recursive: true, force: true });
}

// GET / of the app-template returns {app, visits}; visits is a sqlite counter,
// so it proves data state travelled the migration.
async function visit(
  host: string,
  httpsPort: number,
  ca: string,
): Promise<number> {
  const res = await fetch(`https://${host}:${httpsPort}/`, { tls: { ca } });
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { app: string; visits: number };
  return body.visits;
}

describe.skipIf(!sock)("app migration: seller → client, data intact", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }, 60_000);

  test("export an app on one platform, import it on another, data survives", async () => {
    const pull = Bun.spawn(["docker", "pull", "-q", "oven/bun:1-alpine"], {
      stdout: "ignore",
    });
    await pull.exited;
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(homedir(), ".op-e2e"), { recursive: true }),
    );
    const base = await mkdtemp(join(homedir(), ".op-e2e", "mig-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));

    const killContainers = (p: Platform) => async () => {
      const list = await p.engine.listPlatformContainers(p.platformId);
      if (list.status === "ok")
        for (const c of list.value) await p.engine.stopAndRemove(c.id);
    };

    // ── seller platform ──────────────────────────────────────────────────
    const seller = Result.unwrap(
      await Platform.up({
        root: join(base, "seller"),
        domain: "seller.localtest.me",
        httpPort: 28090,
        httpsPort: 28453,
        custodyAck: true,
      }),
    );
    cleanup.push(() => seller.stop());
    cleanup.push(killContainers(seller));
    const sellerApi = "https://seller.localtest.me:28453";
    const sellerCaFile = join(seller.sd.certsDir, "ca.crt");

    const ada = await makeUserWithPat(
      sellerApi,
      seller.caCertPem,
      `plat:${seller.freshAdminPassword}`,
      "ada",
    );
    const created = await fetch(`${sellerApi}/api/v1/apps`, {
      method: "POST",
      tls: { ca: ada.ca },
      headers: {
        authorization: `Basic ${btoa(ada.auth)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "widget" }),
    });
    expect(created.status).toBe(201);
    await gitPush(ada, "widget", sellerCaFile);

    // Serve it and accumulate real data state (visits climb, stored in sqlite).
    await until("seller widget to serve", 60_000, () =>
      visit("widget-ada.seller.localtest.me", 28453, ada.ca)
        .then((v) => (v >= 1 ? v : null))
        .catch(() => null),
    );
    for (let i = 0; i < 3; i++)
      await visit("widget-ada.seller.localtest.me", 28453, ada.ca);
    const sellerVisits = await visit(
      "widget-ada.seller.localtest.me",
      28453,
      ada.ca,
    );
    expect(sellerVisits).toBeGreaterThanOrEqual(4);

    // ── export ───────────────────────────────────────────────────────────
    const artifact = join(base, "widget.tar.gz");
    const exported = await seller.appExport("ada", "widget", artifact);
    expect(exported.status).toBe("ok");
    expect(Result.unwrap(exported).hasData).toBe(true);

    // ── client platform (separate sovereign instance) ────────────────────
    const client = Result.unwrap(
      await Platform.up({
        root: join(base, "client"),
        domain: "client.localtest.me",
        httpPort: 28091,
        httpsPort: 28454,
        custodyAck: true,
      }),
    );
    cleanup.push(() => client.stop());
    cleanup.push(killContainers(client));

    // Different sovereign keys — this really is a different platform.
    expect(client.key.identity).not.toBe(seller.key.identity);

    // ── import ───────────────────────────────────────────────────────────
    const imported = await client.appImport(artifact);
    expect(imported.status).toBe("ok");
    const { owner, app } = Result.unwrap(imported);
    expect(`${owner}/${app}`).toBe("ada/widget");

    // The client serves the app, and its visit counter CONTINUES from the
    // migrated value — the data travelled, it wasn't reset.
    const clientVisits = await until("client widget to serve", 60_000, () =>
      visit("widget-ada.client.localtest.me", 28454, client.caCertPem)
        .then((v) => (v >= 1 ? v : null))
        .catch(() => null),
    );
    expect(clientVisits).toBeGreaterThan(sellerVisits);
  }, 180_000);
});
