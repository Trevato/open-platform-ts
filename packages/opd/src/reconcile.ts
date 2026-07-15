import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildLogPath,
  randomHex,
  repoPath,
  type Log,
  type StateDir,
} from "@op/core";
import { branchData, deleteBranchData, provisionDataDir } from "@op/data";
import type { Engine } from "@op/engine";
import type { GitHost } from "@op/git";
import type { Store } from "@op/store";
import {
  ensureAssetsCached,
  placeAssets,
  type ResolvedAsset,
} from "./assets.ts";
import { readAppSpecs, SYS } from "./gitops.ts";
import {
  DEFAULT_APP_POLICY,
  envNameFor,
  readManifest,
  type AppPolicy,
} from "./manifest.ts";
import { provisionAppClient } from "./oidc-clients.ts";
import { admitImageTag, hostFor, type AppSpec } from "./policy.ts";

// Per-deploy secret the template app signs its own session cookie with.
function randomAppSecret(): string {
  return `op_app_${randomHex(24)}`;
}

// Level-based and idempotent: every pass recomputes desired-vs-actual from
// git HEAD and engine labels. A crash mid-pass costs nothing — the next pass
// converges. All passes are serialized on one queue; there is no lock to leak.
export class Reconciler {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      sd: StateDir;
      store: Store;
      git: GitHost;
      engine: Engine;
      domain: string;
      httpsPort: number;
      platformId: string;
      log: Log;
      /** Operator bounds for op.json admission (hot-reloadable platform.json). */
      appPolicy?: () => AppPolicy;
      /** Fired whenever app_ports rows changed — the TCP gate re-syncs. */
      onPortsChanged?: () => void;
    },
  ) {}

  private policy(): AppPolicy {
    return this.deps.appPolicy?.() ?? DEFAULT_APP_POLICY;
  }

  /** External origin for a host on this platform (honors a non-443 port). */
  private originFor(host: string): string {
    return this.deps.httpsPort === 443
      ? `https://${host}`
      : `https://${host}:${this.deps.httpsPort}`;
  }

  private stopped = false;

  start(): void {
    this.deps.git.onPush((evt) => {
      if (this.stopped) return;
      // A gitops push re-converges the world; an app-repo push just that app.
      if (evt.owner === SYS.owner && evt.name === SYS.name) this.kickAll();
      else this.kickRepo(evt.owner, evt.name);
    });
    this.kickAll();
  }

  /** No new passes are accepted; resolves when the in-flight pass drains. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue;
  }

  /** Enqueue a full convergence pass. Resolves when that pass completes. */
  kickAll(): Promise<void> {
    return this.enqueue(async () => {
      const specs = await readAppSpecs(this.deps.git, this.deps.domain);
      if (specs.status === "error") {
        this.deps.log.error("readAppSpecs failed", {
          error: specs.error.message,
        });
        return;
      }
      for (const spec of specs.value) await this.convergeApp(spec);
      await this.convergePreviews(specs.value);
      await this.prune(specs.value);
    });
  }

  kickRepo(owner: string, name: string): Promise<void> {
    return this.enqueue(async () => {
      const specs = await readAppSpecs(this.deps.git, this.deps.domain);
      if (specs.status === "error") return;
      for (const spec of specs.value) {
        if (spec.repo.owner === owner && spec.repo.name === name) {
          await this.convergeApp(spec);
          // A push to an app repo may update PR head branches too.
          await this.convergePreviews([spec]);
        }
      }
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue
      .then(() => (this.stopped ? undefined : work()))
      .catch((err) => {
        this.deps.log.error("reconcile pass crashed", { error: String(err) });
      });
    this.queue = next;
    return next;
  }

  private async convergeApp(spec: AppSpec): Promise<void> {
    const sha = await this.deps.git.headSha(
      spec.repo.owner,
      spec.repo.name,
      spec.ref,
    );
    if (sha.status === "error") {
      this.setError(spec, `headSha: ${sha.error.message}`);
      return;
    }
    await this.deployVariant({
      spec,
      ref: spec.ref,
      sha: sha.value,
      host: hostFor(spec, this.deps.domain),
      tag: `op/${spec.owner}-${spec.app}:${sha.value.slice(0, 12)}`,
    });
  }

  /** One preview environment per open PR: build the head ref, run it at a
   *  pr- host with a copy-on-write clone of prod's data. */
  private async convergePreview(
    spec: AppSpec,
    pr: { number: number; head_ref: string },
  ): Promise<void> {
    const sha = await this.deps.git.headSha(
      spec.repo.owner,
      spec.repo.name,
      pr.head_ref,
    );
    if (sha.status === "error") return; // branch gone; prune will clean up
    await this.deployVariant({
      spec,
      ref: pr.head_ref,
      sha: sha.value,
      host: `pr-${pr.number}-${spec.app}-${spec.owner}.${this.deps.domain}`,
      tag: `op/${spec.owner}-${spec.app}:pr-${pr.number}-${sha.value.slice(0, 12)}`,
      preview: `pr-${pr.number}`,
    });
  }

  private setError(spec: AppSpec, message: string): void {
    this.deps.log.error("converge failed", {
      owner: spec.owner,
      app: spec.app,
      message,
    });
    this.deps.store.appendEvent(spec.owner, spec.app, "failed", message, null);
    this.deps.store.upsertAppStatus({
      owner: spec.owner,
      app: spec.app,
      state: "error",
      image_digest: null,
      container_id: null,
      message,
    });
  }

  // The shared deploy path for prod and previews. A preview differs only in the
  // ref built, the host routed, the image tag, its OWN data branch (CoW clone of
  // prod), and its own OIDC client — everything else is identical.
  private async deployVariant(v: {
    spec: AppSpec;
    ref: string;
    sha: string;
    host: string;
    tag: string;
    preview?: string;
  }): Promise<void> {
    const { store, engine, log } = this.deps;
    const { spec } = v;
    const short = v.sha.slice(0, 12);
    const isProd = !v.preview;
    const emit = (phase: string, message: string | null) => {
      const label = v.preview ? `${phase} (${v.preview})` : phase;
      store.appendEvent(spec.owner, spec.app, label, message, short);
      log.info(`deploy: ${label}`, { owner: spec.owner, app: spec.app });
    };
    const fail = (message: string) => {
      if (isProd) this.setError(spec, message);
      else emit("preview-failed", message);
    };

    const admitted = admitImageTag(v.tag, spec);
    if (admitted.status === "error") return fail(admitted.error.reason);

    const running = await engine.listPlatformContainers(this.deps.platformId);
    if (running.status === "error")
      return fail(`engine: ${running.error.message}`);
    const current = running.value.filter(
      (c) =>
        c.owner === spec.owner &&
        c.app === spec.app &&
        (c.preview ?? undefined) === v.preview,
    );

    const converged = current.find(
      (c) => c.image === v.tag && c.state === "running",
    );
    if (converged) {
      // Multi-port containers: the HTTP route is the binding for the spec's
      // containerPort; any others are TCP-gate targets to refresh.
      const http = converged.ports.find(
        (p) => p.containerPort === spec.containerPort,
      );
      if (http)
        store.setHost(
          v.host,
          spec.owner,
          spec.app,
          converged.id,
          http.hostPort,
        );
      if (isProd) this.refreshTcpBindings(spec, converged.ports);
      return;
    }

    if (isProd) {
      const prev = store.getAppStatus(spec.owner, spec.app);
      store.upsertAppStatus({
        owner: spec.owner,
        app: spec.app,
        state: "building",
        image_digest: prev?.image_digest ?? null,
        container_id: prev?.container_id ?? null,
        message: null,
      });
    }
    emit("queued", `commit ${short}`);

    const work = await mkdtemp(join(tmpdir(), "op-build-"));
    try {
      const bare = repoPath(this.deps.sd, spec.repo.owner, spec.repo.name);
      const clone = Bun.spawn(
        [
          "git",
          "clone",
          "-q",
          "--depth",
          "1",
          "--branch",
          v.ref,
          bare,
          work + "/src",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      if ((await clone.exited) !== 0)
        return fail(`clone: ${await new Response(clone.stderr).text()}`);

      // A repo with no Dockerfile on this ref has nothing to build yet — a
      // fresh GitHub import the crew is still tuning, or a repo pushed before
      // its Dockerfile. Building anyway just fails "Cannot locate Dockerfile"
      // on every reconcile (noisy, and shows the app as broken). Treat it as a
      // benign WAIT: the importer crew's PR adds the Dockerfile, and merging it
      // re-kicks this build. Previews always build from a branch that already
      // has one, so this only bites the pre-tuning prod build.
      if (!(await Bun.file(join(work, "src", "Dockerfile")).exists())) {
        emit("waiting", "no Dockerfile yet — the build crew is preparing it");
        if (isProd) {
          const prev = store.getAppStatus(spec.owner, spec.app);
          store.upsertAppStatus({
            owner: spec.owner,
            app: spec.app,
            state: "pending",
            image_digest: prev?.image_digest ?? null,
            container_id: prev?.container_id ?? null,
            message:
              "Waiting for a Dockerfile — the build crew is preparing this app.",
          });
        }
        return;
      }

      // The app's own requirements (op.json beside its Dockerfile) — admitted
      // against platform policy, fail-closed like every other admission.
      const manifest = await readManifest(join(work, "src"), this.policy());
      if (manifest.status === "error")
        return fail(`op.json: ${manifest.error.reason}`);
      const need = manifest.value;
      if (need.assets.length > 0 && !spec.data)
        return fail("op.json declares assets but app.json has data:false");

      // Peer wiring is derived, never stored: a peer's URL follows from its
      // name alone, so injection can't block on (or go stale with) presence.
      // An absent peer is a 404 at the gate — a runtime condition the app
      // handles like any network call. Previews get the same prod peers.
      const peers = need.consumes.map((c) => {
        const owner = c.owner ?? spec.owner;
        const host = `${c.app}-${owner}.${this.deps.domain}`;
        return { owner, app: c.app, host, url: this.originFor(host) };
      });
      if (peers.some((p) => p.owner === spec.owner && p.app === spec.app))
        return fail("op.json: an app cannot consume itself");

      // Assets fill a content-addressed cache BEFORE the build, so a slow
      // download never overlaps the window where the old container is gone.
      let resolvedAssets: ResolvedAsset[] = [];
      if (need.assets.length > 0) {
        const cachedAll = await ensureAssetsCached(
          join(this.deps.sd.root, "assets"),
          need.assets,
          {
            maxBytes: this.policy().maxAssetMb * 1024 * 1024,
            allowedHosts: this.policy().assetHosts,
            onEvent: (message) => emit("assets", message),
          },
        );
        if (cachedAll.status === "error")
          return fail(
            `asset ${cachedAll.error.asset}: ${cachedAll.error.message}`,
          );
        resolvedAssets = cachedAll.value;
      }

      // Public TCP ports are claimed before the container runs so the app can
      // render its own join address (OP_TCP_PORT_<n>). Sticky per (app, port):
      // players keep the address across every redeploy. Prod only — previews
      // are reviewed over HTTP and never bind public ports.
      const publicPorts = new Map<number, number>();
      if (isProd) {
        for (const port of need.tcpPorts) {
          const pub = store.allocateAppPort(
            spec.owner,
            spec.app,
            port,
            this.policy().tcpPortRange,
          );
          if (pub === null)
            return fail(
              `no free public TCP port in range ${this.policy().tcpPortRange.join("-")}`,
            );
          publicPorts.set(port, pub);
        }
      }

      emit("building", `image ${v.tag.split(":")[0]}`);
      const logFile = buildLogPath(
        this.deps.sd,
        spec.owner,
        v.preview ? `${spec.app}-${v.preview}` : spec.app,
      );
      await mkdir(dirname(logFile), { recursive: true });
      const buildLines: string[] = [`$ docker build → ${v.tag}`];
      const built = await engine.buildImage({
        contextDir: join(work, "src"),
        tag: v.tag,
        onLine: (line) => buildLines.push(line),
      });
      await writeFile(logFile, buildLines.join("\n") + "\n").catch(() => {});
      if (built.status === "error")
        return fail(`build: ${built.error.message}`);
      emit("built", built.value.imageId.slice(0, 19));

      // Stop the prior container for THIS variant (single-writer data plane).
      for (const c of current) {
        const stopped = await engine.stopAndRemove(c.id);
        if (stopped.status === "error")
          log.warn("stop old container failed", { id: c.id });
      }

      let dataDir: string | undefined;
      if (spec.data) {
        // Prod uses its live dir; a preview forks it as a CoW data branch.
        const provisioned = v.preview
          ? await branchData(this.deps.sd, spec.owner, spec.app, v.preview)
          : await provisionDataDir(this.deps.sd, spec.owner, spec.app);
        if (provisioned.status === "error")
          return fail(`data: ${provisioned.error.message}`);
        dataDir = provisioned.value;
      }

      // Cached assets land in /data before the container ever starts, so the
      // app wakes up with its server.jar (or model, or dataset) in place.
      if (resolvedAssets.length > 0 && dataDir) {
        const placed = await placeAssets(dataDir, resolvedAssets);
        if (placed.status === "error")
          return fail(`asset ${placed.error.asset}: ${placed.error.message}`);
        if (placed.value.length > 0)
          emit("assets", `placed ${placed.value.join(", ")}`);
      }

      const issuer = this.originFor(this.deps.domain);
      const oidc = await provisionAppClient(
        store,
        spec.owner,
        spec.app,
        this.originFor(v.host),
        v.preview,
      );

      const ran = await engine.runApp({
        image: v.tag,
        owner: spec.owner,
        app: spec.app,
        platformId: this.deps.platformId,
        containerPort: spec.containerPort,
        // Raw TCP is a prod-only capability: previews are reviewed over HTTP
        // and must not claim public ports.
        ...(isProd && need.tcpPorts.length ? { tcpPorts: need.tcpPorts } : {}),
        ...(need.resources.memoryMb
          ? { memoryBytes: need.resources.memoryMb * 1024 * 1024 }
          : {}),
        ...(need.resources.cpus
          ? { nanoCpus: Math.round(need.resources.cpus * 1e9) }
          : {}),
        env: {
          PORT: String(spec.containerPort),
          DATA_DIR: "/data",
          OP_APP: spec.app,
          OP_OWNER: spec.owner,
          OP_HOST: v.host,
          ...(v.preview ? { OP_PREVIEW: v.preview } : {}),
          OIDC_ISSUER: issuer,
          OIDC_CLIENT_ID: oidc.clientId,
          OIDC_CLIENT_SECRET: oidc.clientSecret,
          OIDC_REDIRECT_URI: oidc.redirectUri,
          OP_CA_FILE: "/etc/op/ca.crt",
          NODE_EXTRA_CA_CERTS: "/etc/op/ca.crt",
          APP_SECRET: randomAppSecret(),
          // Peer URLs by derivation: OP_PEER_<APP>_URL for each consume.
          ...Object.fromEntries(peers.map((p) => [envNameFor(p.app), p.url])),
          // The app's public join addresses: OP_TCP_PORT_<containerPort>.
          ...Object.fromEntries(
            [...publicPorts].map(([cp, pub]) => [
              `OP_TCP_PORT_${cp}`,
              String(pub),
            ]),
          ),
        },
        caFile: join(this.deps.sd.certsDir, "ca.crt"),
        // host-gateway for the platform itself AND each consumed peer's host,
        // so peer subdomains resolve from inside the container in local/dev.
        extraHosts: [
          `${this.deps.domain}:host-gateway`,
          ...peers.map((p) => `${p.host}:host-gateway`),
        ],
        ...(v.preview ? { preview: v.preview } : {}),
        ...(dataDir ? { dataDir } : {}),
      });
      if (ran.status === "error") return fail(`run: ${ran.error.message}`);
      emit("starting", `container ${ran.value.containerId.slice(0, 12)}`);

      store.setHost(
        v.host,
        spec.owner,
        spec.app,
        ran.value.containerId,
        ran.value.hostPort,
      );

      if (publicPorts.size > 0) {
        for (const [port, pub] of publicPorts) {
          const loopback = ran.value.tcpHostPorts[port];
          store.setAppPortBinding(spec.owner, spec.app, port, loopback ?? null);
          emit("tcp", `${this.deps.domain}:${pub} → container :${port}`);
        }
        this.deps.onPortsChanged?.();
      }

      if (isProd) {
        store.upsertAppStatus({
          owner: spec.owner,
          app: spec.app,
          state: "running",
          image_digest: built.value.imageId,
          container_id: ran.value.containerId,
          message: null,
        });
      }
      emit(isProd ? "running" : "preview-ready", v.host);
      log.info("converged", {
        owner: spec.owner,
        app: spec.app,
        tag: v.tag,
        preview: v.preview,
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Point existing public-port allocations at a running container's loopback
   *  bindings — the level-based path for a daemon restart over live apps. */
  private refreshTcpBindings(
    spec: AppSpec,
    ports: Array<{ containerPort: number; hostPort: number }>,
  ): void {
    const rows = this.deps.store.listAppPortsFor(spec.owner, spec.app);
    if (rows.length === 0) return;
    let changed = false;
    for (const row of rows) {
      const live =
        ports.find((p) => p.containerPort === row.container_port)?.hostPort ??
        null;
      if (live !== row.host_port) {
        this.deps.store.setAppPortBinding(
          spec.owner,
          spec.app,
          row.container_port,
          live,
        );
        changed = true;
      }
    }
    if (changed) this.deps.onPortsChanged?.();
  }

  /** Reconcile a preview per work item with an open change on a deployed app. */
  private async convergePreviews(specs: AppSpec[]): Promise<void> {
    const byRepo = new Map(
      specs.map((s) => [`${s.repo.owner}/${s.repo.name}`, s]),
    );
    for (const work of this.deps.store.listOpenChanges()) {
      const spec = byRepo.get(`${work.owner}/${work.repo}`);
      if (spec && work.head_ref)
        await this.convergePreview(spec, {
          number: work.number,
          head_ref: work.head_ref,
        });
    }
  }

  /** Stop containers whose spec/change is gone; tear down orphaned preview data. */
  private async prune(specs: AppSpec[]): Promise<void> {
    const { engine, store, log } = this.deps;
    const wantApp = new Set(specs.map((s) => `${s.owner}/${s.app}`));
    const wantPreview = new Set(
      store
        .listOpenChanges()
        .filter((work) =>
          specs.some(
            (s) => s.repo.owner === work.owner && s.repo.name === work.repo,
          ),
        )
        .map((work) => `${work.owner}/${work.repo}#pr-${work.number}`),
    );
    const running = await engine.listPlatformContainers(this.deps.platformId);
    if (running.status === "error") return;
    for (const c of running.value) {
      if (c.preview) {
        if (wantPreview.has(`${c.owner}/${c.app}#${c.preview}`)) continue;
        log.info("pruning preview", {
          owner: c.owner,
          app: c.app,
          preview: c.preview,
        });
        await engine.stopAndRemove(c.id);
        // Only the preview's own host — never prod's.
        const n = c.preview.replace(/^pr-/, "");
        store.deleteHost(`pr-${n}-${c.app}-${c.owner}.${this.deps.domain}`);
        await deleteBranchData(this.deps.sd, c.owner, c.app, c.preview).catch(
          () => {},
        );
        continue;
      }
      if (wantApp.has(`${c.owner}/${c.app}`)) continue;
      log.info("pruning", { owner: c.owner, app: c.app });
      await engine.stopAndRemove(c.id);
      store.deleteHostsFor(c.owner, c.app);
      store.deleteAppPortsFor(c.owner, c.app);
      this.deps.onPortsChanged?.();
      store.appendEvent(c.owner, c.app, "stopped", "app removed", null);
    }
  }
}
