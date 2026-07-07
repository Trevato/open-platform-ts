// Per-PR preview environments + copy-on-write data branches, end to end against
// real containers: a PR gets its own live URL whose data is a CoW clone of prod,
// isolated from prod, and torn down on merge. Docker-gated; kept off the M1 loop.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { resolveEngineSocket } from "@op/engine";
import { Platform } from "@op/opd";

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
      throw new Error(`timeout: ${what}`);
    await Bun.sleep(200);
  }
}

describe.skipIf(!sock)("per-PR preview environments + data branches", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(
    async () => {
      for (const fn of cleanup.reverse()) await fn().catch(() => {});
    },
    { timeout: 60_000 },
  );

  test("a PR gets a live preview whose data is a CoW clone of prod, torn down on merge", async () => {
    await Bun.spawn(["docker", "pull", "-q", "oven/bun:1-alpine"], {
      stdout: "ignore",
    }).exited;
    await mkdir(join(homedir(), ".op-e2e"), { recursive: true });
    const base = await mkdtemp(join(homedir(), ".op-e2e", "preview-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));

    const domain = "plat.localtest.me";
    const httpsPort = 28643;
    const platform = Result.unwrap(
      await Platform.up({
        root: join(base, "p"),
        domain,
        httpPort: 28642,
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
    const caFile = join(platform.sd.certsDir, "ca.crt");
    const api = `https://${domain}:${httpsPort}`;
    const admin = `Basic ${btoa(`plat:${platform.freshAdminPassword}`)}`;
    const app = "shop";
    const prodUrl = `https://${app}-plat.${domain}:${httpsPort}/`;
    const jsonGet = (url: string) =>
      fetch(url, { tls: { ca }, headers: { accept: "application/json" } });

    // Ship the app.
    expect(
      (
        await fetch(`${api}/api/v1/apps`, {
          method: "POST",
          tls: { ca },
          headers: { authorization: admin, "content-type": "application/json" },
          body: JSON.stringify({ name: app }),
        })
      ).status,
    ).toBe(201);
    await until("prod serving", 60_000, async () => {
      const r = await jsonGet(prodUrl);
      return r.ok ? true : null;
    });
    // Seed prod data: 4 visits.
    for (let i = 0; i < 3; i++) await jsonGet(prodUrl);
    const prodVisits = (
      (await (await jsonGet(prodUrl)).json()) as { visits: number }
    ).visits;
    expect(prodVisits).toBeGreaterThanOrEqual(4);

    // Push a feature branch (real git over smart-HTTP) and open a PR.
    const work = await mkdtemp(join(tmpdir(), "op-prev-"));
    cleanup.push(() => rm(work, { recursive: true, force: true }));
    const env = {
      ...process.env,
      GIT_SSL_CAINFO: caFile,
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = async (...a: string[]) => {
      const p = Bun.spawn(["git", ...a], {
        cwd: work,
        env,
        stdout: "ignore",
        stderr: "pipe",
      });
      if ((await p.exited) !== 0)
        throw new Error(`git ${a[0]}: ${await new Response(p.stderr).text()}`);
    };
    const cloneUrl = `https://plat:${platform.freshAdminPassword}@${domain}:${httpsPort}/plat/${app}.git`;
    await git("clone", "-q", cloneUrl, "src");
    const src = join(work, "src");
    await git("-C", src, "checkout", "-q", "-b", "feature");
    await writeFile(join(src, "MARKER"), "preview build\n");
    await git("-C", src, "add", "-A");
    await git(
      "-C",
      src,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "feature",
    );
    await git("-C", src, "push", "-q", "origin", "feature");

    const pr = await fetch(`${api}/api/v1/repos/plat/${app}/pulls`, {
      method: "POST",
      tls: { ca },
      headers: { authorization: admin, "content-type": "application/json" },
      body: JSON.stringify({ title: "preview", head: "feature" }),
    });
    expect(pr.status).toBe(201);
    const prNum = ((await pr.json()) as { number: number }).number;

    // The preview comes up with prod's data forked in.
    const previewUrl = `https://pr-${prNum}-${app}-plat.${domain}:${httpsPort}/`;
    const first = await until("preview serving", 60_000, async () => {
      const r = await jsonGet(previewUrl);
      return r.ok ? ((await r.json()) as { visits: number }) : null;
    });
    // First hit on the preview = prod's visit count + 1 (data was cloned).
    expect(first.visits).toBe(prodVisits + 1);

    // Preview writes DON'T touch prod (CoW isolation).
    for (let i = 0; i < 4; i++) await jsonGet(previewUrl);
    const prodAfter = (
      (await (await jsonGet(prodUrl)).json()) as { visits: number }
    ).visits;
    expect(prodAfter).toBe(prodVisits + 1); // only our single check-read above

    // Merge → preview + its data branch are torn down.
    expect(
      (
        await fetch(`${api}/api/v1/repos/plat/${app}/pulls/${prNum}/merge`, {
          method: "POST",
          tls: { ca },
          headers: { authorization: admin },
        })
      ).status,
    ).toBe(200);
    await until("preview torn down", 45_000, async () => {
      const r = await fetch(previewUrl, { tls: { ca } }).catch(() => null);
      return r === null || r.status === 404 ? true : null;
    });
  }, 240_000);
});
