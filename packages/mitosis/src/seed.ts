import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { isValidName, Result, TaggedError } from "@op/core";
import type { GitHost } from "@op/git";

export class MitosisError extends TaggedError("MitosisError")<{
  message: string;
  op: string;
}>() {}

// A seed is the platform genome: git bundles + a manifest. It carries NO key —
// sealed values inside the gitops bundle are inert ciphertext, useless without
// the sovereign key that never leaves its platform.
export interface SeedManifest {
  seedVersion: 1;
  createdFrom: string; // mother's domain — the daughter's lineage pointer
  createdAt: string;
  recipient: string; // mother's recipient (informational only)
  repos: Array<{ owner: string; name: string; bundle: string }>;
}

const err = (op: string) => (cause: unknown) =>
  new MitosisError({ message: String(cause), op });

export async function writeSeed(
  git: GitHost,
  opts: {
    outFile: string;
    domain: string;
    recipient: string;
    repos: Array<{ owner: string; name: string }>;
  },
): Promise<Result<SeedManifest, MitosisError>> {
  return Result.tryPromise({
    try: async () => {
      const work = await mkdtemp(join(tmpdir(), "op-seed-"));
      await mkdir(join(work, "repos"), { recursive: true });
      const manifest: SeedManifest = {
        seedVersion: 1,
        createdFrom: opts.domain,
        createdAt: new Date().toISOString(),
        recipient: opts.recipient,
        repos: [],
      };
      for (const r of opts.repos) {
        const bundle = `repos/${r.owner}__${r.name}.bundle`;
        const bundled = await git.bundle(r.owner, r.name, join(work, bundle));
        if (bundled.status === "error") throw bundled.error;
        manifest.repos.push({ owner: r.owner, name: r.name, bundle });
      }
      await writeFile(
        join(work, "manifest.json"),
        JSON.stringify(manifest, null, 2),
      );
      const tar = Bun.spawn(["tar", "-czf", opts.outFile, "-C", work, "."], {
        stdout: "ignore",
        stderr: "pipe",
      });
      if ((await tar.exited) !== 0) {
        throw new Error(`tar failed: ${await new Response(tar.stderr).text()}`);
      }
      return manifest;
    },
    catch: err("writeSeed"),
  });
}

export async function extractSeed(
  seedFile: string,
  destDir: string,
): Promise<Result<SeedManifest, MitosisError>> {
  return Result.tryPromise({
    try: async () => {
      await mkdir(destDir, { recursive: true });
      const tar = Bun.spawn(["tar", "-xzf", seedFile, "-C", destDir], {
        stdout: "ignore",
        stderr: "pipe",
      });
      if ((await tar.exited) !== 0) {
        throw new Error(`tar failed: ${await new Response(tar.stderr).text()}`);
      }
      const manifest = JSON.parse(
        await readFile(join(destDir, "manifest.json"), "utf8"),
      ) as SeedManifest;
      // Version gate: a daughter binary must refuse genomes it can't read
      // correctly rather than germinate something subtly broken.
      if (manifest.seedVersion !== 1) {
        throw new Error(
          `unsupported seedVersion ${String(manifest.seedVersion)}`,
        );
      }
      for (const r of manifest.repos) {
        if (
          !isValidName(r.owner) ||
          !isValidName(r.name) ||
          r.bundle.includes("..")
        ) {
          throw new Error(`manifest repo entry rejected: ${r.owner}/${r.name}`);
        }
      }
      return manifest;
    },
    catch: err("extractSeed"),
  });
}
