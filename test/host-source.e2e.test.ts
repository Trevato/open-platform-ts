// Self-source publishing (boot auto-host + `op host-source`) puts the
// platform's own source into plat/opd for the crew to edit + the supervisor to
// self-upgrade from. This asserts: it must succeed on a CLEAN checkout
// (working tree == HEAD); it must publish TRACKED source ONLY — never
// untracked files (secrets, node_modules) — into this world-readable repo;
// boot hosts it automatically; and an npm install (no checkout) falls back to
// the shipped source tarball.
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { Platform } from "../packages/opd/src/platform.ts";

const cleanup: Array<() => unknown> = [];
afterAll(async () => {
  for (const c of cleanup.reverse()) await c();
});

async function git(dir: string, args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await p.exited) !== 0) throw new Error(`git ${args[0]} failed`);
}

test("hostSource publishes tracked source only, on a clean checkout, idempotently", async () => {
  await mkdir(join(homedir(), ".op-e2e"), { recursive: true });
  const base = await mkdtemp(join(homedir(), ".op-e2e", "hs-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));

  // A pristine source repo: two committed files + one UNTRACKED secret. A clean
  // checkout (working tree == HEAD) is the exact case that failed pre-fix.
  const src = join(base, "src");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "server.ts"), "export const x = 1;\n");
  await writeFile(join(src, "README.md"), "# app\n");
  await git(src, ["init", "-b", "main"]);
  await git(src, ["config", "user.email", "t@t"]);
  await git(src, ["config", "user.name", "t"]);
  await git(src, ["add", "-A"]);
  await git(src, ["commit", "-m", "init"]);
  await writeFile(join(src, "SECRET.token"), "sk-do-not-publish\n"); // untracked

  const plat = Result.unwrap(
    await Platform.up({
      root: join(base, "plat"),
      domain: "hs.localtest.me",
      httpPort: 26080,
      httpsPort: 26443,
      custodyAck: true,
      // Explicit-srcDir mode (what `op host-source <dir>` uses): the boot
      // auto-publish must not race the directory under test.
      hostSourceOnBoot: false,
    }),
  );
  cleanup.push(() => plat.stop());

  const first = Result.unwrap(await plat.hostSource(src));
  expect(first.created).toBe(true);

  const files = Result.unwrap(await plat.git.listFiles("plat", "opd", "main"));
  expect(files.sort()).toEqual(["README.md", "server.ts"]); // tracked only
  expect(files).not.toContain("SECRET.token"); // untracked secret never published

  // idempotent: a second run is a no-op (guards on repo content, repair-safe).
  const second = Result.unwrap(await plat.hostSource(src));
  expect(second.created).toBe(false);
});

test("boot auto-hosts the platform's own source into plat/opd", async () => {
  await mkdir(join(homedir(), ".op-e2e"), { recursive: true });
  const base = await mkdtemp(join(homedir(), ".op-e2e", "hs-auto-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));

  const plat = Result.unwrap(
    await Platform.up({
      root: join(base, "plat"),
      domain: "hs-auto.localtest.me",
      httpPort: 26081,
      httpsPort: 26444,
      custodyAck: true,
    }),
  );
  cleanup.push(() => plat.stop());

  // Boot doesn't wait on the publish; the platform exposes the promise.
  await plat.sourceHosting;
  // In this test env the source dir is the repo checkout — its tracked root
  // must be in plat/opd, and nothing untracked (node_modules) with it.
  const files = Result.unwrap(await plat.git.listFiles("plat", "opd", "main"));
  expect(files).toContain("package.json");
  expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
});

test("hostSource falls back to the shipped source tarball when srcDir is not a checkout", async () => {
  await mkdir(join(homedir(), ".op-e2e"), { recursive: true });
  const base = await mkdtemp(join(homedir(), ".op-e2e", "hs-tar-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));

  // A fake "shipped" tarball (what scripts/build-package.ts writes into dist/).
  const shippedSrc = join(base, "shipped");
  await mkdir(shippedSrc, { recursive: true });
  await writeFile(join(shippedSrc, "daemon.ts"), "export const v = 1;\n");
  const tarball = join(base, "source.tar.gz");
  const tar = Bun.spawn(["tar", "-czf", tarball, "-C", shippedSrc, "."], {
    stderr: "ignore",
  });
  if ((await tar.exited) !== 0) throw new Error("tar failed");

  process.env["OP_SOURCE_TARBALL"] = tarball;
  cleanup.push(() => delete process.env["OP_SOURCE_TARBALL"]);
  const plat = Result.unwrap(
    await Platform.up({
      root: join(base, "plat"),
      domain: "hs-tar.localtest.me",
      httpPort: 26082,
      httpsPort: 26445,
      custodyAck: true,
      hostSourceOnBoot: false,
    }),
  );
  cleanup.push(() => plat.stop());

  // Not a git repo → git archive fails → the shipped tarball is published.
  const notARepo = join(base, "not-a-repo");
  await mkdir(notARepo, { recursive: true });
  const hosted = Result.unwrap(await plat.hostSource(notARepo));
  expect(hosted.created).toBe(true);
  const files = Result.unwrap(await plat.git.listFiles("plat", "opd", "main"));
  expect(files).toEqual(["daemon.ts"]);
});
