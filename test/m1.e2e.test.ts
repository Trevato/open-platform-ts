// M1: the full loop, shallow, timed. This test IS the product constraint —
// boot → user → push → build → run → serve → data → snapshot → seed →
// germinate a sovereign daughter → daughter does it all again. Soft budget
// 60s, hard 90s (per-phase hard = 3× its soft budget to absorb CI noise).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, Result } from "@op/core";
import { openAll, verifyAllSealed, type SecretsFile } from "@op/secrets";
import { readLineage } from "@op/mitosis";
import { resolveEngineSocket } from "@op/engine";
import { Platform, PlatformConfig, readSecretsFile, SYS } from "@op/opd";

// Every historical version of the daughter's sealed secrets, across ALL refs
// and history — the surface a public-read repo exposes to a key-compromise
// harvester. Sovereignty requires the mother's key to open NONE of them.
async function allHistoricalSecrets(
  gitopsBare: string,
): Promise<SecretsFile[]> {
  const rev = Bun.spawn(["git", "-C", gitopsBare, "rev-list", "--all"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const shas = (await new Response(rev.stdout).text())
    .split("\n")
    .filter(Boolean);
  const out: SecretsFile[] = [];
  for (const sha of shas) {
    const show = Bun.spawn(
      ["git", "-C", gitopsBare, "show", `${sha}:secrets.age.json`],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if ((await show.exited) !== 0) continue; // absent in this commit
    out.push(JSON.parse(await new Response(show.stdout).text()) as SecretsFile);
  }
  return out;
}

const sock = resolveEngineSocket();
const HARD_TOTAL_MS = Number(process.env["OP_E2E_HARD_MS"] ?? 90_000);
const SOFT_TOTAL_MS = 60_000;

const timings: Array<{ phase: string; ms: number; softMs: number }> = [];
async function phase<T>(
  name: string,
  softMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  const ms = performance.now() - t0;
  timings.push({ phase: name, ms: Math.round(ms), softMs });
  expect(
    ms,
    `phase '${name}' blew its hard budget (${softMs}×3 ms)`,
  ).toBeLessThan(softMs * 3);
  return out;
}

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

interface Creds {
  api: string;
  ca: string;
  auth: string; // user:pat
}

async function makeUserWithPat(
  api: string,
  ca: string,
  adminAuth: string,
  username: string,
): Promise<Creds> {
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

// One user journey: create app → clone → commit → push → app serves with data.
async function shipApp(
  c: Creds,
  opts: { app: string; host: string; httpsPort: number; caFile: string },
): Promise<void> {
  const created = await fetch(`${c.api}/api/v1/apps`, {
    method: "POST",
    tls: { ca: c.ca },
    headers: {
      authorization: `Basic ${btoa(c.auth)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: opts.app }),
  });
  expect(created.status).toBe(201);

  // Real git CLI over our smart-HTTP with our CA — the conformance that counts.
  const work = await mkdtemp(join(tmpdir(), "op-e2e-push-"));
  const [user] = c.auth.split(":") as [string];
  const apiHost = new URL(c.api).host;
  const cloneUrl = `https://${c.auth}@${apiHost}/${user}/${opts.app}.git`;
  const env = {
    ...process.env,
    GIT_SSL_CAINFO: opts.caFile,
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (...argv: string[]) => {
    const p = Bun.spawn(["git", ...argv], {
      cwd: work,
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await p.exited) !== 0) {
      throw new Error(
        `git ${argv[0]} failed: ${await new Response(p.stderr).text()}`,
      );
    }
  };
  await git("clone", "-q", cloneUrl, "src");
  await writeFile(
    join(work, "src", "SHIPPED.md"),
    `shipped by ${user} at ${Date.now()}\n`,
  );
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
    "e2e: ship",
  );
  await git("-C", join(work, "src"), "push", "-q", "origin", "main");
  await rm(work, { recursive: true, force: true });

  // Build+run+route: the app answers over HTTPS and proves a DB round-trip.
  const body = await until(`${opts.host} to serve`, 45_000, async () => {
    const res = await fetch(`https://${opts.host}:${opts.httpsPort}/`, {
      tls: { ca: c.ca },
    });
    if (res.status !== 200) return null;
    return (await res.json()) as { app: string; visits: number };
  });
  expect(body.app).toBe(opts.app);
  expect(body.visits).toBeGreaterThanOrEqual(1);
}

describe.skipIf(!sock)("M1: full loop under 60s", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(
    async () => {
      for (const fn of cleanup.reverse()) await fn().catch(() => {});
      const table = timings
        .map(
          (t) =>
            `  ${t.phase.padEnd(28)} ${String(t.ms).padStart(7)}ms (soft ${t.softMs}ms)`,
        )
        .join("\n");
      console.log(`\nM1 phase timings:\n${table}\n`);
    },
    { timeout: 60_000 },
  );

  test("mother → app → seed → sovereign daughter → app", async () => {
    // Untimed setup: pre-pull the template base image (cache-warm is the
    // promise; a cold pull is CI's problem, not the loop's).
    const pull = Bun.spawn(["docker", "pull", "-q", "oven/bun:1-alpine"], {
      stdout: "ignore",
    });
    await pull.exited;
    // Platform state must live under $HOME: VM-backed engines (colima,
    // Docker Desktop) only share $HOME with the VM, so a /var/folders tmpdir
    // bind-mounts as an unusable empty dir and the app crash-loops.
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(homedir(), ".op-e2e"), { recursive: true }),
    );
    const base = await mkdtemp(join(homedir(), ".op-e2e", "run-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));

    const t0 = performance.now();

    // 1. mother boots — zero containers, card-ready.
    const mother = await phase("mother: up", 4_000, async () =>
      Result.unwrap(
        await Platform.up({
          root: join(base, "mother"),
          domain: "plat.localtest.me",
          httpPort: 28080,
          httpsPort: 28443,
          custodyAck: true,
        }),
      ),
    );
    cleanup.push(() => mother.stop());
    cleanup.push(async () => {
      const list = await mother.engine.listPlatformContainers(
        mother.platformId,
      );
      if (list.status === "ok")
        for (const c of list.value) await mother.engine.stopAndRemove(c.id);
    });
    expect(mother.freshAdminPassword).toBeDefined();
    const motherApi = "https://plat.localtest.me:28443";
    const motherCaFile = join(mother.sd.certsDir, "ca.crt");
    const adminAuth = `plat:${mother.freshAdminPassword}`;

    // 2. user + PAT via the API.
    const ada = await phase("mother: user+pat", 1_500, () =>
      makeUserWithPat(motherApi, mother.caCertPem, adminAuth, "ada"),
    );

    // 3–5. create app, push with real git, serve with data round-trip.
    await phase("mother: ship app", 30_000, () =>
      shipApp(ada, {
        app: "hello",
        host: "hello-ada.plat.localtest.me",
        httpsPort: 28443,
        caFile: motherCaFile,
      }),
    );

    // 6. snapshot: checkpoint + clone + integrity_check via the API.
    await phase("mother: data snapshot", 3_000, async () => {
      const snap = await fetch(`${motherApi}/api/v1/apps/ada/hello/snapshots`, {
        method: "POST",
        tls: { ca: mother.caCertPem },
        headers: { authorization: `Basic ${btoa(ada.auth)}` },
      });
      expect(snap.status).toBe(201);
      expect(((await snap.json()) as { id: string }).id).toBeString();
    });

    // 6b. the deploy timeline recorded the ship (queued→building→built→running).
    await phase("mother: deploy events", 1_000, async () => {
      const res = await fetch(`${motherApi}/api/v1/apps/ada/hello/events`, {
        tls: { ca: mother.caCertPem },
        headers: { authorization: `Basic ${btoa(ada.auth)}` },
      });
      expect(res.status).toBe(200);
      const { events } = (await res.json()) as { events: { phase: string }[] };
      const phases = new Set(events.map((e) => e.phase));
      for (const p of ["queued", "building", "built", "running"])
        expect(phases).toContain(p);
    });

    // 7. seed — the genome, no key inside.
    const seedFile = join(base, "seed.tar.gz");
    await phase("mother: seed", 4_000, async () =>
      Result.unwrap(await mother.seed(seedFile)),
    );

    // 8. germinate a sovereign daughter on the same host (test-only shared engine).
    const daughter = await phase("daughter: germinate", 8_000, async () =>
      Result.unwrap(
        await Platform.germinate(seedFile, {
          root: join(base, "daughter"),
          domain: "d1.localtest.me",
          httpPort: 28081,
          httpsPort: 28444,
          custodyAck: true,
        }),
      ),
    );
    cleanup.push(() => daughter.stop());
    cleanup.push(async () => {
      const list = await daughter.engine.listPlatformContainers(
        daughter.platformId,
      );
      if (list.status === "ok")
        for (const c of list.value) await daughter.engine.stopAndRemove(c.id);
    });

    // 9. SOVEREIGNTY: fresh key; daughter seals verify; MOTHER'S KEY FAILS.
    await phase("sovereignty asserts", 2_000, async () => {
      expect(daughter.key.identity).not.toBe(mother.key.identity);
      expect(daughter.freshAdminPassword).not.toBe(mother.freshAdminPassword);
      const daughterSecrets = Result.unwrap(
        await readSecretsFile(daughter.git),
      );
      expect(
        (await verifyAllSealed(daughter.key.identity, daughterSecrets)).status,
      ).toBe("ok");
      const motherAttempt = await verifyAllSealed(
        mother.key.identity,
        daughterSecrets,
      );
      expect(motherAttempt.status).toBe("error"); // the negative test that matters

      // HISTORY, not just HEAD: a full-history seed would smuggle the mother's
      // prior secrets.age.json commits into the daughter's public repo. Prove
      // the mother key opens NOTHING across the daughter's entire git history.
      const gitopsBare = join(
        daughter.sd.reposDir,
        SYS.owner,
        `${SYS.name}.git`,
      );
      const historical = await allHistoricalSecrets(gitopsBare);
      expect(historical.length).toBeGreaterThan(0);
      for (const file of historical) {
        const opened = await openAll(mother.key.identity, file);
        expect(opened.status).toBe("error");
      }

      const lineage = await readLineage(daughter.sd.originFile);
      expect(lineage.join("\n")).toContain(
        "d1.localtest.me germinated-from plat.localtest.me",
      );

      // CREW LIVENESS: the genome must carry plat/platform (prompts + config)
      // or every daughter's build crew is dead on arrival.
      const daughterCfg = new PlatformConfig(daughter.git, createLog("e2e"));
      const builderAgent = await daughterCfg.loadAgent("builder");
      expect(builderAgent.status).toBe("ok");
      await daughterCfg.reload(); // platform.json admits (crew.model et al.)
      expect(daughterCfg.get().crew.model).toBe("claude-sonnet-5");
    });

    // 10. daughter runs the same journey — warm layer cache does the rest.
    const bob = await phase("daughter: user+pat", 1_500, () =>
      makeUserWithPat(
        "https://d1.localtest.me:28444",
        daughter.caCertPem,
        `plat:${daughter.freshAdminPassword}`,
        "bob",
      ),
    );
    await phase("daughter: ship app", 25_000, () =>
      shipApp(bob, {
        app: "hello",
        host: "hello-bob.d1.localtest.me",
        httpsPort: 28444,
        caFile: join(daughter.sd.certsDir, "ca.crt"),
      }),
    );

    const total = performance.now() - t0;
    timings.push({
      phase: "TOTAL",
      ms: Math.round(total),
      softMs: SOFT_TOTAL_MS,
    });
    expect(total, "M1 hard ceiling").toBeLessThan(HARD_TOTAL_MS);
    if (total > SOFT_TOTAL_MS) {
      console.warn(
        `M1 soft budget exceeded: ${Math.round(total)}ms > ${SOFT_TOTAL_MS}ms`,
      );
    }
  }, 300_000);
});
