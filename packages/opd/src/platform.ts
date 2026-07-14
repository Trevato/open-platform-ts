import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLog,
  isReservedAppName,
  isValidName,
  newId,
  Result,
  stateDir,
  TaggedError,
  type Log,
  type StateDir,
} from "@op/core";
import { importDataDir, provisionDataDir, snapshot } from "@op/data";
import { Engine } from "@op/engine";
import { Forge, forgeRouter } from "@op/forge";
import { ensureCa, Gate, TcpGate } from "@op/gate";
import { GitHost } from "@op/git";
import {
  extractAppSeed,
  extractSeed,
  recordLineage,
  writeAppSeed,
  writeSeed,
  type AppSeedManifest,
} from "@op/mitosis";
import {
  loadKeyFile,
  mintKey,
  openAll,
  regenerateAll,
  saveKeyFile,
  verifyAllSealed,
  type SovereignKey,
} from "@op/secrets";
import { Store } from "@op/store";
import { verifyAccessToken } from "@op/identity";
import { apiRouter } from "./api.ts";
import { consoleRouter } from "./console/index.ts";
import { oidcRouter } from "./oidc.ts";
import { ensureSigningKey } from "./oidc-clients.ts";
import { Dispatcher } from "./crew/dispatcher.ts";
import { makeContainerRunner } from "./crew/container-runner.ts";
import { OPD, PLAT, PlatformConfig } from "./platform-config.ts";
import { draftIssue } from "./crew/composer.ts";
import {
  appSpecPath,
  commitFiles,
  readAppSpecs,
  readSecretsFile,
  SECRETS_PATH,
  SYS,
  TEMPLATE,
} from "./gitops.ts";
import type { AppSpec } from "./policy.ts";
import { run } from "./proc.ts";
import { Reconciler } from "./reconcile.ts";

export class PlatformError extends TaggedError("PlatformError")<{
  message: string;
  step: string;
}>() {}

export interface PlatformOpts {
  root: string;
  domain: string;
  httpPort: number;
  httpsPort: number;
  /** SEC-1: an unacknowledged sovereign key is a platform that never boots. */
  custodyAck: boolean;
  engineSocket?: string;
  /** Where the genesis template content lives (defaults to the repo checkout). */
  genesisDir?: string;
  /** Called when the platform's own source (plat/opd) changes — the daemon asks
   *  its supervisor to re-exec from the new source. Absent = no self-upgrade. */
  onUpgradeRequested?: () => void;
  log?: Log;
}

const ADMIN_USER = "plat";
const QA_USER = "qa";

function defaultGenesisDir(): string {
  // packages/opd/src → repo root/genesis. Compiled binaries must pass genesisDir.
  return join(import.meta.dir, "..", "..", "..", "genesis");
}

export class Platform {
  /** Set when THIS boot minted the admin user — shown once on the card. */
  freshAdminPassword: string | undefined;
  caCertPem = "";
  /** True when a Claude credential is configured and the crew can build. */
  crewCredentialed = false;
  dispatcher: Dispatcher | undefined;

  private constructor(
    readonly sd: StateDir,
    readonly domain: string,
    readonly key: SovereignKey,
    readonly platformId: string,
    readonly store: Store,
    readonly git: GitHost,
    readonly forge: Forge,
    readonly engine: Engine,
    readonly gate: Gate,
    readonly tcpGate: TcpGate,
    readonly reconciler: Reconciler,
    readonly log: Log,
    readonly ports: { http: number; https: number },
  ) {}

  static async up(
    opts: PlatformOpts,
  ): Promise<Result<Platform, PlatformError>> {
    const log = opts.log ?? createLog(`opd:${opts.domain}`);
    const fail = (step: string) => (cause: unknown) =>
      new PlatformError({ message: String(cause), step });

    return Result.tryPromise({
      try: async () => {
        const sd = stateDir(opts.root);
        await mkdir(sd.root, { recursive: true });
        const store = new Store(sd.dbFile);

        // Sovereign key: load, or mint behind the custody gate. No key, no platform.
        let key: SovereignKey;
        if (await Bun.file(sd.keyFile).exists()) {
          key = Result.unwrap(await loadKeyFile(sd.keyFile));
        } else {
          if (!opts.custodyAck) {
            throw new Error(
              "sovereign key custody not acknowledged (SEC-1) — pass custodyAck/FORK_KEY_ACK=1. " +
                "The key minted at boot is the ONLY decryptor of this platform's secrets.",
            );
          }
          key = await mintKey();
          Result.unwrap(await saveKeyFile(sd.keyFile, key));
          log.info("sovereign key minted", {
            keyFile: sd.keyFile,
            recipient: key.recipient,
          });
        }

        const idFile = join(sd.root, "platform-id");
        let platformId: string;
        if (await Bun.file(idFile).exists()) {
          platformId = (await readFile(idFile, "utf8")).trim();
        } else {
          platformId = newId("plat");
          await writeFile(idFile, platformId);
        }

        const git = new GitHost(sd, { log });
        const forge = new Forge(store, git);

        const isGenesis = !(await Bun.file(
          join(sd.reposDir, SYS.owner, `${SYS.name}.git`, "HEAD"),
        ).exists());
        let freshAdminPassword: string | undefined;

        if (isGenesis) {
          // True genesis: mint the world — secrets, system repos, admin.
          const regenerated = Result.unwrap(await regenerateAll(key.recipient));
          const work = await mkdtemp(join(tmpdir(), "op-genesis-"));
          await writeFile(
            join(work, "README.md"),
            "# sys/gitops\n\nDesired state. `apps/<owner>/<app>/app.json` per app; secrets sealed to the sovereign key.\n",
          );
          await writeFile(
            join(work, SECRETS_PATH),
            JSON.stringify(regenerated.file, null, 2),
          );
          Result.unwrap(await git.initBareRepo(SYS.owner, SYS.name));
          Result.unwrap(
            await git.seedRepoFromDir(SYS.owner, SYS.name, work, "genesis"),
          );
          const genesisRoot = opts.genesisDir ?? defaultGenesisDir();
          Result.unwrap(await git.initBareRepo(TEMPLATE.owner, TEMPLATE.name));
          Result.unwrap(
            await git.seedRepoFromDir(
              TEMPLATE.owner,
              TEMPLATE.name,
              join(genesisRoot, "app-template"),
              "genesis",
            ),
          );
          // The platform's OWN config repo (crew prompts + tunables) — the
          // self-modification surface. Seeded from disk once; reconciled from
          // git thereafter.
          Result.unwrap(await git.initBareRepo(PLAT.owner, PLAT.name));
          Result.unwrap(
            await git.seedRepoFromDir(
              PLAT.owner,
              PLAT.name,
              join(genesisRoot, "platform"),
              "genesis",
            ),
          );
          await rm(work, { recursive: true, force: true });
          freshAdminPassword = regenerated.plain["ADMIN_PASSWORD"];
        }

        // Backstop: a germinated boot from a seed that predates PLAT-in-genome
        // has no plat/platform repo — and without it the crew is dead on
        // arrival (loadAgent reads crew/<role>/ from it). Re-seed from genesis.
        if (
          !(await Bun.file(
            join(sd.reposDir, PLAT.owner, `${PLAT.name}.git`, "HEAD"),
          ).exists())
        ) {
          const genesisRoot = opts.genesisDir ?? defaultGenesisDir();
          Result.unwrap(await git.initBareRepo(PLAT.owner, PLAT.name));
          Result.unwrap(
            await git.seedRepoFromDir(
              PLAT.owner,
              PLAT.name,
              join(genesisRoot, "platform"),
              "genesis",
            ),
          );
        }

        // System repos need store rows on genesis AND germinated boots
        // (bundle restores bypass forge.createRepo).
        if (!store.getRepo(SYS.owner, SYS.name))
          store.createRepo(SYS.owner, SYS.name);
        if (!store.getRepo(TEMPLATE.owner, TEMPLATE.name)) {
          store.createRepo(TEMPLATE.owner, TEMPLATE.name, { isTemplate: true });
        }
        if (!store.getRepo(PLAT.owner, PLAT.name))
          store.createRepo(PLAT.owner, PLAT.name);

        // Sovereignty gate on EVERY boot: all sealed values must decrypt with
        // OUR key and name exactly one recipient. Fail loud, not 20 min later.
        const secretsFile = Result.unwrap(await readSecretsFile(git));
        Result.unwrap(await verifyAllSealed(key.identity, secretsFile));
        const plainSecrets = Result.unwrap(
          await openAll(key.identity, secretsFile),
        );

        if (!store.getUser(ADMIN_USER)) {
          const password = plainSecrets["ADMIN_PASSWORD"];
          if (!password) throw new Error("secrets file has no ADMIN_PASSWORD");
          Result.unwrap(
            await forge.createUser(ADMIN_USER, password, {
              admin: true,
              system: true,
            }),
          );
          freshAdminPassword = password;
        }

        // The crew reviewer's low-privilege QA identity — a normal signed-in
        // user, no special rights, used to browser-test previews.
        const qaPassword = plainSecrets["QA_PASSWORD"] ?? "";
        if (qaPassword && !store.getUser(QA_USER)) {
          Result.unwrap(
            await forge.createUser(QA_USER, qaPassword, { system: true }),
          );
        }

        const ca = Result.unwrap(await ensureCa(sd.certsDir, opts.domain));

        const engine = new Engine(opts.engineSocket);
        Result.unwrap(await engine.ping());

        const oidcKey = await ensureSigningKey(sd);

        // The platform's OWN config, in git (plat/platform). Hot-reloaded on
        // push — a commit to that repo re-reads settings + crew prompts live,
        // no restart. This is the self-modification surface (the Flux concept).
        // Loaded before the reconciler so op.json admission sees real policy.
        const platformConfig = new PlatformConfig(git, log);
        await platformConfig.reload();

        // L4 ingress: raw-TCP relays for ports apps declare in op.json.
        // Same invariant as the HTTP gate — containers stay loopback-only.
        const tcpGate = new TcpGate({ log });

        const reconciler = new Reconciler({
          sd,
          store,
          git,
          engine,
          domain: opts.domain,
          httpsPort: opts.httpsPort,
          platformId,
          log,
          appPolicy: () => platformConfig.get().apps,
          onPortsChanged: () => tcpGate.sync(store.listAppPorts()),
        });

        // The dispatcher is created after the router (it needs the reconciler),
        // so route crew-kicks through a holder the router can call immediately.
        const crewKick = { fn: () => {} };
        // The crew's inference credential — a Claude Code OAuth token (works only
        // via the `claude` CLI). Drives the caged build/review agents and the
        // lightweight issue composer; absent → those degrade gracefully.
        const claudeToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? null;
        const forgeRoutes = forgeRouter(forge, git);
        const apiRoutes = apiRouter({
          sd,
          store,
          forge,
          git,
          engine,
          reconciler,
          kickCrew: () => crewKick.fn(),
          draftIssue: claudeToken
            ? async (idea, context, onEvent) => {
                const d = await draftIssue({
                  idea,
                  oauthToken: claudeToken,
                  log,
                  ...(context ? { context } : {}),
                  ...(onEvent ? { onEvent } : {}),
                });
                return d.status === "ok" ? d.value : null;
              }
            : null,
          domain: opts.domain,
          appPolicy: () => platformConfig.get().apps,
          log,
        });
        const oidcRoutes = oidcRouter({ forge, store, key: oidcKey, log });
        const consoleRoutes = consoleRouter({
          forge,
          store,
          git,
          sd,
          domain: opts.domain,
        });
        // API/git win first (machines); OIDC before the console; the console is
        // the human face fallback.
        const platformHandler = async (req: Request): Promise<Response> => {
          return (
            (await forgeRoutes(req)) ??
            (await apiRoutes(req)) ??
            (await oidcRoutes(req)) ??
            (await consoleRoutes(req)) ??
            Response.json({ error: "not found" }, { status: 404 })
          );
        };

        const originOf = (host: string): string =>
          opts.httpsPort === 443
            ? `https://${host}`
            : `https://${host}:${opts.httpsPort}`;
        const issuer = originOf(opts.domain);

        const gate = new Gate({
          store,
          domain: opts.domain,
          httpPort: opts.httpPort,
          httpsPort: opts.httpsPort,
          tls: { cert: ca.cert, key: ca.key },
          platformHandler,
          resolveUser: async (req) => {
            // App-to-app bearer tokens die here at the gate; identity
            // continues upstream as the existing x-plat-user header with an
            // app: prefix. The audience is checked against the TARGET host,
            // so a token for one app verifies as nothing at any other.
            const auth = req.headers.get("authorization") ?? "";
            if (auth.toLowerCase().startsWith("bearer ")) {
              const rawHost = req.headers.get("host") ?? "";
              const host = rawHost.includes(":")
                ? (rawHost.split(":")[0] as string)
                : rawHost;
              const verified = await verifyAccessToken(
                auth.slice(7).trim(),
                oidcKey,
                issuer,
                originOf(host.toLowerCase()),
              );
              if (
                verified.status === "ok" &&
                verified.value.sub.startsWith("app:")
              )
                return { username: verified.value.username };
              // Not one of ours — fall through; apps may run their own
              // bearer schemes behind the gate.
            }
            const user = await forge.authenticate(req);
            return user ? { username: user.username } : null;
          },
          // M1: repos are public-read, so their apps are public. Fail-closed on
          // unknown apps (no repo row → no route).
          authorizeApp: (_user, owner, app) =>
            store.getRepo(owner, app) !== null,
          log,
        });

        gate.start();
        // Restore TCP relays for apps that were already running before this
        // boot; the first reconcile pass refreshes any stale loopback targets.
        tcpGate.sync(store.listAppPorts());
        reconciler.start();

        git.onPush((evt) => {
          if (evt.owner === PLAT.owner && evt.name === PLAT.name) {
            // Reload, then re-converge: a policy change (say, a raised
            // memory cap) should take effect without waiting for a push.
            void platformConfig.reload().then(() => void reconciler.kickAll());
          }
          // A merge to the platform's own SOURCE re-execs the daemon from it.
          if (evt.owner === OPD.owner && evt.name === OPD.name) {
            log.info("self-upgrade: plat/opd changed — requesting re-exec");
            opts.onUpgradeRequested?.();
          }
        });

        // The AI build crew. The Claude Code OAuth token is BYO (sk-ant-oat01,
        // from `claude setup-token`) — the ONLY credential that can drive an
        // agent. Without it the dispatcher still runs but posts a "set a token"
        // note on agent-work issues instead of building. (claudeToken is read
        // above, before the API router, so the composer can share it.)
        const adminUser = store.getUser(ADMIN_USER);
        const dispatcher = new Dispatcher({
          sd,
          store,
          forge,
          git,
          domain: opts.domain,
          httpsPort: opts.httpsPort,
          loadAgent: (role) => platformConfig.loadAgent(role),
          config: () => platformConfig.get(),
          systemActor: adminUser ?? {
            id: "",
            username: ADMIN_USER,
            password_hash: "",
            is_admin: 1,
            created_at: 0,
          },
          runAgent: claudeToken
            ? makeContainerRunner(
                engine,
                opts.genesisDir ?? defaultGenesisDir(),
                log,
              )
            : null,
          oauthToken: claudeToken,
          caFile: join(sd.certsDir, "ca.crt"),
          ca: ca.caCert,
          qaUser: QA_USER,
          qaPassword,
          ...(process.env["OP_FORCE_FIRST_REVIEW_FAIL"]
            ? {
                forceFirstReviewFail: process.env["OP_FORCE_FIRST_REVIEW_FAIL"],
              }
            : {}),
          kickReconciler: () => void reconciler.kickAll(),
          log,
        });
        crewKick.fn = () => dispatcher.kick();
        dispatcher.start();

        const platform = new Platform(
          sd,
          opts.domain,
          key,
          platformId,
          store,
          git,
          forge,
          engine,
          gate,
          tcpGate,
          reconciler,
          log,
          { http: opts.httpPort, https: opts.httpsPort },
        );
        platform.freshAdminPassword = freshAdminPassword;
        platform.caCertPem = ca.caCert;
        platform.crewCredentialed = claudeToken !== null;
        platform.dispatcher = dispatcher;
        log.info("platform up", {
          domain: opts.domain,
          https: opts.httpsPort,
          isGenesis,
          crew: claudeToken ? "credentialed" : "no credential",
        });
        return platform;
      },
      catch: fail("up"),
    });
  }

  /**
   * Export the genome: system repos, with apps/ desired state stripped so a
   * daughter starts with a clean garden. No key ships — sealed values in the
   * bundle are inert ciphertext.
   */
  async seed(outFile: string): Promise<Result<void, PlatformError>> {
    return Result.tryPromise({
      try: async () => {
        const work = await mkdtemp(join(tmpdir(), "op-seedprep-"));
        try {
          const tmpRoot = join(work, "state");
          const tmpSd = stateDir(tmpRoot);
          // Squash gitops to a SINGLE ORPHAN commit with apps/ and
          // secrets.age.json removed. This is load-bearing for sovereignty:
          // a bundle of full history would carry the mother's prior
          // secrets.age.json commits — inert but decryptable by the mother's
          // key — into every descendant's public repo forever. The daughter
          // regenerates all secrets at germination, so the seed carries none.
          const gitopsBare = join(
            this.sd.reposDir,
            SYS.owner,
            `${SYS.name}.git`,
          );
          const tmpGitops = join(tmpSd.reposDir, SYS.owner, `${SYS.name}.git`);
          await mkdir(join(tmpSd.reposDir, SYS.owner), { recursive: true });
          const strip = join(work, "strip");
          await run(["git", "clone", "-q", gitopsBare, strip]);
          await rm(join(strip, "apps"), { recursive: true, force: true });
          await rm(join(strip, SECRETS_PATH), { force: true });
          // --orphan starts fresh history: the single commit has no parent, so
          // no earlier tree (and no earlier ciphertext) is reachable.
          await run(["git", "checkout", "-q", "--orphan", "seed-root"], strip);
          await run(["git", "add", "-A"], strip);
          await run(
            [
              "git",
              "-c",
              "user.email=op@platform",
              "-c",
              "user.name=op",
              "commit",
              "-q",
              "-m",
              "genesis",
            ],
            strip,
          );
          // Push into a brand-new bare so ONLY the orphan commit exists there;
          // writeSeed's `git bundle --all` then carries exactly one commit.
          await run(["git", "init", "-q", "--bare", "-b", "main", tmpGitops]);
          await run(["git", "push", "-q", tmpGitops, "seed-root:main"], strip);

          // plat/app-template and plat/platform ship as-is: full history, no
          // sealed material lives in either (secrets are sys/gitops-only, and
          // the seed strips those above). Carrying plat/platform is what makes
          // a daughter's crew live — prompts + platform.json (crew.model et
          // al.) inherit from the parent, not from a stale genesis.
          for (const sys of [TEMPLATE, PLAT]) {
            const bare = join(this.sd.reposDir, sys.owner, `${sys.name}.git`);
            await mkdir(join(tmpSd.reposDir, sys.owner), { recursive: true });
            await cp(bare, join(tmpSd.reposDir, sys.owner, `${sys.name}.git`), {
              recursive: true,
            });
          }

          const tmpGit = new GitHost(tmpSd, { log: this.log });
          Result.unwrap(
            await writeSeed(tmpGit, {
              outFile,
              domain: this.domain,
              recipient: this.key.recipient,
              repos: [SYS, TEMPLATE, PLAT],
            }),
          );
        } finally {
          await rm(work, { recursive: true, force: true });
        }
      },
      catch: (cause) =>
        new PlatformError({ message: String(cause), step: "seed" }),
    });
  }

  /**
   * Export ONE app as a portable artifact: its repo (full history), a fresh
   * verified data snapshot, and its app.json. A different sovereign platform
   * ingests it with appImport. No key or platform secret travels — the app's
   * OIDC client + APP_SECRET are re-minted at deploy on the target.
   */
  async appExport(
    owner: string,
    app: string,
    outFile: string,
  ): Promise<Result<AppSeedManifest, PlatformError>> {
    return Result.tryPromise({
      try: async () => {
        const specs = await readAppSpecs(this.git, this.domain);
        if (specs.status === "error") throw specs.error;
        const spec = specs.value.find(
          (s) => s.owner === owner && s.app === app,
        );
        if (!spec) throw new Error(`no such app: ${owner}/${app}`);

        // A fresh, integrity-checked snapshot is the app's data-of-record for
        // the migration. If the app has never stored data, ship none.
        let dataDir: string | undefined;
        if (spec.data) {
          const snap = await snapshot(this.sd, owner, app);
          if (snap.status === "ok") dataDir = snap.value.dir;
        }

        const written = await writeAppSeed(this.git, {
          outFile,
          owner,
          app,
          spec: spec as unknown as Record<string, unknown>,
          domain: this.domain,
          ...(dataDir ? { dataDir } : {}),
        });
        if (written.status === "error") throw written.error;
        this.log.info("app exported", { owner, app, outFile });
        return written.value;
      },
      catch: (cause) =>
        new PlatformError({ message: String(cause), step: "appExport" }),
    });
  }

  /**
   * Ingest an app seed produced by another platform. Restores the repo, lays
   * down its data, and commits a remapped app.json so the reconciler deploys
   * it here. owner/name may be remapped for the target namespace.
   */
  async appImport(
    seedFile: string,
    opts: { owner?: string; app?: string } = {},
  ): Promise<Result<{ owner: string; app: string }, PlatformError>> {
    return Result.tryPromise({
      try: async () => {
        const work = await mkdtemp(join(tmpdir(), "op-appimport-"));
        try {
          const extracted = await extractAppSeed(seedFile, work);
          if (extracted.status === "error") throw extracted.error;
          const { manifest, dataDir } = extracted.value;

          const owner = opts.owner ?? manifest.owner;
          const app = opts.app ?? manifest.app;
          if (!isValidName(owner) || !isValidName(app))
            throw new Error(`invalid target: ${owner}/${app}`);
          if (isReservedAppName(app)) throw new Error(`'${app}' is reserved`);
          if (this.store.getRepo(owner, app))
            throw new Error(`app already exists here: ${owner}/${app}`);

          // Restore the repo (bundle → bare) and register its store row.
          const restored = await this.git.restoreFromBundle(
            extracted.value.bundlePath,
            owner,
            app,
          );
          if (restored.status === "error") throw restored.error;
          if (!this.store.getRepo(owner, app))
            this.store.createRepo(owner, app);

          // Lay down the app's data, then verify it opens cleanly here.
          if (dataDir) {
            const imported = await importDataDir(this.sd, owner, app, dataDir);
            if (imported.status === "error") throw imported.error;
          } else {
            await provisionDataDir(this.sd, owner, app);
          }

          // Remap the spec to the target namespace and commit it — admitSpec on
          // the reconcile side fails closed if the migrated spec is malformed.
          const srcSpec = manifest.spec as unknown as AppSpec;
          const spec: AppSpec = {
            owner,
            app,
            repo: { owner, name: app },
            ref: srcSpec.ref ?? "main",
            containerPort: srcSpec.containerPort ?? 8080,
            data: srcSpec.data ?? true,
          };
          const committed = await commitFiles(
            this.sd,
            SYS,
            { [appSpecPath(owner, app)]: JSON.stringify(spec, null, 2) },
            `apps: import ${owner}/${app} (from ${manifest.createdFrom})`,
          );
          if (committed.status === "error") throw committed.error;

          void this.reconciler.kickAll();
          this.log.info("app imported", {
            owner,
            app,
            from: manifest.createdFrom,
          });
          return { owner, app };
        } finally {
          await rm(work, { recursive: true, force: true });
        }
      },
      catch: (cause) =>
        new PlatformError({ message: String(cause), step: "appImport" }),
    });
  }

  /**
   * Grow a seed into a SOVEREIGN daughter: fresh key, every secret regenerated,
   * own identity, lineage recorded — then boot. The parent key is never present.
   */
  static async germinate(
    seedFile: string,
    opts: PlatformOpts,
  ): Promise<Result<Platform, PlatformError>> {
    const fail = (step: string) => (cause: unknown) =>
      new PlatformError({ message: String(cause), step });
    return Result.tryPromise({
      try: async () => {
        const sd = stateDir(opts.root);
        if (await Bun.file(join(sd.root, "platform-id")).exists()) {
          throw new Error(
            `${sd.root} already hosts a platform — germinate into a fresh root`,
          );
        }
        if (!opts.custodyAck) {
          throw new Error("sovereign key custody not acknowledged (SEC-1)");
        }
        await mkdir(sd.root, { recursive: true });

        const work = await mkdtemp(join(tmpdir(), "op-germ-"));
        const manifest = Result.unwrap(await extractSeed(seedFile, work));

        // Fresh sovereign key — minted here, never derived from the parent.
        const key = await mintKey();
        Result.unwrap(await saveKeyFile(sd.keyFile, key));

        const log = opts.log ?? createLog(`opd:${opts.domain}`);
        const git = new GitHost(sd, { log });
        for (const r of manifest.repos) {
          Result.unwrap(
            await git.restoreFromBundle(join(work, r.bundle), r.owner, r.name),
          );
        }

        // Regenerate EVERY secret sealed to the daughter's key; the parent's
        // ciphertext is replaced wholesale, then the gate proves it.
        const regenerated = Result.unwrap(await regenerateAll(key.recipient));
        Result.unwrap(
          await commitFiles(
            sd,
            SYS,
            { [SECRETS_PATH]: JSON.stringify(regenerated.file, null, 2) },
            `germinate: sovereign secrets for ${opts.domain}`,
          ),
        );
        const readBack = Result.unwrap(await readSecretsFile(git));
        Result.unwrap(await verifyAllSealed(key.identity, readBack));

        Result.unwrap(
          await recordLineage(sd.originFile, {
            domain: opts.domain,
            parentDomain: manifest.createdFrom,
            seedFile,
          }),
        );
        await rm(work, { recursive: true, force: true });

        const platform = Result.unwrap(await Platform.up(opts));
        return platform;
      },
      catch: fail("germinate"),
    });
  }

  /**
   * Publish this platform's own source into plat/opd so the crew can edit the
   * daemon and the supervisor can self-upgrade from it.
   *
   * Publishes TRACKED source only, via `git archive HEAD` — an allowlist that
   * excludes untracked files (secrets, node_modules), carries no .git history
   * into this world-readable repo, and yields a clean single commit. (cp -r'ing
   * srcDir would leak history + committed-then-ignored secrets, and would fail
   * to commit at all on a clean checkout — the actual bootstrap case.)
   *
   * Idempotent + repair-safe: it skips only when plat/opd already has content
   * (a populated `main`), not merely a store row — so a partial seed re-runs
   * instead of wedging the repo.
   */
  async hostSource(
    srcDir: string,
  ): Promise<Result<{ created: boolean }, PlatformError>> {
    return Result.tryPromise({
      try: async () => {
        const listed = await this.git.listFiles(OPD.owner, OPD.name, "main");
        if (listed.status === "ok" && listed.value.length > 0)
          return { created: false };

        const admin = this.store.getUser(ADMIN_USER);
        if (!admin) throw new Error("admin user missing");
        if (!this.store.getRepo(OPD.owner, OPD.name))
          Result.unwrap(
            await this.forge.createRepo(admin, OPD.owner, OPD.name),
          );

        const tmp = await mkdtemp(join(tmpdir(), "op-hostsrc-"));
        try {
          const work = join(tmp, "src");
          await mkdir(work, { recursive: true });
          const tarFile = join(tmp, "src.tar");
          const archive = Bun.spawn(
            ["git", "-C", srcDir, "archive", "-o", tarFile, "HEAD"],
            { stderr: "pipe" },
          );
          if ((await archive.exited) !== 0)
            throw new Error(
              `git archive HEAD failed (is ${srcDir} a git repo with a commit?): ${await new Response(archive.stderr).text()}`,
            );
          const untar = Bun.spawn(["tar", "-xf", tarFile, "-C", work], {
            stderr: "pipe",
          });
          if ((await untar.exited) !== 0)
            throw new Error(
              `tar extract: ${await new Response(untar.stderr).text()}`,
            );
          Result.unwrap(
            await this.git.seedRepoFromDir(
              OPD.owner,
              OPD.name,
              work,
              "host source",
            ),
          );
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
        return { created: true };
      },
      catch: (cause) =>
        new PlatformError({ message: String(cause), step: "host-source" }),
    });
  }

  async stop(): Promise<void> {
    this.dispatcher?.stop();
    this.gate.stop();
    this.tcpGate.stop();
    await this.reconciler.stop(); // drain in-flight passes before the store closes
    this.store.close();
  }
}
