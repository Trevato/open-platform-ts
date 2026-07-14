import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, Result, stateDir } from "@op/core";
import { GitHost } from "@op/git";
import {
  admitPlatformConfig,
  PLAT,
  PlatformConfig,
} from "../src/platform-config.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// Seed plat/platform from a dir with the given files, return a PlatformConfig.
async function harness(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "op-pc-"));
  dirs.push(dir);
  const git = new GitHost(stateDir(dir), { log: createLog("t") });
  const seed = await mkdtemp(join(tmpdir(), "op-pc-seed-"));
  dirs.push(seed);
  for (const [p, content] of Object.entries(files)) {
    await mkdir(join(seed, p, ".."), { recursive: true });
    await writeFile(join(seed, p), content);
  }
  Result.unwrap(await git.initBareRepo(PLAT.owner, PLAT.name));
  Result.unwrap(await git.seedRepoFromDir(PLAT.owner, PLAT.name, seed, "seed"));
  return new PlatformConfig(git, createLog("pc"));
}

describe("admitPlatformConfig", () => {
  test("accepts in-range settings", () => {
    const r = admitPlatformConfig({ crew: { maxRework: 3, sweepMs: 15000 } });
    expect(Result.unwrap(r).crew.maxRework).toBe(3);
  });
  test("rejects out-of-range (fail-closed)", () => {
    expect(admitPlatformConfig({ crew: { maxRework: 99 } }).status).toBe(
      "error",
    );
    expect(admitPlatformConfig({ crew: { sweepMs: 10 } }).status).toBe("error");
  });
  test("crew.model: defaults to sonnet-5, accepts ids, rejects flags", () => {
    expect(Result.unwrap(admitPlatformConfig({})).crew.model).toBe(
      "claude-sonnet-5",
    );
    expect(
      Result.unwrap(admitPlatformConfig({ crew: { model: "claude-opus-4-8" } }))
        .crew.model,
    ).toBe("claude-opus-4-8");
    // A config commit must never smuggle a CLI flag or junk into the spawn.
    expect(
      admitPlatformConfig({ crew: { model: "--dangerously-skip-permissions" } })
        .status,
    ).toBe("error");
    expect(admitPlatformConfig({ crew: { model: "" } }).status).toBe("error");
    expect(admitPlatformConfig({ crew: { model: 42 } }).status).toBe("error");
  });
});

describe("PlatformConfig", () => {
  test("reload reads valid platform.json from git", async () => {
    const pc = await harness({
      "platform.json": JSON.stringify({
        crew: { maxRework: 4, sweepMs: 20000 },
      }),
    });
    await pc.reload();
    expect(pc.get().crew.maxRework).toBe(4);
    expect(pc.get().crew.sweepMs).toBe(20000);
  });

  test("garbage or invalid config keeps the last-good value (never bricks)", async () => {
    const pc = await harness({ "platform.json": "not json {{{" });
    await pc.reload(); // must not throw; keeps defaults
    expect(pc.get().crew.maxRework).toBe(2); // DEFAULTS

    const pc2 = await harness({
      "platform.json": JSON.stringify({ crew: { maxRework: 999 } }),
    });
    await pc2.reload();
    expect(pc2.get().crew.maxRework).toBe(2); // rejected → last-good
  });

  test("loadAgent reads a crew role's prompt from git", async () => {
    const pc = await harness({
      "platform.json": JSON.stringify({
        crew: { maxRework: 2, sweepMs: 30000 },
      }),
      "crew/builder/instructions.md": "BUILD IT WELL",
      "crew/builder/skills/one.md": "a skill",
    });
    const agent = Result.unwrap(await pc.loadAgent("builder"));
    expect(agent.instructions).toBe("BUILD IT WELL");
    expect(agent.skills).toEqual(["a skill"]);
  });
});
