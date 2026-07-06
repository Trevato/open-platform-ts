import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath, type Log, type StateDir } from "@op/core";
import { provisionDataDir } from "@op/data";
import type { Engine } from "@op/engine";
import type { GitHost } from "@op/git";
import type { Store } from "@op/store";
import { readAppSpecs, SYS } from "./gitops.ts";
import { admitImageTag, hostFor, type AppSpec } from "./policy.ts";

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
      platformId: string;
      log: Log;
    },
  ) {}

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
    const fail = (message: string) => {
      log.error("converge failed", { ...key, message });
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
    const tag = `op/${spec.owner}-${spec.app}:${sha.value.slice(0, 12)}`;
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

      log.info("building", { ...key, tag });
      const built = await engine.buildImage({
        contextDir: join(work, "src"),
        tag,
      });
      if (built.status === "error")
        return fail(`build: ${built.error.message}`);

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
        },
        ...(dataDir ? { dataDir } : {}),
      });
      if (ran.status === "error") return fail(`run: ${ran.error.message}`);

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
    }
  }
}
