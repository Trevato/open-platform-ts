import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLog,
  newId,
  Result,
  stateDir,
  TaggedError,
  type Log,
  type StateDir,
} from "@op/core";
import { Engine } from "@op/engine";
import { Forge, forgeRouter } from "@op/forge";
import { ensureCa, Gate } from "@op/gate";
import { GitHost } from "@op/git";
import { extractSeed, recordLineage, writeSeed } from "@op/mitosis";
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
import { apiRouter } from "./api.ts";
import { consoleRouter } from "./console/index.ts";
import { oidcRouter } from "./oidc.ts";
import { ensureSigningKey } from "./oidc-clients.ts";
import {
  commitFiles,
  readSecretsFile,
  SECRETS_PATH,
  SYS,
  TEMPLATE,
} from "./gitops.ts";
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
  log?: Log;
}

const ADMIN_USER = "plat";

function defaultGenesisDir(): string {
  // packages/opd/src → repo root/genesis. Compiled binaries must pass genesisDir.
  return join(import.meta.dir, "..", "..", "..", "genesis");
}

export class Platform {
  /** Set when THIS boot minted the admin user — shown once on the card. */
  freshAdminPassword: string | undefined;
  caCertPem = "";

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
          const templateSrc = join(
            opts.genesisDir ?? defaultGenesisDir(),
            "app-template",
          );
          Result.unwrap(await git.initBareRepo(TEMPLATE.owner, TEMPLATE.name));
          Result.unwrap(
            await git.seedRepoFromDir(
              TEMPLATE.owner,
              TEMPLATE.name,
              templateSrc,
              "genesis",
            ),
          );
          await rm(work, { recursive: true, force: true });
          freshAdminPassword = regenerated.plain["ADMIN_PASSWORD"];
        }

        // System repos need store rows on genesis AND germinated boots
        // (bundle restores bypass forge.createRepo).
        if (!store.getRepo(SYS.owner, SYS.name))
          store.createRepo(SYS.owner, SYS.name);
        if (!store.getRepo(TEMPLATE.owner, TEMPLATE.name)) {
          store.createRepo(TEMPLATE.owner, TEMPLATE.name, { isTemplate: true });
        }

        // Sovereignty gate on EVERY boot: all sealed values must decrypt with
        // OUR key and name exactly one recipient. Fail loud, not 20 min later.
        const secretsFile = Result.unwrap(await readSecretsFile(git));
        Result.unwrap(await verifyAllSealed(key.identity, secretsFile));

        if (!store.getUser(ADMIN_USER)) {
          const plain = Result.unwrap(await openAll(key.identity, secretsFile));
          const password = plain["ADMIN_PASSWORD"];
          if (!password) throw new Error("secrets file has no ADMIN_PASSWORD");
          Result.unwrap(
            await forge.createUser(ADMIN_USER, password, { admin: true }),
          );
          freshAdminPassword = password;
        }

        const ca = Result.unwrap(await ensureCa(sd.certsDir, opts.domain));

        const engine = new Engine(opts.engineSocket);
        Result.unwrap(await engine.ping());

        const oidcKey = await ensureSigningKey(sd);

        const reconciler = new Reconciler({
          sd,
          store,
          git,
          engine,
          domain: opts.domain,
          httpsPort: opts.httpsPort,
          platformId,
          log,
        });

        const forgeRoutes = forgeRouter(forge, git);
        const apiRoutes = apiRouter({
          sd,
          store,
          forge,
          git,
          engine,
          reconciler,
          domain: opts.domain,
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

        const gate = new Gate({
          store,
          domain: opts.domain,
          httpPort: opts.httpPort,
          httpsPort: opts.httpsPort,
          tls: { cert: ca.cert, key: ca.key },
          platformHandler,
          resolveUser: async (req) => {
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
        reconciler.start();

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
          reconciler,
          log,
          { http: opts.httpPort, https: opts.httpsPort },
        );
        platform.freshAdminPassword = freshAdminPassword;
        platform.caCertPem = ca.caCert;
        log.info("platform up", {
          domain: opts.domain,
          https: opts.httpsPort,
          isGenesis,
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

          const templateBare = join(
            this.sd.reposDir,
            TEMPLATE.owner,
            `${TEMPLATE.name}.git`,
          );
          await mkdir(join(tmpSd.reposDir, TEMPLATE.owner), {
            recursive: true,
          });
          await cp(
            templateBare,
            join(tmpSd.reposDir, TEMPLATE.owner, `${TEMPLATE.name}.git`),
            {
              recursive: true,
            },
          );

          const tmpGit = new GitHost(tmpSd, { log: this.log });
          Result.unwrap(
            await writeSeed(tmpGit, {
              outFile,
              domain: this.domain,
              recipient: this.key.recipient,
              repos: [SYS, TEMPLATE],
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

  async stop(): Promise<void> {
    this.gate.stop();
    await this.reconciler.stop(); // drain in-flight passes before the store closes
    this.store.close();
  }
}
