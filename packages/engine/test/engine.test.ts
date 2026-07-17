import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomHex, Result } from "@op/core";
import { demuxLogStream, Engine, resolveEngineSocket } from "@op/engine";

// ── pure units (no docker needed) ────────────────────────────────────────

describe("resolveEngineSocket", () => {
  test("honors DOCKER_HOST unix:// when the socket path exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "op-sock-"));
    const fake = join(dir, "docker.sock");
    await writeFile(fake, "");
    const prev = process.env["DOCKER_HOST"];
    try {
      process.env["DOCKER_HOST"] = `unix://${fake}`;
      expect(resolveEngineSocket()).toBe(fake);
      // tcp:// hosts are not unix sockets — must be ignored
      process.env["DOCKER_HOST"] = "tcp://127.0.0.1:2375";
      expect(resolveEngineSocket()).not.toBe(fake);
    } finally {
      if (prev === undefined) delete process.env["DOCKER_HOST"];
      else process.env["DOCKER_HOST"] = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("demuxLogStream", () => {
  const frame = (streamType: number, text: string): Uint8Array => {
    const payload = new TextEncoder().encode(text);
    const out = new Uint8Array(8 + payload.length);
    out[0] = streamType;
    new DataView(out.buffer).setUint32(4, payload.length, false);
    out.set(payload, 8);
    return out;
  };

  test("reassembles multiplexed stdout/stderr frames", () => {
    const bytes = new Uint8Array([
      ...frame(1, "out line\n"),
      ...frame(2, "err line\n"),
      ...frame(1, "more"),
    ]);
    expect(demuxLogStream(bytes)).toBe("out line\nerr line\nmore");
  });

  test("passes raw (TTY) streams through untouched", () => {
    const raw = new TextEncoder().encode("plain tty output, no frames\n");
    expect(demuxLogStream(raw)).toBe("plain tty output, no frames\n");
  });

  test("empty input → empty string", () => {
    expect(demuxLogStream(new Uint8Array(0))).toBe("");
  });
});

// ── docker integration (skipped cleanly when no daemon reachable) ────────

// resolveEngineSocket covers the contract paths; colima is this dev box's
// daemon and is only ever consulted by the tests.
const home = process.env["HOME"] ?? "";
const sock =
  resolveEngineSocket() ??
  [
    join(home, ".colima", "default", "docker.sock"),
    join(home, ".colima", "docker.sock"),
  ].find((p) => existsSync(p)) ??
  null;
const engine = new Engine(sock ?? undefined);
const dockerUp = sock !== null && (await engine.ping()).isOk();
const dtest = test.skipIf(!dockerUp);

const platformId = `optest-${randomHex(4)}`;
const tag = `op/optest-web:${randomHex(4)}`;

async function raw(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    unix: sock!,
  });
}

afterAll(async () => {
  if (!dockerUp) return;
  const list = await engine.listPlatformContainers(platformId);
  if (list.isOk())
    for (const c of list.value)
      await raw(`/v1.44/containers/${c.id}?force=true`, { method: "DELETE" });
  await raw(`/v1.44/images/${encodeURIComponent(tag)}?force=true`, {
    method: "DELETE",
  });
});

describe("engine (docker)", () => {
  dtest("ping", async () => {
    expect((await engine.ping()).isOk()).toBe(true);
  });

  dtest(
    "buildImage: fixture context → image id",
    async () => {
      // pre-pull the base so the build itself is deterministic and fast
      const pull = await raw(
        "/v1.44/images/create?fromImage=busybox&tag=latest",
        { method: "POST" },
      );
      expect(pull.ok).toBe(true);
      await pull.text(); // drain the progress stream

      const ctx = mkdtempSync(join(tmpdir(), "op-build-"));
      const cmd = [
        "sh",
        "-c",
        // busybox nc serves one request per accept; printf interprets \r\n
        "echo started; while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok' | nc -l -p 8080; done",
      ];
      await writeFile(join(ctx, "hello.txt"), "hi\n");
      await writeFile(
        join(ctx, "Dockerfile"),
        `FROM busybox:latest\nCOPY hello.txt /hello.txt\nCMD ${JSON.stringify(cmd)}\n`,
      );
      const built = Result.unwrap(
        await engine.buildImage({ contextDir: ctx, tag }),
      );
      expect(built.imageId).toStartWith("sha256:");
      await rm(ctx, { recursive: true, force: true });
    },
    120_000,
  );

  dtest(
    "buildImage: in-stream build error surfaces as EngineError",
    async () => {
      const ctx = mkdtempSync(join(tmpdir(), "op-badbuild-"));
      await writeFile(
        join(ctx, "Dockerfile"),
        "FROM busybox:latest\nRUN exit 7\n",
      );
      const res = await engine.buildImage({
        contextDir: ctx,
        tag: "op/optest-bad:0",
      });
      expect(res.status).toBe("error");
      await rm(ctx, { recursive: true, force: true });
    },
    60_000,
  );

  dtest(
    "runApp: hardened container serves HTTP; list/logs/stopAndRemove",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "op-appdata-"));
      const run = Result.unwrap(
        await engine.runApp({
          image: tag,
          owner: "alice",
          app: "web",
          platformId,
          env: { FOO: "bar" },
          containerPort: 8080,
          dataDir,
        }),
      );
      expect(run.hostPort).toBeGreaterThan(0);

      let body = "";
      for (let i = 0; i < 60 && body !== "ok"; i++) {
        body = await fetch(`http://127.0.0.1:${run.hostPort}/`)
          .then((r) => r.text())
          .catch(() => "");
        if (body !== "ok") await Bun.sleep(250);
      }
      expect(body).toBe("ok");

      const inspect = (await (
        await raw(`/v1.44/containers/${run.containerId}/json`)
      ).json()) as {
        Config: { User: string; Env: string[]; Labels: Record<string, string> };
        HostConfig: {
          CapDrop: string[];
          SecurityOpt: string[];
          Memory: number;
          NanoCpus: number;
          RestartPolicy: { Name: string };
          Binds: string[];
          PortBindings: Record<string, Array<{ HostIp: string }>>;
        };
      };
      expect(inspect.Config.User).toBe("65534:65534");
      expect(inspect.Config.Env).toContain("FOO=bar");
      expect(inspect.Config.Labels["op.platform"]).toBe(platformId);
      expect(inspect.Config.Labels["op.owner"]).toBe("alice");
      expect(inspect.Config.Labels["op.app"]).toBe("web");
      expect(inspect.HostConfig.CapDrop).toEqual(["ALL"]);
      expect(inspect.HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
      expect(inspect.HostConfig.Memory).toBe(512 * 1024 * 1024);
      expect(inspect.HostConfig.NanoCpus).toBe(1_000_000_000);
      expect(inspect.HostConfig.RestartPolicy.Name).toBe("always");
      expect(inspect.HostConfig.Binds).toContain(`${dataDir}:/data`);
      expect(inspect.HostConfig.PortBindings["8080/tcp"]?.[0]?.HostIp).toBe(
        "127.0.0.1",
      );

      const listed = Result.unwrap(
        await engine.listPlatformContainers(platformId),
      );
      const mine = listed.find((c) => run.containerId.startsWith(c.id));
      expect(mine).toBeDefined();
      expect(mine?.owner).toBe("alice");
      expect(mine?.app).toBe("web");
      expect(mine?.state).toBe("running");
      expect(mine?.hostPort).toBe(run.hostPort);
      // other platforms' filters must not see it
      expect(
        Result.unwrap(await engine.listPlatformContainers("optest-other")),
      ).toEqual([]);

      const logs = Result.unwrap(
        await engine.logs(run.containerId, { tail: 50 }),
      );
      expect(logs).toContain("started");

      Result.unwrap(await engine.stopAndRemove(run.containerId));
      expect(
        Result.unwrap(await engine.listPlatformContainers(platformId)),
      ).toEqual([]);
      await rm(dataDir, { recursive: true, force: true });
    },
    90_000,
  );

  dtest("runApp with a missing image errors", async () => {
    const res = await engine.runApp({
      image: "op/does-not-exist:0",
      owner: "alice",
      app: "web",
      platformId,
      env: {},
      containerPort: 8080,
    });
    expect(res.status).toBe("error");
  });

  dtest("stopAndRemove of an unknown container errors", async () => {
    const res = await engine.stopAndRemove("no-such-container");
    expect(res.status).toBe("error");
  });

  dtest("imageExists + ensureNetwork are idempotent", async () => {
    expect(Result.unwrap(await engine.imageExists("busybox:latest"))).toBe(
      true,
    );
    expect(Result.unwrap(await engine.imageExists("op/nope:404"))).toBe(false);
    const net = `optest-net-${randomHex(4)}`;
    Result.unwrap(await engine.ensureNetwork(net));
    Result.unwrap(await engine.ensureNetwork(net)); // second call is a no-op
    await raw(`/v1.44/networks/${net}`, { method: "DELETE" }).then((r) =>
      r.text(),
    );
  });

  dtest(
    "runTask: caged one-shot container — captures logs + exit, hardened, writable bind",
    async () => {
      // Bind mounts must live under $HOME — colima only shares $HOME into the
      // Linux VM, so a /var/folders tmpdir bind-mounts as an empty dir.
      const { mkdirSync, chmodSync } = await import("node:fs");
      mkdirSync(join(home, ".op-e2e"), { recursive: true });
      const work = mkdtempSync(join(home, ".op-e2e", "op-task-"));
      // The container runs hardened as nobody:65534; mkdtemp is 0700, so on
      // native Linux Docker that user can't write to the bind mount (colima's
      // file sharing masks this on macOS). 0777 is the same convention the real
      // crew workspace (container-runner) and data dirs use.
      chmodSync(work, 0o777);
      const lines: string[] = [];
      // The 'agent' writes a file into the bind mount and prints a marker.
      const res = Result.unwrap(
        await engine.runTask({
          image: "busybox:latest",
          cmd: ["sh", "-c", "echo TASK_MARKER; echo built > /work/OUT; id -u"],
          binds: [`${work}:/work`],
          env: { HELLO: "world" },
          workdir: "/work",
          labels: { "op.task": "test" },
          onLine: (l) => lines.push(l),
          hardTimeoutMs: 30_000,
        }),
      );
      expect(res.exitCode).toBe(0);
      expect(lines.join("\n")).toContain("TASK_MARKER");
      // the container's write landed on the host bind mount (the handoff)
      expect((await Bun.file(join(work, "OUT")).text()).trim()).toBe("built");
      await rm(work, { recursive: true, force: true });
    },
    60_000,
  );

  dtest(
    "pruneImages: keeps the current tag, reaps old shas, skips in-use",
    async () => {
      const prefix = `op/optest-prune-${randomHex(3)}`;
      // Real deploys build a DISTINCT image per commit — model that so the
      // in-use protection (last tag of a running image → 409) is exercised.
      const del = (t: string) =>
        raw(`/v1.44/images/${encodeURIComponent(t)}?force=true`, {
          method: "DELETE",
        }).then((r) => r.text());
      const buildDistinct = async (t: string, marker: string) => {
        const ctx = mkdtempSync(join(tmpdir(), "op-prune-"));
        await writeFile(
          join(ctx, "Dockerfile"),
          `FROM busybox:latest\nRUN echo ${marker} > /marker\nCMD ["sh","-c","echo started; while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok' | nc -l -p 8080; done"]\n`,
        );
        Result.unwrap(await engine.buildImage({ contextDir: ctx, tag: t }));
        await rm(ctx, { recursive: true, force: true });
      };
      await buildDistinct(`${prefix}:old`, "a");
      await buildDistinct(`${prefix}:keep`, "b");
      await buildDistinct(`${prefix}:inuse`, "c");

      // A container holds :inuse, so its image can't be removed.
      const run = Result.unwrap(
        await engine.runApp({
          image: `${prefix}:inuse`,
          owner: "p",
          app: "prune",
          platformId,
          env: {},
          containerPort: 8080,
        }),
      ).containerId;

      const removed = Result.unwrap(
        await engine.pruneImages(prefix, [`${prefix}:keep`]),
      );
      // :old goes; :keep is kept by name; :inuse is protected (running) → 409.
      expect(removed).toBe(1);
      expect(Result.unwrap(await engine.imageExists(`${prefix}:old`))).toBe(
        false,
      );
      expect(Result.unwrap(await engine.imageExists(`${prefix}:keep`))).toBe(
        true,
      );
      expect(Result.unwrap(await engine.imageExists(`${prefix}:inuse`))).toBe(
        true,
      );

      await engine.stopAndRemove(run);
      await del(`${prefix}:keep`);
      await del(`${prefix}:inuse`);
    },
    180_000,
  );

  dtest("runTask surfaces a nonzero exit code", async () => {
    const res = Result.unwrap(
      await engine.runTask({
        image: "busybox:latest",
        cmd: ["sh", "-c", "exit 3"],
        binds: [],
        env: {},
      }),
    );
    expect(res.exitCode).toBe(3);
  });
});

test.skipIf(dockerUp)("docker integration skipped: no daemon reachable", () => {
  expect(sock === null || !dockerUp).toBe(true);
});
