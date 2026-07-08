import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, Result, stateDir } from "@op/core";
import type { RunAgent } from "@op/crew";
import { Forge } from "@op/forge";
import { GitHost } from "@op/git";
import { Store, type UserRow } from "@op/store";
import { runBuilder } from "../src/crew/builder.ts";
import { Dispatcher, type DispatcherDeps } from "../src/crew/dispatcher.ts";
import { parseVerdict } from "../src/crew/reviewer.ts";

// Crew prompts + settings now come from a loadAgent()/config() seam (git-backed
// in production, faked here).
const fakeLoadAgent = async (role: string) =>
  Result.ok({
    role,
    instructions: `test ${role} prompt`,
    skills: [] as string[],
  });
const fakeConfig = () => ({ crew: { maxRework: 2, sweepMs: 30_000 } });

// The fake runner plays both roles: as the reviewer (cwd has REVIEW.md) it
// returns a verdict line; as the builder it writes a feature file.
function fakeCrew(verdict: string): RunAgent {
  return async (run) => {
    if (existsSync(join(run.cwd, "REVIEW.md")))
      return Result.ok({
        ok: true,
        result: verdict,
        costUsd: 0.02,
        numTurns: 2,
      });
    await writeFile(join(run.cwd, "FEATURE.md"), "implemented by the crew\n");
    return Result.ok({ ok: true, result: "done", costUsd: 0.05, numTurns: 3 });
  };
}

// Common dispatcher deps for the review/merge tests: preview always "up",
// a real (throwaway) CA file so the reviewer can read it.
function dispatcherReviewDeps(
  h: Awaited<ReturnType<typeof harness>>,
  runAgent: RunAgent | null,
  extra: Partial<DispatcherDeps> = {},
): DispatcherDeps {
  const caDir = mkdtempSync(join(tmpdir(), "op-ca-"));
  dirs.push(caDir);
  const caFile = join(caDir, "ca.crt");
  writeFileSync(
    caFile,
    "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
  );
  return {
    sd: h.sd,
    store: h.store,
    forge: h.forge,
    git: h.git,
    domain: "plat.localtest.me",
    httpsPort: 18443,
    loadAgent: fakeLoadAgent,
    config: fakeConfig,
    systemActor: h.admin,
    runAgent,
    oauthToken: runAgent ? "sk-ant-oat01-test" : null,
    caFile,
    ca: "",
    qaUser: "qa",
    qaPassword: "qa-pass",
    kickReconciler: () => {},
    previewIsUp: async () => true,
    log: createLog("disp"),
    ...extra,
  };
}

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
    loadAgent: fakeLoadAgent,
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

  // Authored by the crew itself (plat/opd#1) — the editable-path allowlist.
  test("plat/platform: rejects an edit outside the crew/**/*.md + platform.json allowlist", async () => {
    const h = await harness();
    const seed = await mkdtemp(join(tmpdir(), "op-crew-seed-"));
    dirs.push(seed);
    await writeFile(join(seed, "platform.json"), "{}\n");
    Result.unwrap(await h.forge.createRepo(h.admin, "plat", "platform"));
    Result.unwrap(
      await h.git.seedRepoFromDir("plat", "platform", seed, "init"),
    );
    const sneakyAgent: RunAgent = async (run) => {
      await writeFile(join(run.cwd, "server.ts"), "// oops\n");
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.01,
        numTurns: 1,
      });
    };
    const issue = h.store.createIssue("plat", "platform", {
      title: "sneak in a source edit",
      body: "",
      author: "plat",
      labels: ["agent-work"],
    });
    const built = await runBuilder(builderDeps(h, sneakyAgent, h.admin), issue);
    expect(built.status).toBe("error");
    if (built.status === "error")
      expect(built.error.message).toContain(
        "edit outside the allowlist: server.ts",
      );
    expect(h.store.getPr("plat", "platform", 1)).toBeNull();
  });

  test("plat/platform: allows crew/**/*.md and platform.json edits", async () => {
    const h = await harness();
    const seed = await mkdtemp(join(tmpdir(), "op-crew-seed-"));
    dirs.push(seed);
    await writeFile(join(seed, "platform.json"), "{}\n");
    Result.unwrap(await h.forge.createRepo(h.admin, "plat", "platform"));
    Result.unwrap(
      await h.git.seedRepoFromDir("plat", "platform", seed, "init"),
    );
    const configAgent: RunAgent = async (run) => {
      await mkdir(join(run.cwd, "crew"), { recursive: true });
      await writeFile(join(run.cwd, "crew", "builder.md"), "updated prompt\n");
      await writeFile(join(run.cwd, "platform.json"), '{"ok":true}\n');
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.01,
        numTurns: 1,
      });
    };
    const issue = h.store.createIssue("plat", "platform", {
      title: "tweak the builder prompt",
      body: "",
      author: "plat",
      labels: ["agent-work"],
    });
    const built = await runBuilder(builderDeps(h, configAgent, h.admin), issue);
    expect(built.status).toBe("ok");
  });
});

// tick() fires process() unawaited, so poll until the issue reaches a terminal
// label (the full flow is build → review → merge, with real git + fetches).
const TERMINAL = ["agent-shipped", "agent-failed", "agent-review-failed"];
async function settle(
  h: Awaited<ReturnType<typeof harness>>,
  num = 1,
  timeoutMs = 20_000,
  repo = "app",
): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const issue = h.store.getIssue("plat", repo, num);
    const labels = issue?.labels.split(",") ?? [];
    if (TERMINAL.some((t) => labels.includes(t))) return;
    await Bun.sleep(40);
  }
}

describe("verdict parsing", () => {
  test("picks the last marker line as the ship/no-ship decision", () => {
    expect(parseVerdict("blah\n✅ PASS — works").kind).toBe("pass");
    expect(parseVerdict("⚠️ PASS WITH CONCERNS — slow").kind).toBe("concerns");
    expect(parseVerdict("notes\n❌ FAIL — SQLi in /add").kind).toBe("fail");
    expect(parseVerdict("❌ UNTESTABLE — preview 502").kind).toBe("untestable");
    expect(parseVerdict("no verdict at all").kind).toBe("unknown");
  });
});

describe("dispatcher", () => {
  test("build → PR → review passes → auto-merge + ship, exactly once", async () => {
    const h = await harness();
    let builds = 0;
    const runAgent: RunAgent = async (run) => {
      if (existsSync(join(run.cwd, "REVIEW.md")))
        return Result.ok({
          ok: true,
          result: "✅ PASS — todo works, auth holds",
          costUsd: 0.02,
          numTurns: 2,
        });
      builds++;
      await writeFile(join(run.cwd, "FEATURE.md"), `run ${builds}\n`);
      await Bun.sleep(50); // keep it inflight so a concurrent tick would collide
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.01,
        numTurns: 1,
      });
    };
    let reconcileKicks = 0;
    const d = new Dispatcher(
      dispatcherReviewDeps(h, runAgent, {
        kickReconciler: () => void reconcileKicks++,
      }),
    );
    h.store.createIssue("plat", "app", {
      title: "build me",
      body: "please",
      author: "plat",
      labels: ["agent-work"],
    });

    // Fire several ticks at once — idempotency must build exactly one PR.
    await Promise.all([d.tick(), d.tick(), d.tick()]);
    await settle(h);

    expect(builds).toBe(1);
    const pr = h.store.getPr("plat", "app", 1);
    expect(pr?.number).toBe(1);
    expect(pr?.state).toBe("merged"); // auto-merged on a passing verdict
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.labels.split(",")).toContain("agent-shipped");
    expect(issue.state).toBe("closed");
    expect(reconcileKicks).toBe(2); // once for the preview, once to ship the merge
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("Opened PR #1");
    expect(comments).toContain("✅ PASS");
    expect(comments).toContain("Merged PR #1");
  });

  test("review FAILs with rework disabled → PR left open for a human", async () => {
    const h = await harness();
    const d = new Dispatcher(
      dispatcherReviewDeps(
        h,
        fakeCrew("❌ FAIL — stored XSS in the message field"),
        {
          maxRework: 0,
        },
      ),
    );
    h.store.createIssue("plat", "app", {
      title: "guestbook",
      body: "messages",
      author: "plat",
      labels: ["agent-work"],
    });
    await d.tick();
    await settle(h);

    const pr = h.store.getPr("plat", "app", 1);
    expect(pr?.number).toBe(1); // the PR exists…
    expect(pr?.state).toBe("open"); // …but was NOT merged
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.labels.split(",")).toContain("agent-review-failed");
    expect(issue.labels.split(",")).not.toContain("agent-shipped");
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("❌ FAIL");
    expect(comments).toContain("left open for a human");
  });

  test("rework: ❌ then a fix that passes → auto-merges + ships", async () => {
    const h = await harness();
    let builds = 0;
    let reviews = 0;
    const runAgent: RunAgent = async (run) => {
      if (existsSync(join(run.cwd, "REVIEW.md"))) {
        reviews++;
        // fail the first review, pass after the rework
        return Result.ok({
          ok: true,
          result:
            reviews === 1 ? "❌ FAIL — missing auth gate" : "✅ PASS — fixed",
          costUsd: 0.02,
          numTurns: 2,
        });
      }
      builds++;
      // change the branch head each pass so rework isn't a no-op
      await writeFile(join(run.cwd, "FEATURE.md"), `build ${builds}\n`);
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.03,
        numTurns: 2,
      });
    };
    const d = new Dispatcher(
      dispatcherReviewDeps(h, runAgent, { maxRework: 1 }),
    );
    h.store.createIssue("plat", "app", {
      title: "widget",
      body: "b",
      author: "plat",
      labels: ["agent-work"],
    });
    await d.tick();
    await settle(h);

    expect(builds).toBe(2); // initial build + one rework
    expect(reviews).toBe(2); // reviewed before and after the fix
    expect(h.store.getPr("plat", "app", 1)?.state).toBe("merged");
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.labels.split(",")).toContain("agent-shipped");
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("Reworking to fix");
    expect(comments).toContain("Merged PR #1");
  });

  test("forceFirstReviewFail hook: injects a ❌, then the real re-review ships", async () => {
    const h = await harness();
    let builds = 0;
    let reviews = 0;
    const runAgent: RunAgent = async (run) => {
      if (existsSync(join(run.cwd, "REVIEW.md"))) {
        reviews++; // only the SECOND review is real; the first is injected
        return Result.ok({
          ok: true,
          result: "✅ PASS — fixed",
          costUsd: 0.02,
          numTurns: 2,
        });
      }
      builds++;
      await writeFile(join(run.cwd, "FEATURE.md"), `build ${builds}\n`);
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.03,
        numTurns: 2,
      });
    };
    const d = new Dispatcher(
      dispatcherReviewDeps(h, runAgent, {
        maxRework: 1,
        forceFirstReviewFail: "add a length limit",
      }),
    );
    h.store.createIssue("plat", "app", {
      title: "board",
      body: "b",
      author: "plat",
      labels: ["agent-work"],
    });
    await d.tick();
    await settle(h);

    expect(builds).toBe(2); // initial + one rework
    expect(reviews).toBe(1); // the first verdict was injected, not a real review
    expect(h.store.getPr("plat", "app", 1)?.state).toBe("merged");
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("add a length limit");
    expect(comments).toContain("demonstrate auto-rework");
    expect(comments).toContain("Merged PR #1");
  });

  test("rework exhausted: persistent ❌ → parked after N attempts", async () => {
    const h = await harness();
    let builds = 0;
    let reviews = 0;
    const runAgent: RunAgent = async (run) => {
      if (existsSync(join(run.cwd, "REVIEW.md"))) {
        reviews++;
        return Result.ok({
          ok: true,
          result: "❌ FAIL — still broken",
          costUsd: 0.02,
          numTurns: 2,
        });
      }
      builds++;
      await writeFile(join(run.cwd, "FEATURE.md"), `build ${builds}\n`);
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.03,
        numTurns: 2,
      });
    };
    const d = new Dispatcher(
      dispatcherReviewDeps(h, runAgent, { maxRework: 1 }),
    );
    h.store.createIssue("plat", "app", {
      title: "widget",
      body: "b",
      author: "plat",
      labels: ["agent-work"],
    });
    await d.tick();
    await settle(h);

    expect(builds).toBe(2); // initial + one rework, then gives up
    expect(reviews).toBe(2);
    expect(h.store.getPr("plat", "app", 1)?.state).toBe("open");
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.labels.split(",")).toContain("agent-review-failed");
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("still finds blockers after 2 attempts");
  });

  test("preview never comes up → fails without reviewing", async () => {
    const h = await harness();
    let reviewed = false;
    const runAgent: RunAgent = async (run) => {
      if (existsSync(join(run.cwd, "REVIEW.md"))) reviewed = true;
      else await writeFile(join(run.cwd, "FEATURE.md"), "x\n");
      return Result.ok({
        ok: true,
        result: "✅ PASS — x",
        costUsd: 0.01,
        numTurns: 1,
      });
    };
    const d = new Dispatcher(
      dispatcherReviewDeps(h, runAgent, { previewIsUp: async () => false }),
    );
    h.store.createIssue("plat", "app", {
      title: "x",
      body: "",
      author: "plat",
      labels: ["agent-work"],
    });
    await d.tick();
    await settle(h);

    expect(reviewed).toBe(false); // never reviewed a preview that never came up
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.labels.split(",")).toContain("agent-failed");
    expect(h.store.getPr("plat", "app", 1)?.state).toBe("open");
  });

  test("a plat/platform (self-mod) issue is PROPOSED for a human — no auto-merge, no review", async () => {
    const h = await harness();
    // The platform's own config repo — no app to deploy, so no preview/review.
    const seed = await mkdtemp(join(tmpdir(), "op-plat-"));
    dirs.push(seed);
    await writeFile(
      join(seed, "platform.json"),
      '{"crew":{"maxRework":2,"sweepMs":30000}}',
    );
    Result.unwrap(await h.forge.createRepo(h.admin, "plat", "platform"));
    Result.unwrap(
      await h.git.seedRepoFromDir("plat", "platform", seed, "init"),
    );
    let reviewed = false;
    const runAgent: RunAgent = async (run) => {
      if (existsSync(join(run.cwd, "REVIEW.md"))) {
        reviewed = true;
        return Result.ok({
          ok: true,
          result: "✅ PASS",
          costUsd: 0,
          numTurns: 1,
        });
      }
      await mkdir(join(run.cwd, "crew", "builder"), { recursive: true });
      await writeFile(
        join(run.cwd, "crew", "builder", "instructions.md"),
        "prompt tweak\n",
      );
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.02,
        numTurns: 1,
      });
    };
    const d = new Dispatcher(dispatcherReviewDeps(h, runAgent));
    h.store.createIssue("plat", "platform", {
      title: "tweak the builder prompt",
      body: "b",
      author: "plat",
      labels: ["agent-work"],
    });
    await d.tick();
    await settle(h, 1, 20_000, "platform");

    expect(reviewed).toBe(false); // config repo: no preview → the reviewer never runs
    const pr = h.store.getPr("plat", "platform", 1);
    expect(pr?.number).toBe(1); // proposed…
    expect(pr?.state).toBe("open"); // …but NOT auto-merged (human gate)
    const issue = h.store.getIssue("plat", "platform", 1)!;
    expect(issue.labels.split(",")).toContain("agent-review-failed");
    const comments = h.store
      .listComments("plat", "platform", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("Proposed the change");
    expect(comments).toContain("review the diff and merge");
  });

  test("without a credential, posts a note and does not build", async () => {
    const h = await harness();
    const d = new Dispatcher(dispatcherReviewDeps(h, null, { httpsPort: 443 }));
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
