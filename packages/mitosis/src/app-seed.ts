import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidName, Result } from "@op/core";
import type { GitHost } from "@op/git";
import { MitosisError } from "./seed.ts";

// An APP seed is a portable single application — one repo's full git history,
// its data (a verified snapshot), and its desired-state spec — sealed into a
// tar.gz that a DIFFERENT sovereign platform can ingest on its own. Unlike a
// platform seed it carries no system repos and no key material: an app's data
// dir holds no platform-sealed secrets (OIDC client + APP_SECRET are minted
// fresh at deploy), so nothing decryptable travels. This is the migration
// artifact — "sell what you built; the buyer runs it on their own platform."
export interface AppSeedManifest {
  appSeedVersion: 1;
  owner: string;
  app: string;
  /** The app.json (AppSpec) as authored on the source platform. Opaque here;
   *  the importer remaps owner/app before committing it. */
  spec: Record<string, unknown>;
  createdFrom: string; // source platform domain — provenance, not a trust root
  createdAt: string;
  hasData: boolean;
}

const err = (op: string) => (cause: unknown) =>
  new MitosisError({ message: String(cause), op });

async function tar(args: string[], op: string): Promise<void> {
  const p = Bun.spawn(["tar", ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0)
    throw new MitosisError({
      message: `tar failed: ${await new Response(p.stderr).text()}`,
      op,
    });
}

/**
 * Export one app as a portable artifact. `dataDir`, when given, is a directory
 * (typically a fresh verified snapshot) whose contents become the app's data
 * on import — the caller quiesces/verifies it (via @op/data snapshot) so this
 * module stays free of the data layer.
 */
export async function writeAppSeed(
  git: GitHost,
  opts: {
    outFile: string;
    owner: string;
    app: string;
    spec: Record<string, unknown>;
    domain: string;
    dataDir?: string;
  },
): Promise<Result<AppSeedManifest, MitosisError>> {
  return Result.tryPromise({
    try: async () => {
      if (!isValidName(opts.owner) || !isValidName(opts.app))
        throw new MitosisError({
          message: `invalid app: ${opts.owner}/${opts.app}`,
          op: "writeAppSeed",
        });
      const work = await mkdtemp(join(tmpdir(), "op-appseed-"));

      const bundled = await git.bundle(
        opts.owner,
        opts.app,
        join(work, "repo.bundle"),
      );
      if (bundled.status === "error") throw bundled.error;

      const hasData = Boolean(opts.dataDir && existsSync(opts.dataDir));
      if (hasData)
        await tar(
          ["-czf", join(work, "data.tar.gz"), "-C", opts.dataDir!, "."],
          "writeAppSeed",
        );

      const manifest: AppSeedManifest = {
        appSeedVersion: 1,
        owner: opts.owner,
        app: opts.app,
        spec: opts.spec,
        createdFrom: opts.domain,
        createdAt: new Date().toISOString(),
        hasData,
      };
      await writeFile(
        join(work, "manifest.json"),
        JSON.stringify(manifest, null, 2),
      );
      await tar(["-czf", opts.outFile, "-C", work, "."], "writeAppSeed");
      return manifest;
    },
    catch: err("writeAppSeed"),
  });
}

/**
 * Unpack + validate an app seed into destDir. Returns the manifest and the
 * paths of the repo bundle and (if present) the extracted data dir. Fail-loud:
 * a version the binary can't read, or a name that fails validation, is refused
 * before anything touches the platform.
 */
export async function extractAppSeed(
  seedFile: string,
  destDir: string,
): Promise<
  Result<
    { manifest: AppSeedManifest; bundlePath: string; dataDir: string | null },
    MitosisError
  >
> {
  return Result.tryPromise({
    try: async () => {
      await mkdir(destDir, { recursive: true });
      await tar(["-xzf", seedFile, "-C", destDir], "extractAppSeed");

      const manifest = JSON.parse(
        await readFile(join(destDir, "manifest.json"), "utf8"),
      ) as AppSeedManifest;
      if (manifest.appSeedVersion !== 1)
        throw new MitosisError({
          message: `unsupported appSeedVersion ${String(manifest.appSeedVersion)}`,
          op: "extractAppSeed",
        });
      if (!isValidName(manifest.owner) || !isValidName(manifest.app))
        throw new MitosisError({
          message: `manifest names rejected: ${manifest.owner}/${manifest.app}`,
          op: "extractAppSeed",
        });
      const bundlePath = join(destDir, "repo.bundle");
      if (!existsSync(bundlePath))
        throw new MitosisError({
          message: "app seed missing repo.bundle",
          op: "extractAppSeed",
        });

      let dataDir: string | null = null;
      if (manifest.hasData && existsSync(join(destDir, "data.tar.gz"))) {
        dataDir = join(destDir, "data");
        await mkdir(dataDir, { recursive: true });
        await tar(
          ["-xzf", join(destDir, "data.tar.gz"), "-C", dataDir],
          "extractAppSeed",
        );
      }
      return { manifest, bundlePath, dataDir };
    },
    catch: err("extractAppSeed"),
  });
}
