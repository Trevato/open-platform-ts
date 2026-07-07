import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, Result, stateDir } from "@op/core";
import type { RunAgent } from "@op/crew";
import { Forge } from "@op/forge";
import { GitHost } from "@op/git";
import { Store, type UserRow } from "@op/store";
import { runBuilder } from "../src/crew/builder.ts";
import { Dispatcher } from "../src/crew/dispatcher.ts";

const GENESIS = join(import.meta.dir, "..", "..", "..", "genesis");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "op-crew-"));
  dirs.push(dir);
  const sd = stateDir(dir);
  const store = new Store(sd.dbFile);
  const git = new GitHost(sd, { log: createLog("t") });
  const forge = new Forge(store, git);
  const admin = Result.unwrap(
    await forge.createUser("plat", "pw-123456", { admin: true, system: true }),
  );
  const seed = await mkdtemp(join(tmpdir(), "op-crew-seed-"));
  dirs.push(seed);
  await writeFile(join(seed, "server.ts"), "// app\nconsole.log('app');\n");
  Result.unwrap(await forge.createRepo(admin, "plat", "app"));
  Result.unwrap(await git.seedRepoFromDir("plat", "app", seed, "init"));
  return { sd, store, git, forge, admin };
}

// A deterministic fake "agent": writes a feature file (as a real agent would
// edit code) and does NOT commit — exercising the builder's commit backstop.
const fakeAgentWritesFeature: RunAgent = async (run) => {
  await writeFile(join(run.cwd, "FEATURE.md"), "implemented by the crew\n");
  return Result.ok({ ok: true, result: "done", costUsd: 0.05, numTurns: 3 });
};

function builderDeps(
  h: Awaited<ReturnType<typeof harness>>,
  runAgent: RunAgent,
  admin: UserRow,
) {
  return {
    sd: h.sd,
    forge: h.forge,
    domain: "plat.localtest.me",
    genesisDir: GENESIS,
    systemActor: admin,
    runAgent,
    oauthToken: "sk-ant-oat01-test",
    log: createLog("crew"),
  };
}

describe("builder", () => {
  test("clones, lets the agent edit, commits the backstop, pushes, opens a PR", async () => {
    const h = await harness();
    const issue = h.store.createIssue("plat", "app", {
      title: "add a health endpoint",
      body: "return ok from /health",
      author: "plat",
      labels: ["agent-work"],
    });
    const built = Result.unwrap(
      await runBuilder(builderDeps(h, fakeAgentWritesFeature, h.admin), issue),
    );
    expect(built.prNumber).toBe(1);
    expect(built.costUsd).toBe(0.05);

    // The PR exists, head branch carries the change, ISSUE.md was NOT shipped.
    const pr = h.store.getPr("plat", "app", 1);
    expect(pr?.head_ref).toBe("agent/issue-1");
    expect(
      (await h.git.readFile("plat", "app", "agent/issue-1", "FEATURE.md"))
        .status,
    ).toBe("ok");
    expect(
      (await h.git.readFile("plat", "app", "agent/issue-1", "ISSUE.md")).status,
    ).toBe("error");
  });

  test("an agent that changes nothing fails loudly (no empty PR)", async () => {
    const h = await harness();
    const noop: RunAgent = async () =>
      Result.ok({ ok: true, result: "nothing to do", costUsd: 0, numTurns: 1 });
    const issue = h.store.createIssue("plat", "app", {
      title: "x",
      body: "",
      author: "plat",
      labels: ["agent-work"],
    });
    const built = await runBuilder(builderDeps(h, noop, h.admin), issue);
    expect(built.status).toBe("error");
    expect(h.store.getPr("plat", "app", 1)).toBeNull();
  });
});

describe("dispatcher", () => {
  test("agent-work issue → build → PR → labeled shipped, exactly once", async () => {
    const h = await harness();
    let runs = 0;
    const counting: RunAgent = async (run) => {
      runs++;
      await writeFile(join(run.cwd, "FEATURE.md"), `run ${runs}\n`);
      await Bun.sleep(50); // keep it inflight so a concurrent tick would collide
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.01,
        numTurns: 1,
      });
    };
    const d = new Dispatcher({
      sd: h.sd,
      store: h.store,
      forge: h.forge,
      git: h.git,
      domain: "plat.localtest.me",
      httpsPort: 18443,
      genesisDir: GENESIS,
      systemActor: h.admin,
      runAgent: counting,
      oauthToken: "sk-ant-oat01-test",
      log: createLog("disp"),
    });
    h.store.createIssue("plat", "app", {
      title: "build me",
      body: "please",
      author: "plat",
      labels: ["agent-work"],
    });

    // Fire several ticks at once — idempotency must build exactly one PR.
    await Promise.all([d.tick(), d.tick(), d.tick()]);
    await Bun.sleep(200); // let the inflight build finish

    expect(runs).toBe(1);
    expect(h.store.getPr("plat", "app", 1)?.number).toBe(1);
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.labels.split(",")).toContain("agent-shipped");
    expect(issue.labels.split(",")).not.toContain("agent-work");
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("Opened PR #1");
    expect(comments).toContain("preview");
  });

  test("without a credential, posts a note and does not build", async () => {
    const h = await harness();
    const d = new Dispatcher({
      sd: h.sd,
      store: h.store,
      forge: h.forge,
      git: h.git,
      domain: "plat.localtest.me",
      httpsPort: 443,
      genesisDir: GENESIS,
      systemActor: h.admin,
      runAgent: null,
      oauthToken: null,
      log: createLog("disp"),
    });
    h.store.createIssue("plat", "app", {
      title: "x",
      body: "",
      author: "plat",
      labels: ["agent-work"],
    });
    await d.tick();
    await Bun.sleep(50);
    expect(h.store.getPr("plat", "app", 1)).toBeNull();
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments.toLowerCase()).toContain("credential");
  });
});
