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
      if (converged.hostPort !== null)
        store.setHost(
          v.host,
          spec.owner,
          spec.app,
          converged.id,
          converged.hostPort,
        );
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
        },
        caFile: join(this.deps.sd.certsDir, "ca.crt"),
        extraHosts: [`${this.deps.domain}:host-gateway`],
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

  /** Reconcile a preview per open PR whose repo is a deployed app. */
  private async convergePreviews(specs: AppSpec[]): Promise<void> {
    const byRepo = new Map(
      specs.map((s) => [`${s.repo.owner}/${s.repo.name}`, s]),
    );
    for (const pr of this.deps.store.listOpenPrs()) {
      const spec = byRepo.get(`${pr.owner}/${pr.repo}`);
      if (spec) await this.convergePreview(spec, pr);
    }
  }

  /** Stop containers whose spec/PR is gone; tear down orphaned preview data. */
  private async prune(specs: AppSpec[]): Promise<void> {
    const { engine, store, log } = this.deps;
    const wantApp = new Set(specs.map((s) => `${s.owner}/${s.app}`));
    const wantPreview = new Set(
      store
        .listOpenPrs()
        .filter((pr) =>
          specs.some(
            (s) => s.repo.owner === pr.owner && s.repo.name === pr.repo,
          ),
        )
        .map((pr) => `${pr.owner}/${pr.repo}#pr-${pr.number}`),
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
      store.appendEvent(c.owner, c.app, "stopped", "app removed", null);
    }
  }
}
