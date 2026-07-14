// A repo with no Dockerfile on its deploy ref must WAIT, not error. This is the
// state a freshly-imported GitHub repo is in until the crew's PR adds a
// Dockerfile — previously the prod build failed "Cannot locate Dockerfile" on
// every reconcile and showed the app as broken. Now it parks in "pending" with
// a plain message and no failure noise.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { resolveEngineSocket } from "@op/engine";
import { Platform } from "@op/opd";

setDefaultTimeout(120_000);
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
    await Bun.sleep(300);
  }
}

describe.skipIf(!sock)("reconcile: no Dockerfile waits, never errors", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }, 60_000);

  test("removing the Dockerfile parks the app in pending, not error", async () => {
    const pull = Bun.spawn(["docker", "pull", "-q", "oven/bun:1-alpine"], {
      stdout: "ignore",
    });
    await pull.exited;
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(homedir(), ".op-e2e"), { recursive: true }),
    );
    const base = await mkdtemp(join(homedir(), ".op-e2e", "wait-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));

    const p = Result.unwrap(
      await Platform.up({
        root: join(base, "p"),
        domain: "wait.localtest.me",
        httpPort: 28095,
        httpsPort: 28458,
        custodyAck: true,
      }),
    );
    cleanup.push(() => p.stop());
    cleanup.push(async () => {
      const list = await p.engine.listPlatformContainers(p.platformId);
      if (list.status === "ok")
        for (const c of list.value) await p.engine.stopAndRemove(c.id);
    });

    const api = "https://wait.localtest.me:28458";
    const ca = p.caCertPem;
    const admin = `plat:${p.freshAdminPassword}`;
    const call = (path: string, init: RequestInit & { auth: string }) =>
      fetch(api + path, {
        ...init,
        tls: { ca },
        headers: {
          authorization: `Basic ${btoa(init.auth)}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    await call("/api/v1/users", {
      method: "POST",
      auth: admin,
      body: JSON.stringify({ username: "ada", password: "pw-123456" }),
    });
    const tok = (await (
      await call("/api/v1/users/ada/tokens", {
        method: "POST",
        auth: admin,
        body: JSON.stringify({ name: "e2e" }),
      })
    ).json()) as { token: string };
    const ada = `ada:${tok.token}`;

    // Create the template app and let it come up (it HAS a Dockerfile).
    expect(
      (
        await call("/api/v1/apps", {
          method: "POST",
          auth: ada,
          body: JSON.stringify({ name: "widget" }),
        })
      ).status,
    ).toBe(201);
    await until("widget running", 60_000, async () => {
      const apps = (await (
        await call("/api/v1/apps", { method: "GET", auth: ada })
      ).json()) as { apps: Array<{ app: string; state: string }> };
      const w = apps.apps.find((a) => a.app === "widget");
      return w && w.state === "running" ? true : null;
    });

    // Push a commit that REMOVES the Dockerfile from main.
    const work = await mkdtemp(join(tmpdir(), "op-wait-push-"));
    const env = {
      ...process.env,
      GIT_SSL_CAINFO: join(p.sd.certsDir, "ca.crt"),
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = async (...argv: string[]) => {
      const proc = Bun.spawn(["git", ...argv], {
        cwd: work,
        env,
        stdout: "ignore",
        stderr: "pipe",
      });
      if ((await proc.exited) !== 0)
        throw new Error(
          `git ${argv[0]}: ${await new Response(proc.stderr).text()}`,
        );
    };
    await git(
      "clone",
      "-q",
      `https://${ada}@wait.localtest.me:28458/ada/widget.git`,
      "src",
    );
    await rm(join(work, "src", "Dockerfile"), { force: true });
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
      "drop Dockerfile",
    );
    await git("-C", join(work, "src"), "push", "-q", "origin", "main");
    await rm(work, { recursive: true, force: true });

    // The app parks in "pending" with the waiting message — NOT error.
    const status = await until("widget to park pending", 40_000, async () => {
      const apps = (await (
        await call("/api/v1/apps", { method: "GET", auth: ada })
      ).json()) as {
        apps: Array<{ app: string; state: string; message: string | null }>;
      };
      const w = apps.apps.find((a) => a.app === "widget");
      return w && w.state === "pending" ? w : null;
    });
    expect(status.state).toBe("pending");
    expect(status.message ?? "").toContain("Waiting for a Dockerfile");

    // The timeline shows a "waiting" phase and NO "Cannot locate Dockerfile".
    const events = (await (
      await call("/api/v1/apps/ada/widget/events", { method: "GET", auth: ada })
    ).json()) as { events: Array<{ phase: string; message: string | null }> };
    expect(events.events.some((e) => e.phase.includes("waiting"))).toBe(true);
    expect(
      events.events.some((e) => (e.message ?? "").includes("Cannot locate")),
    ).toBe(false);
  }, 120_000);
});
