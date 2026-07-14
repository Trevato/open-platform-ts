import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Result, TaggedError } from "@op/core";

export class EngineError extends TaggedError("EngineError")<{
  message: string;
  op: string;
  status?: number;
}>() {}

// Docker 29 raised the engine's minimum accepted API version to 1.44.
const API = "/v1.44";

// The docker CLI's own endpoint mechanism: ~/.docker/config.json names the
// current context; its metadata (keyed by sha256(name)) carries the unix
// endpoint. Resolving contexts means colima/OrbStack/Desktop all work exactly
// as `docker` itself would — no per-runtime special cases.
function contextSocket(home: string): string | null {
  try {
    const cfg = JSON.parse(
      readFileSync(join(home, ".docker", "config.json"), "utf8"),
    ) as { currentContext?: string };
    const name = cfg.currentContext;
    if (!name || name === "default") return null;
    const digest = new Bun.CryptoHasher("sha256").update(name).digest("hex");
    const meta = JSON.parse(
      readFileSync(
        join(home, ".docker", "contexts", "meta", digest, "meta.json"),
        "utf8",
      ),
    ) as { Endpoints?: { docker?: { Host?: string } } };
    const host = meta.Endpoints?.docker?.Host;
    return host?.startsWith("unix://") ? host.slice("unix://".length) : null;
  } catch {
    return null;
  }
}

/** First unix socket that exists: $DOCKER_HOST (unix:// only) → the current
 *  docker context's endpoint → the two conventional paths. */
export function resolveEngineSocket(): string | null {
  const candidates: string[] = [];
  const dockerHost = process.env["DOCKER_HOST"];
  if (dockerHost?.startsWith("unix://"))
    candidates.push(dockerHost.slice("unix://".length));
  const home = process.env["HOME"];
  if (home) {
    const ctx = contextSocket(home);
    if (ctx) candidates.push(ctx);
  }
  candidates.push("/var/run/docker.sock");
  if (home) candidates.push(join(home, ".docker", "run", "docker.sock"));
  return candidates.find((p) => existsSync(p)) ?? null;
}

interface ContainerSummary {
  Id: string;
  Image: string;
  State: string;
  Labels: Record<string, string>;
  Ports: Array<{ PrivatePort: number; PublicPort?: number; Type: string }>;
}

export interface RunAppSpec {
  image: string;
  owner: string;
  app: string;
  platformId: string;
  env: Record<string, string>;
  containerPort: number;
  /** Extra container TCP ports published to loopback (the TCP gate relays
   *  them to their public ports; nothing binds beyond 127.0.0.1 here). */
  tcpPorts?: number[];
  dataDir?: string; // bind-mounted at /data
  caFile?: string; // host CA path, bind-mounted read-only at /etc/op/ca.crt
  extraHosts?: string[]; // Docker ExtraHosts, e.g. "plat.localtest.me:host-gateway"
  preview?: string; // op.preview label (a PR number) for preview containers
  memoryBytes?: number;
  nanoCpus?: number;
  user?: string;
}

export class Engine {
  private readonly socket: string | null;

  constructor(socketPath?: string) {
    this.socket = socketPath ?? resolveEngineSocket();
  }

  private async request(
    op: string,
    path: string,
    init?: {
      method?: string;
      body?: BodyInit;
      headers?: Record<string, string>;
    },
  ): Promise<Result<Response, EngineError>> {
    const sock = this.socket;
    if (sock === null)
      return Result.err(
        new EngineError({ message: "no docker socket found", op }),
      );
    return Result.tryPromise({
      try: () => fetch(`http://localhost${path}`, { ...init, unix: sock }),
      catch: (cause) => new EngineError({ message: String(cause), op }),
    });
  }

  /** Docker error bodies are JSON {"message": "..."}; fall back to raw text. */
  private async httpError(
    op: string,
    res: Response,
  ): Promise<Result<never, EngineError>> {
    const text = await res.text().catch(() => "");
    let message = text || res.statusText;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // not JSON — keep raw text
    }
    return Result.err(new EngineError({ message, op, status: res.status }));
  }

  async ping(): Promise<Result<void, EngineError>> {
    const res = await this.request("ping", "/_ping");
    if (res.isErr()) return Result.err(res.error);
    if (!res.value.ok) return this.httpError("ping", res.value);
    await res.value.text();
    return Result.ok(undefined);
  }

  async buildImage(opts: {
    contextDir: string;
    tag: string;
    // Fires per build-progress line (the `stream` field) so callers can
    // surface a live build log. Never throws into the build.
    onLine?: (line: string) => void;
  }): Promise<Result<{ imageId: string }, EngineError>> {
    const op = "buildImage";
    const tar = await Result.tryPromise({
      try: async () => {
        // macOS bsdtar embeds com.apple.* xattrs the Linux daemon cannot
        // lsetxattr while untarring the context — strip them at the source.
        const argv =
          process.platform === "darwin"
            ? ["tar", "--no-xattrs", "--no-mac-metadata"]
            : ["tar"];
        argv.push("-C", opts.contextDir, "-cf", "-", ".");
        const proc = Bun.spawn(argv, {
          stdout: "pipe",
          stderr: "pipe",
        });
        const bytes = await new Response(proc.stdout).bytes();
        if ((await proc.exited) !== 0) {
          const err = await new Response(proc.stderr).text();
          throw new Error(`tar failed: ${err.trim()}`);
        }
        return bytes;
      },
      catch: (cause) => new EngineError({ message: String(cause), op }),
    });
    if (tar.isErr()) return Result.err(tar.error);

    const res = await this.request(
      op,
      `${API}/build?t=${encodeURIComponent(opts.tag)}&dockerfile=Dockerfile`,
      {
        method: "POST",
        body: tar.value,
        headers: { "Content-Type": "application/x-tar" },
      },
    );
    if (res.isErr()) return Result.err(res.error);
    if (!res.value.ok) return this.httpError(op, res.value);

    // Progress stream: one JSON object per line; errors and the image ID
    // arrive in-band, so a 200 status alone proves nothing.
    const body = await res.value.text();
    let imageId: string | null = null;
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: {
        stream?: string;
        errorDetail?: { message?: string };
        error?: string;
        aux?: { ID?: string };
      };
      try {
        evt = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (opts.onLine && typeof evt.stream === "string") {
        const s = evt.stream.replace(/\n+$/, "");
        if (s) opts.onLine(s);
      }
      if (evt.errorDetail || evt.error) {
        return Result.err(
          new EngineError({
            message: evt.errorDetail?.message ?? evt.error ?? "build failed",
            op,
          }),
        );
      }
      if (evt.aux?.ID) imageId = evt.aux.ID;
    }
    if (imageId) return Result.ok({ imageId });

    // Older engines omit the aux line — resolve the tag instead.
    const inspect = await this.request(
      op,
      `${API}/images/${encodeURIComponent(opts.tag)}/json`,
    );
    if (inspect.isErr()) return Result.err(inspect.error);
    if (!inspect.value.ok) return this.httpError(op, inspect.value);
    const image = (await inspect.value.json()) as { Id: string };
    return Result.ok({ imageId: image.Id });
  }

  async runApp(spec: RunAppSpec): Promise<
    Result<
      {
        containerId: string;
        hostPort: number;
        /** container TCP port → loopback host port, for spec.tcpPorts */
        tcpHostPorts: Record<number, number>;
      },
      EngineError
    >
  > {
    const op = "runApp";
    const portKey = `${spec.containerPort}/tcp`;
    // 127.0.0.1:0 for EVERY port — engine assigns ephemeral host ports, never
    // exposed beyond loopback; the gate (HTTP + TCP relay) is the only public
    // ingress.
    const loopback = [{ HostIp: "127.0.0.1", HostPort: "0" }];
    const portKeys = [
      portKey,
      ...(spec.tcpPorts ?? [])
        .filter((p) => p !== spec.containerPort)
        .map((p) => `${p}/tcp`),
    ];
    const hostConfig: Record<string, unknown> = {
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      RestartPolicy: { Name: "always" },
      Memory: spec.memoryBytes ?? 512 * 1024 * 1024,
      NanoCpus: spec.nanoCpus ?? 1_000_000_000,
      PortBindings: Object.fromEntries(portKeys.map((k) => [k, loopback])),
    };
    // dataDir is bind-mounted; the caller pre-creates it 0777 (see @op/data)
    // so the default 65534:65534 user can write without a chown dance.
    const binds: string[] = [];
    if (spec.dataDir) binds.push(`${spec.dataDir}:/data`);
    // Read-only CA so the app can trust the platform's own HTTPS (OIDC token
    // exchange server-to-server) via NODE_EXTRA_CA_CERTS / OP_CA_FILE.
    if (spec.caFile) binds.push(`${spec.caFile}:/etc/op/ca.crt:ro`);
    if (binds.length) hostConfig["Binds"] = binds;
    // host-gateway lets the container reach the platform issuer on the host.
    if (spec.extraHosts?.length) hostConfig["ExtraHosts"] = spec.extraHosts;

    const created = await this.request(op, `${API}/containers/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Image: spec.image,
        User: spec.user ?? "65534:65534",
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: Object.fromEntries(portKeys.map((k) => [k, {}])),
        Labels: {
          "op.platform": spec.platformId,
          "op.owner": spec.owner,
          "op.app": spec.app,
          ...(spec.preview ? { "op.preview": spec.preview } : {}),
        },
        HostConfig: hostConfig,
      }),
    });
    if (created.isErr()) return Result.err(created.error);
    if (!created.value.ok) return this.httpError(op, created.value);
    const { Id: containerId } = (await created.value.json()) as { Id: string };

    const started = await this.request(
      op,
      `${API}/containers/${containerId}/start`,
      { method: "POST" },
    );
    if (started.isErr()) return Result.err(started.error);
    if (!started.value.ok && started.value.status !== 304)
      return this.httpError(op, started.value);
    await started.value.text();

    // The assigned port appears in inspect once the proxy binds — usually
    // immediately, but poll briefly to be safe.
    for (let attempt = 0; attempt < 20; attempt++) {
      const inspect = await this.request(
        op,
        `${API}/containers/${containerId}/json`,
      );
      if (inspect.isErr()) return Result.err(inspect.error);
      if (!inspect.value.ok) return this.httpError(op, inspect.value);
      const info = (await inspect.value.json()) as {
        NetworkSettings: {
          Ports: Record<string, Array<{ HostPort: string }> | null>;
        };
      };
      const bound = new Map<string, number>();
      for (const key of portKeys) {
        const binding = info.NetworkSettings.Ports[key]?.[0];
        if (!binding) continue;
        const hostPort = Number.parseInt(binding.HostPort, 10);
        if (Number.isFinite(hostPort) && hostPort > 0) bound.set(key, hostPort);
      }
      if (bound.size === portKeys.length) {
        const tcpHostPorts: Record<number, number> = {};
        for (const p of spec.tcpPorts ?? []) {
          const hp = bound.get(`${p}/tcp`);
          if (hp !== undefined) tcpHostPorts[p] = hp;
        }
        return Result.ok({
          containerId,
          hostPort: bound.get(portKey) as number,
          tcpHostPorts,
        });
      }
      await Bun.sleep(100);
    }
    return Result.err(
      new EngineError({
        message: `host ports not published for ${portKeys.join(", ")} on ${containerId}`,
        op,
      }),
    );
  }

  async stopAndRemove(containerId: string): Promise<Result<void, EngineError>> {
    const op = "stopAndRemove";
    const stopped = await this.request(
      op,
      `${API}/containers/${encodeURIComponent(containerId)}/stop?t=5`,
      { method: "POST" },
    );
    if (stopped.isErr()) return Result.err(stopped.error);
    // 304 = already stopped
    if (!stopped.value.ok && stopped.value.status !== 304)
      return this.httpError(op, stopped.value);
    await stopped.value.text();

    const removed = await this.request(
      op,
      `${API}/containers/${encodeURIComponent(containerId)}?force=true`,
      { method: "DELETE" },
    );
    if (removed.isErr()) return Result.err(removed.error);
    if (!removed.value.ok) return this.httpError(op, removed.value);
    await removed.value.text();
    return Result.ok(undefined);
  }

  async listPlatformContainers(platformId: string): Promise<
    Result<
      Array<{
        id: string;
        owner: string;
        app: string;
        preview: string | null;
        image: string;
        state: string;
        hostPort: number | null;
        /** every published binding: container port → loopback host port */
        ports: Array<{ containerPort: number; hostPort: number }>;
      }>,
      EngineError
    >
  > {
    const op = "listPlatformContainers";
    const filters = JSON.stringify({ label: [`op.platform=${platformId}`] });
    const res = await this.request(
      op,
      `${API}/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    if (res.isErr()) return Result.err(res.error);
    if (!res.value.ok) return this.httpError(op, res.value);
    const list = (await res.value.json()) as ContainerSummary[];
    return Result.ok(
      list.map((c) => {
        const ports = c.Ports.filter((p) => p.PublicPort !== undefined).map(
          (p) => ({
            containerPort: p.PrivatePort,
            hostPort: p.PublicPort as number,
          }),
        );
        return {
          id: c.Id,
          owner: c.Labels["op.owner"] ?? "",
          app: c.Labels["op.app"] ?? "",
          preview: c.Labels["op.preview"] ?? null,
          image: c.Image,
          state: c.State,
          // Single-port apps keep the simple field; multi-port callers use
          // `ports` and pick by container port.
          hostPort: ports.length === 1 ? (ports[0]?.hostPort ?? null) : null,
          ports,
        };
      }),
    );
  }

  /** True if an image tag/ID exists in the local store. */
  async imageExists(tag: string): Promise<Result<boolean, EngineError>> {
    const res = await this.request(
      "imageExists",
      `${API}/images/${encodeURIComponent(tag)}/json`,
    );
    if (res.isErr()) return Result.err(res.error);
    if (res.value.status === 404) return Result.ok(false);
    if (!res.value.ok) return this.httpError("imageExists", res.value);
    await res.value.text();
    return Result.ok(true);
  }

  /** Create a bridge network if absent. `internal: true` blocks all egress
   *  from the network (used to force agent traffic through a proxy). */
  async ensureNetwork(
    name: string,
    opts?: { internal?: boolean },
  ): Promise<Result<void, EngineError>> {
    const op = "ensureNetwork";
    const existing = await this.request(
      op,
      `${API}/networks/${encodeURIComponent(name)}`,
    );
    if (existing.isErr()) return Result.err(existing.error);
    if (existing.value.ok) {
      await existing.value.text();
      return Result.ok(undefined);
    }
    await existing.value.text();
    const created = await this.request(op, `${API}/networks/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Name: name,
        Driver: "bridge",
        Internal: opts?.internal ?? false,
      }),
    });
    if (created.isErr()) return Result.err(created.error);
    if (!created.value.ok) return this.httpError(op, created.value);
    await created.value.text();
    return Result.ok(undefined);
  }

  /**
   * Run a container to completion — the caged-agent primitive. The agent runs
   * WILD inside (arbitrary bash), but the box is the boundary: non-root,
   * cap-drop ALL, no-new-privileges, read-only rootfs (only the bind mount and
   * a tmpfs /tmp are writable), memory/pids/cpu limits, no docker socket, and a
   * dedicated network isolated from the platform's app networks. Streams logs
   * to onLine; returns the exit code. Always removes the container.
   */
  async runTask(spec: {
    image: string;
    cmd: string[];
    binds: string[]; // e.g. ["/host/work:/work"]
    env: Record<string, string>;
    workdir?: string;
    user?: string;
    network?: string;
    extraHosts?: string[]; // Docker ExtraHosts (e.g. host-gateway maps)
    memoryBytes?: number;
    nanoCpus?: number;
    pidsLimit?: number;
    tmpfs?: Record<string, string>; // {"/tmp":"rw,size=512m"}
    labels?: Record<string, string>;
    onLine?: (line: string) => void;
    hardTimeoutMs?: number;
  }): Promise<Result<{ exitCode: number }, EngineError>> {
    const op = "runTask";
    const hostConfig: Record<string, unknown> = {
      Binds: spec.binds,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Tmpfs: spec.tmpfs ?? { "/tmp": "rw,size=512m" },
      Memory: spec.memoryBytes ?? 2 * 1024 * 1024 * 1024,
      NanoCpus: spec.nanoCpus ?? 2_000_000_000,
      PidsLimit: spec.pidsLimit ?? 512,
      NetworkMode: spec.network ?? "bridge",
      RestartPolicy: { Name: "no" },
      ...(spec.extraHosts?.length ? { ExtraHosts: spec.extraHosts } : {}),
    };

    const created = await this.request(op, `${API}/containers/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Image: spec.image,
        Cmd: spec.cmd,
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        ...(spec.workdir ? { WorkingDir: spec.workdir } : {}),
        ...(spec.user ? { User: spec.user } : {}),
        Labels: spec.labels ?? {},
        HostConfig: hostConfig,
      }),
    });
    if (created.isErr()) return Result.err(created.error);
    if (!created.value.ok) return this.httpError(op, created.value);
    const { Id: id } = (await created.value.json()) as { Id: string };

    try {
      const started = await this.request(op, `${API}/containers/${id}/start`, {
        method: "POST",
      });
      if (started.isErr()) return Result.err(started.error);
      if (!started.value.ok) return this.httpError(op, started.value);
      await started.value.text();

      // Stream logs while it runs; a follow read returns when the container exits.
      const deadline = spec.hardTimeoutMs
        ? Date.now() + spec.hardTimeoutMs
        : Infinity;
      if (spec.onLine)
        await this.streamLogs(id, spec.onLine, deadline).catch(() => {});

      const waited = await this.request(op, `${API}/containers/${id}/wait`, {
        method: "POST",
      });
      if (waited.isErr()) return Result.err(waited.error);
      const { StatusCode } = (await waited.value.json()) as {
        StatusCode: number;
      };
      return Result.ok({ exitCode: StatusCode });
    } finally {
      await this.request(op, `${API}/containers/${id}?force=true`, {
        method: "DELETE",
      })
        .then((r) => (r.isOk() ? r.value.text() : undefined))
        .catch(() => {});
    }
  }

  private async streamLogs(
    id: string,
    onLine: (line: string) => void,
    deadline: number,
  ): Promise<void> {
    const res = await this.request(
      "streamLogs",
      `${API}/containers/${id}/logs?stdout=true&stderr=true&follow=true`,
    );
    if (res.isErr() || !res.value.ok || !res.value.body) return;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.value.body as ReadableStream<Uint8Array>) {
      // Follow logs are multiplexed; demux each chunk then split lines.
      buf += demuxLogStream(
        chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
      );
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
      if (Date.now() > deadline) break;
    }
    void decoder;
  }

  async logs(
    containerId: string,
    opts?: { tail?: number },
  ): Promise<Result<string, EngineError>> {
    const op = "logs";
    const tail = opts?.tail !== undefined ? String(opts.tail) : "all";
    const res = await this.request(
      op,
      `${API}/containers/${encodeURIComponent(containerId)}/logs?stdout=true&stderr=true&tail=${tail}`,
    );
    if (res.isErr()) return Result.err(res.error);
    if (!res.value.ok) return this.httpError(op, res.value);
    const bytes = await res.value.bytes();
    return Result.ok(demuxLogStream(bytes));
  }
}

// Non-TTY container logs arrive as multiplexed frames:
// [streamType, 0, 0, 0, size:u32be] + payload. TTY containers stream raw
// bytes — detect by the header shape and pass raw through.
export function demuxLogStream(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  let out = "";
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const streamType = bytes[offset]!;
    const validHeader =
      streamType <= 2 &&
      bytes[offset + 1] === 0 &&
      bytes[offset + 2] === 0 &&
      bytes[offset + 3] === 0;
    if (!validHeader) return decoder.decode(bytes);
    const size =
      (bytes[offset + 4]! << 24) |
      (bytes[offset + 5]! << 16) |
      (bytes[offset + 6]! << 8) |
      bytes[offset + 7]!;
    out += decoder.decode(bytes.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return out;
}
