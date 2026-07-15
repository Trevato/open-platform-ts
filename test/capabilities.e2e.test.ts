// Capabilities end-to-end: an app's op.json actually shapes its runtime —
// resources reach the container, a declared TCP port is publicly reachable
// through the TcpGate relay (sticky across redeploys), and an out-of-policy
// manifest fails the deploy visibly WITHOUT touching the running container.
// Assets are covered by unit tests (packages/opd/test/assets.test.ts) — their
// https+allowlist path can't be exercised against a local self-signed server
// without weakening the platform's TLS posture; the live-platform demo covers
// the real Mojang fetch. Gated on docker, like every e2e here.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Result } from "@op/core";
import { resolveEngineSocket } from "@op/engine";
import { Platform } from "@op/opd";

const sock = resolveEngineSocket();

async function until<T>(
  what: string,
  ms: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => null);
    if (v !== null) return v;
    await Bun.sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function tcpEcho(port: number, message: string): Promise<string> {
  return new Promise((resolveData, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () =>
      socket.write(message),
    );
    socket.on("data", (buf) => {
      resolveData(buf.toString());
      socket.end();
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("tcp echo timeout")), 8_000).unref();
  });
}

// An app that serves HTTP on PORT and echoes on a raw TCP port — the minimal
// minecraft-shaped workload.
const TCP_APP = `import { createServer } from "node:net";
const PORT = Number(process.env.PORT ?? 8080);
createServer((s) => s.on("data", (b) => s.write("echo:" + b.toString()))).listen(7777);
Bun.serve({ port: PORT, fetch: () => Response.json({ app: process.env.OP_APP, tcp: process.env.OP_TCP_PORT_7777 ?? null }) });
console.log("up");
`;

describe.skipIf(!sock)("capabilities: op.json shapes the runtime", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterAll(
    async () => {
      for (const fn of cleanup.reverse()) await fn().catch(() => {});
    },
    { timeout: 90_000 },
  );

  test("resources + tcpPorts deploy; bad manifest fails closed", async () => {
    await mkdir(join(homedir(), ".op-e2e"), { recursive: true });
    const base = await mkdtemp(join(homedir(), ".op-e2e", "caps-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));

    const domain = "plat.localtest.me";
    const httpsPort = 28553;
    const platform = Result.unwrap(
      await Platform.up({
        root: join(base, "p"),
        domain,
        httpPort: 28552,
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
    const admin = `plat:${platform.freshAdminPassword}`;
    const caFile = join(base, "p", "certs", "ca.crt");

    // Give this instance its OWN public-TCP range so it never fights another
    // platform for a real host port (the loopback HTTP ports are OS-assigned,
    // but public TCP ports are fixed — a live platform on the same box uses
    // the genesis default 25500-25599). Commit it to plat/platform OVER
    // smart-HTTP so the push hook fires and hot-reloads the policy; a direct
    // bare-repo push wouldn't emit the event.
    const cfgWork = await mkdtemp(join(tmpdir(), "op-caps-cfg-"));
    cleanup.push(() => rm(cfgWork, { recursive: true, force: true }));
    const cfgEnv = {
      ...process.env,
      GIT_SSL_CAINFO: caFile,
      GIT_TERMINAL_PROMPT: "0",
    };
    const cfgGit = async (...argv: string[]) => {
      await Bun.spawn(["git", ...argv], {
        cwd: cfgWork,
        env: cfgEnv,
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    };
    await cfgGit(
      "clone",
      "-q",
      `https://${admin}@${domain}:${httpsPort}/plat/platform.git`,
      "cfg",
    );
    const cfgDir = join(cfgWork, "cfg");
    const cfg = JSON.parse(
      await Bun.file(join(cfgDir, "platform.json")).text(),
    );
    cfg.apps = { ...(cfg.apps ?? {}), tcpPortRange: [27700, 27799] };
    await Bun.write(
      join(cfgDir, "platform.json"),
      JSON.stringify(cfg, null, 2),
    );
    await cfgGit("-C", cfgDir, "add", "-A");
    await cfgGit(
      "-C",
      cfgDir,
      "-c",
      "user.email=e2e@test",
      "-c",
      "user.name=e2e",
      "commit",
      "-q",
      "-m",
      "test: isolated tcp range",
    );
    await cfgGit("-C", cfgDir, "push", "-q", "origin", "main");
    // The reload is fire-and-forget on the push hook; give it a moment, then
    // the deploy below asserts the assigned port lands in the new range.
    await Bun.sleep(1_500);

    const created = await fetch(`${api}/api/v1/apps`, {
      method: "POST",
      tls: { ca },
      headers: {
        authorization: `Basic ${btoa(admin)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "echoer" }),
    });
    expect(created.status).toBe(201);

    // Push an op.json'd app over the template with the real git CLI.
    const work = await mkdtemp(join(tmpdir(), "op-caps-push-"));
    cleanup.push(() => rm(work, { recursive: true, force: true }));
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
          `git ${argv.join(" ")}: ${await new Response(p.stderr).text()}`,
        );
    };
    await git(
      "clone",
      "-q",
      `https://${admin}@${domain}:${httpsPort}/plat/echoer.git`,
      "src",
    );
    const src = join(work, "src");
    await writeFile(join(src, "server.ts"), TCP_APP);
    await writeFile(
      join(src, "op.json"),
      JSON.stringify({ resources: { memoryMb: 700 }, tcpPorts: [7777] }),
    );
    const commit = async (msg: string) => {
      await git("-C", src, "add", "-A");
      await git(
        "-C",
        src,
        "-c",
        "user.email=e2e@test",
        "-c",
        "user.name=e2e",
        "commit",
        "-q",
        "-m",
        msg,
      );
      await git("-C", src, "push", "-q", "origin", "main");
    };
    await commit("caps: tcp echo app");

    // HTTP path serves the PUSHED code (the template answers first — wait it
    // out) and sees its public TCP port in env.
    const body = await until("pushed echoer to serve", 90_000, async () => {
      const res = await fetch(`https://echoer-plat.${domain}:${httpsPort}/`, {
        tls: { ca },
      });
      if (res.status !== 200) return null;
      const json = (await res.json()) as { app: string; tcp?: string | null };
      return "tcp" in json
        ? (json as { app: string; tcp: string | null })
        : null;
    });
    expect(body.app).toBe("echoer");

    // The platform allocated a sticky public port from THIS instance's range
    // (the hot-reloaded 27700-27799, isolated from any other platform) and
    // the relay carries bytes.
    const ports = platform.store.listAppPortsFor("plat", "echoer");
    expect(ports).toHaveLength(1);
    const pub = ports[0]!.public_port;
    expect(pub).toBeGreaterThanOrEqual(27700);
    expect(pub).toBeLessThanOrEqual(27799);
    expect(body.tcp).toBe(String(pub));
    expect(await tcpEcho(pub, "hello")).toBe("echo:hello");

    // The container really got the declared memory.
    const status = platform.store.getAppStatus("plat", "echoer");
    const inspect = Bun.spawn(
      [
        "docker",
        "inspect",
        "--format",
        "{{.HostConfig.Memory}}",
        status!.container_id!,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    expect((await new Response(inspect.stdout).text()).trim()).toBe(
      String(700 * 1024 * 1024),
    );

    // Out-of-policy manifest: deploy fails closed with a visible reason and
    // the running container keeps serving.
    await writeFile(
      join(src, "op.json"),
      JSON.stringify({ resources: { memoryMb: 999999 } }),
    );
    await commit("caps: absurd memory ask");
    await until("policy violation to surface", 30_000, async () => {
      const s = platform.store.getAppStatus("plat", "echoer");
      return s?.state === "error" && s.message?.includes("op.json") ? s : null;
    });
    const still = await fetch(`https://echoer-plat.${domain}:${httpsPort}/`, {
      tls: { ca },
    });
    expect(still.status).toBe(200); // old container untouched
    expect(await tcpEcho(pub, "still")).toBe("echo:still"); // relay untouched

    // Fix the manifest → redeploy keeps the SAME public port (sticky).
    await writeFile(
      join(src, "op.json"),
      JSON.stringify({ resources: { memoryMb: 512 }, tcpPorts: [7777] }),
    );
    await commit("caps: sane manifest again");
    await until("redeploy to converge", 90_000, async () => {
      const s = platform.store.getAppStatus("plat", "echoer");
      return s?.state === "running" && s.message === null ? s : null;
    });
    const after = platform.store.listAppPortsFor("plat", "echoer");
    expect(after[0]?.public_port).toBe(pub);
    await until("relay to retarget", 15_000, async () =>
      (await tcpEcho(pub, "back").catch(() => null)) === "echo:back"
        ? true
        : null,
    );
  }, 300_000);
});
