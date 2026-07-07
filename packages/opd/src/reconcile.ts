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
import { provisionDataDir } from "@op/data";
import type { Engine } from "@op/engine";
import type { GitHost } from "@op/git";
import type { Store } from "@op/store";
import { readAppSpecs, SYS } from "./gitops.ts";
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
    },
  ) {}

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
      await this.prune(specs.value);
    });
  }

  kickRepo(owner: string, name: string): Promise<void> {
    return this.enqueue(async () => {
      const specs = await readAppSpecs(this.deps.git, this.deps.domain);
      if (specs.status === "error") return;
      for (const spec of specs.value) {
        if (spec.repo.owner === owner && spec.repo.name === name)
          await this.convergeApp(spec);
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
    const { store, git, engine, log, domain } = this.deps;
    const key = { owner: spec.owner, app: spec.app };
    const emit = (
      phase: string,
      message: string | null,
      sha: string | null = null,
    ) => {
      store.appendEvent(spec.owner, spec.app, phase, message, sha);
      log.info(`deploy: ${phase}`, { ...key, ...(message ? { message } : {}) });
    };
    const fail = (message: string) => {
      log.error("converge failed", { ...key, message });
      emit("failed", message);
      store.upsertAppStatus({
        ...key,
        state: "error",
        image_digest: null,
        container_id: null,
        message,
      });
    };

    const sha = await git.headSha(spec.repo.owner, spec.repo.name, spec.ref);
    if (sha.status === "error") return fail(`headSha: ${sha.error.message}`);
    const short = sha.value.slice(0, 12);
    const tag = `op/${spec.owner}-${spec.app}:${short}`;
    const admitted = admitImageTag(tag, spec);
    if (admitted.status === "error") return fail(admitted.error.reason);

    const host = hostFor(spec, domain);
    const running = await engine.listPlatformContainers(this.deps.platformId);
    if (running.status === "error")
      return fail(`engine: ${running.error.message}`);
    const current = running.value.filter(
      (c) => c.owner === spec.owner && c.app === spec.app,
    );

    const alreadyConverged = current.find(
      (c) => c.image === tag && c.state === "running",
    );
    if (alreadyConverged) {
      if (alreadyConverged.hostPort !== null) {
        store.setHost(
          host,
          spec.owner,
          spec.app,
          alreadyConverged.id,
          alreadyConverged.hostPort,
        );
      }
      return;
    }

    // A deploy is starting: reflect it live so the dashboard dot goes amber
    // and the timeline shows progress while we work.
    const prev = store.getAppStatus(spec.owner, spec.app);
    store.upsertAppStatus({
      ...key,
      state: "building",
      image_digest: prev?.image_digest ?? null,
      container_id: prev?.container_id ?? null,
      message: null,
    });
    emit("queued", `commit ${short}`, short);

    // Build from a shallow checkout of the app repo's ref.
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
          spec.ref,
          bare,
          work + "/src",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      if ((await clone.exited) !== 0) {
        return fail(`clone: ${await new Response(clone.stderr).text()}`);
      }

      emit("building", `image ${tag.split(":")[0]}`, short);
      // Capture the build output to a per-app log the console can tail.
      const logFile = buildLogPath(this.deps.sd, spec.owner, spec.app);
      await mkdir(dirname(logFile), { recursive: true });
      const buildLines: string[] = [`$ docker build → ${tag}`];
      const built = await engine.buildImage({
        contextDir: join(work, "src"),
        tag,
        onLine: (line) => buildLines.push(line),
      });
      await writeFile(logFile, buildLines.join("\n") + "\n").catch(() => {});
      if (built.status === "error")
        return fail(`build: ${built.error.message}`);
      emit("built", built.value.imageId.slice(0, 19), short);

      // Single-writer data plane: stop the old container BEFORE starting the
      // new one. Brief downtime is the honest deploy for stateful apps in M1.
      for (const c of current) {
        const stopped = await engine.stopAndRemove(c.id);
        if (stopped.status === "error") {
          log.warn("stop old container failed", { ...key, id: c.id });
        }
      }

      let dataDir: string | undefined;
      if (spec.data) {
        const provisioned = await provisionDataDir(
          this.deps.sd,
          spec.owner,
          spec.app,
        );
        if (provisioned.status === "error")
          return fail(`data: ${provisioned.error.message}`);
        dataDir = provisioned.value;
      }

      // "Sign in with your platform": register this app as an OIDC client and
      // hand it the issuer + fresh credentials. The container reaches the
      // issuer (the platform host) via host-gateway, trusting the mounted CA.
      const issuer = this.originFor(this.deps.domain);
      const appOrigin = this.originFor(host);
      const oidc = await provisionAppClient(
        store,
        spec.owner,
        spec.app,
        appOrigin,
      );
      const caFile = join(this.deps.sd.certsDir, "ca.crt");

      const ran = await engine.runApp({
        image: tag,
        owner: spec.owner,
        app: spec.app,
        platformId: this.deps.platformId,
        containerPort: spec.containerPort,
        env: {
          PORT: String(spec.containerPort),
          DATA_DIR: "/data",
          OP_APP: spec.app,
          OP_OWNER: spec.owner,
          OP_HOST: host,
          OIDC_ISSUER: issuer,
          OIDC_CLIENT_ID: oidc.clientId,
          OIDC_CLIENT_SECRET: oidc.clientSecret,
          OIDC_REDIRECT_URI: oidc.redirectUri,
          OP_CA_FILE: "/etc/op/ca.crt",
          NODE_EXTRA_CA_CERTS: "/etc/op/ca.crt",
          APP_SECRET: randomAppSecret(),
        },
        caFile,
        extraHosts: [`${this.deps.domain}:host-gateway`],
        ...(dataDir ? { dataDir } : {}),
      });
      if (ran.status === "error") return fail(`run: ${ran.error.message}`);
      emit(
        "starting",
        `container ${ran.value.containerId.slice(0, 12)}`,
        short,
      );

      store.setHost(
        host,
        spec.owner,
        spec.app,
        ran.value.containerId,
        ran.value.hostPort,
      );
      store.upsertAppStatus({
        ...key,
        state: "running",
        image_digest: built.value.imageId,
        container_id: ran.value.containerId,
        message: null,
      });
      emit("running", host, short);
      log.info("converged", { ...key, tag, hostPort: ran.value.hostPort });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Containers whose spec no longer exists get stopped; their hosts unrouted. */
  private async prune(specs: AppSpec[]): Promise<void> {
    const { engine, store, log } = this.deps;
    const want = new Set(specs.map((s) => `${s.owner}/${s.app}`));
    const running = await engine.listPlatformContainers(this.deps.platformId);
    if (running.status === "error") return;
    for (const c of running.value) {
      if (want.has(`${c.owner}/${c.app}`)) continue;
      log.info("pruning", { owner: c.owner, app: c.app });
      await engine.stopAndRemove(c.id);
      store.deleteHostsFor(c.owner, c.app);
      store.appendEvent(c.owner, c.app, "stopped", "app removed", null);
    }
  }
}
