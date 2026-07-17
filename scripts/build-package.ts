#!/usr/bin/env bun
// Build the publishable `open-platform-ts` npm package.
//
// The repo is a Bun workspace of private @op/* packages; you can't publish that
// directly (workspace:* deps don't resolve for a consumer). Instead this bundles
// the whole `op` CLI — every @op/* package compiled in — into one self-contained
// bin, ships the genesis/ tree beside it (the daemon reads it for the app
// template, platform config, and the docs disk fallback), and writes a clean
// package.json whose only runtime deps are the two the bundle keeps external.
//
// Output: dist/ — a standalone package. `cd dist && npm publish`.
// It runs under Bun (bun:sqlite, Bun.serve, Bun.spawn); Node is not supported.

import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist");
const rootPkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const opdPkg = JSON.parse(
  await readFile(join(ROOT, "packages/opd/package.json"), "utf8"),
);

// These two are the only external runtime deps (see test/deps.test.ts) — keep
// them out of the bundle so npm installs the real (native-containing) packages.
const EXTERNAL = ["@anthropic-ai/claude-agent-sdk", "zod"];

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "bin"), { recursive: true });

// 1) bundle the CLI (all @op/* compiled in; node:*/bun:sqlite stay external)
const build = Bun.spawn(
  [
    "bun",
    "build",
    join(ROOT, "packages/opd/src/cli.ts"),
    "--target=bun",
    ...EXTERNAL.flatMap((e) => ["--external", e]),
    "--outfile",
    join(OUT, "bin/op.js"),
  ],
  { stdout: "inherit", stderr: "inherit", cwd: ROOT },
);
if ((await build.exited) !== 0) throw new Error("bun build failed");

// 2) make it an executable bin under bun — exactly one shebang on line 1
// (cli.ts already carries one that `bun build` preserves; don't double it).
const bundled = await readFile(join(OUT, "bin/op.js"), "utf8");
const body = bundled.replace(/^#![^\n]*\n/, "");
await writeFile(join(OUT, "bin/op.js"), `#!/usr/bin/env bun\n${body}`);
await chmod(join(OUT, "bin/op.js"), 0o755);

// 3) ship the genesis tree (app template, platform config, docs) + docs of record
await cp(join(ROOT, "genesis"), join(OUT, "genesis"), { recursive: true });
await cp(join(ROOT, "README.md"), join(OUT, "README.md"));
await cp(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));

// 4) the publishable manifest — no workspace, no private, just the bin + deps
const pkg = {
  name: rootPkg.name,
  version: rootPkg.version,
  description: rootPkg.description,
  license: rootPkg.license,
  author: rootPkg.author,
  homepage: rootPkg.homepage,
  repository: rootPkg.repository,
  bugs: rootPkg.bugs,
  keywords: rootPkg.keywords,
  type: "module",
  bin: { op: "bin/op.js" },
  files: ["bin", "genesis", "README.md", "LICENSE"],
  engines: { bun: ">=1.3.0" },
  dependencies: {
    "@anthropic-ai/claude-agent-sdk":
      opdPkg.dependencies["@anthropic-ai/claude-agent-sdk"],
    zod: opdPkg.dependencies["zod"],
  },
  publishConfig: { access: "public" },
};
await writeFile(join(OUT, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

console.log(
  `built dist/ — ${pkg.name}@${pkg.version} (bin: op, deps: ${Object.keys(pkg.dependencies).join(", ")})`,
);
