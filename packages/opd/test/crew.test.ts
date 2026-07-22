import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, repoPath, Result, stateDir } from "@op/core";
import type { RunAgent } from "@op/crew";
import { Forge } from "@op/forge";
import { GitHost } from "@op/git";
import { Store, type UserRow } from "@op/store";
import { runBuilder } from "../src/crew/builder.ts";
import { DEFAULT_APP_POLICY } from "../src/manifest.ts";
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
const fakeConfig = () => ({
  crew: { maxRework: 2, sweepMs: 30_000, model: "claude-sonnet-5" },
  apps: DEFAULT_APP_POLICY,
});

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

/** File a work item at `queued` (the agent-work verb's birth phase). */
function fileWork(
  h: Awaited<ReturnType<typeof harness>>,
  repo: string,
  fields: { title: string; body: string },
) {
  return h.store.createIssue("plat", repo, {
    ...fields,
    author: "plat",
    labels: ["agent-work"],
    phase: "queued",
  });
}

/** Claim a queued item (what the dispatcher does before runBuilder) — the
 *  builder-direct tests need the item at `building` for attachChange. */
function claimed(
  h: Awaited<ReturnType<typeof harness>>,
  repo: string,
  fields: { title: string; body: string },
) {
  const item = fileWork(h, repo, fields);
  h.store.claimWork("plat", repo, item.number);
  return item;
}

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

describe("attachChange self-heal", () => {
  test("a built change on a phase-drifted (queued) item is preserved: re-claim → reviewing", async () => {
    const h = await harness();
    // Make a real branch to attach (attachChange verifies both refs exist).
    const bare = repoPath(h.sd, "plat", "app");
    const b = Bun.spawn(
      ["git", "-C", bare, "branch", "agent/issue-1", "main"],
      { stdout: "ignore", stderr: "ignore" },
    );
    await b.exited;
    // File the item and leave it at `queued` — the exact drift state a build
    // has been observed to end in under heavy concurrency.
    const issue = fileWork(h, "app", { title: "x", body: "b" });
    expect(h.store.getIssue("plat", "app", issue.number)!.phase).toBe("queued");
    const attached = await h.forge.attachChange(
      h.admin,
      "plat",
      "app",
      issue.number,
      { head: "agent/issue-1" },
    );
    expect(attached.status).toBe("ok"); // change preserved, not lost
    const row = h.store.getIssue("plat", "app", issue.number)!;
    expect(row.phase).toBe("reviewing");
    expect(row.change_state).toBe("open");
  });
});

describe("builder", () => {
  test("clones, lets the agent edit, commits the backstop, pushes, attaches the change", async () => {
    const h = await harness();
    const issue = claimed(h, "app", {
      title: "add a health endpoint",
      body: "return ok from /health",
    });
    const built = Result.unwrap(
      await runBuilder(builderDeps(h, fakeAgentWritesFeature, h.admin), issue),
    );
    expect(built.costUsd).toBe(0.05);

    // The change is attached, the branch carries it, ISSUE.md was NOT shipped.
    const item = h.store.getIssue("plat", "app", 1)!;
    expect(item.head_ref).toBe("agent/issue-1");
    expect(item.change_state).toBe("open");
    expect(item.phase).toBe("reviewing");
    expect(
      (await h.git.readFile("plat", "app", "agent/issue-1", "FEATURE.md"))
        .status,
    ).toBe("ok");
    expect(
      (await h.git.readFile("plat", "app", "agent/issue-1", "ISSUE.md")).status,
    ).toBe("error");
  });

  test("an agent that changes nothing fails loudly (no empty change)", async () => {
    const h = await harness();
    const noop: RunAgent = async () =>
      Result.ok({ ok: true, result: "nothing to do", costUsd: 0, numTurns: 1 });
    const issue = claimed(h, "app", { title: "x", body: "" });
    const built = await runBuilder(builderDeps(h, noop, h.admin), issue);
    expect(built.status).toBe("error");
    // The agent's final message rides in the error so the park comment says
    // WHY, not just "no changes".
    if (built.status === "error")
      expect(built.error.message).toContain("nothing to do");
    expect(h.store.getIssue("plat", "app", 1)?.change_state).toBeNull();
  });

  test("DECLINED: an agent that invokes the decline contract returns the note, not an error", async () => {
    const h = await harness();
    const decliner: RunAgent = async () =>
      Result.ok({
        ok: true,
        result:
          "I compared ISSUE.md against this repo.\nDECLINED: this is daemon work — it belongs on plat/opd, not the config repo.",
        costUsd: 0.01,
        numTurns: 1,
      });
    const issue = claimed(h, "app", { title: "x", body: "" });
    const built = await runBuilder(builderDeps(h, decliner, h.admin), issue);
    expect(built.status).toBe("ok");
    if (built.status === "ok")
      expect(built.value.declined).toContain("belongs on plat/opd");
    expect(h.store.getIssue("plat", "app", 1)?.change_state).toBeNull();
  });

  test("DECLINED wins over a stray uncommitted file — the backstop must not ship it", async () => {
    const h = await harness();
    // The agent leaves a scratch file dirty (does NOT commit) and declines.
    // The backstop must NOT sweep it into a commit that masks the decline and
    // attaches unvetted work (the prompt-injection vector).
    const declinerWithStray: RunAgent = async (run) => {
      await writeFile(join(run.cwd, "SCRATCH.md"), "investigation notes\n");
      return Result.ok({
        ok: true,
        result: "Looked into it.\nDECLINED: this needs a product decision.",
        costUsd: 0.01,
        numTurns: 1,
      });
    };
    const issue = claimed(h, "app", { title: "x", body: "" });
    const built = await runBuilder(
      builderDeps(h, declinerWithStray, h.admin),
      issue,
    );
    expect(built.status).toBe("ok");
    if (built.status === "ok")
      expect(built.value.declined).toContain("product decision");
    // No change attached, nothing pushed.
    expect(h.store.getIssue("plat", "app", 1)?.change_state).toBeNull();
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
    const issue = claimed(h, "platform", {
      title: "sneak in a source edit",
      body: "",
    });
    const built = await runBuilder(builderDeps(h, sneakyAgent, h.admin), issue);
    expect(built.status).toBe("error");
    if (built.status === "error")
      expect(built.error.message).toContain(
        "edit outside the allowlist: server.ts",
      );
    expect(h.store.getIssue("plat", "platform", 1)?.change_state).toBeNull();
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
    const issue = claimed(h, "platform", {
      title: "tweak the builder prompt",
      body: "",
    });
    const built = await runBuilder(builderDeps(h, configAgent, h.admin), issue);
    expect(built.status).toBe("ok");
  });
});

// tick() fires process() unawaited, so poll until the item reaches a terminal
// or parked phase (the full flow is build → review → merge, real git + fetches).
const SETTLED = ["shipped", "parked", "closed"];
async function settle(
  h: Awaited<ReturnType<typeof harness>>,
  num = 1,
  timeoutMs = 20_000,
  repo = "app",
): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const issue = h.store.getIssue("plat", repo, num);
    if (issue && SETTLED.includes(issue.phase)) return;
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
    fileWork(h, "app", { title: "build me", body: "please" });

    // Fire several ticks at once — the CAS claim must build exactly once.
    await Promise.all([d.tick(), d.tick(), d.tick()]);
    await settle(h);

    expect(builds).toBe(1);
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.phase).toBe("shipped");
    expect(issue.change_state).toBe("merged"); // auto-merged on a passing verdict
    expect(issue.state).toBe("closed"); // derived mirror
    expect(reconcileKicks).toBe(2); // once for the preview, once to ship the merge
    // The attempts ledger recorded the run.
    const attempts = h.store.listAttempts("plat", "app", 1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.verdict).toBe("pass");
    expect(attempts[0]?.builder_cost_usd).toBe(0.01);
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("Change attached");
    expect(comments).toContain("✅ PASS");
    expect(comments).toContain("Merged and shipping");
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
    fileWork(h, "app", { title: "guestbook", body: "messages" });
    await d.tick();
    await settle(h);

    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.change_state).toBe("open"); // the change exists, NOT merged
    expect(issue.phase).toBe("parked");
    expect(issue.parked_reason).toBe("rework-exhausted");
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("❌ FAIL");
    expect(comments).toContain("left for a human");
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
    fileWork(h, "app", { title: "widget", body: "b" });
    await d.tick();
    await settle(h);

    expect(builds).toBe(2); // initial build + one rework
    expect(reviews).toBe(2); // reviewed before and after the fix
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.phase).toBe("shipped");
    expect(issue.change_state).toBe("merged");
    // Both attempts in the ledger, first failed, second passed.
    const verdicts = h.store
      .listAttempts("plat", "app", 1)
      .map((a) => a.verdict);
    expect(verdicts).toEqual(["fail", "pass"]);
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("Reworking to fix");
    expect(comments).toContain("Merged and shipping");
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
    fileWork(h, "app", { title: "board", body: "b" });
    await d.tick();
    await settle(h);

    expect(builds).toBe(2); // initial + one rework
    expect(reviews).toBe(1); // the first verdict was injected, not a real review
    expect(h.store.getIssue("plat", "app", 1)?.change_state).toBe("merged");
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("add a length limit");
    expect(comments).toContain("demonstrate auto-rework");
    expect(comments).toContain("Merged and shipping");
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
    fileWork(h, "app", { title: "widget", body: "b" });
    await d.tick();
    await settle(h);

    expect(builds).toBe(2); // initial + one rework, then gives up
    expect(reviews).toBe(2);
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.change_state).toBe("open"); // left for a human
    expect(issue.phase).toBe("parked");
    expect(issue.parked_reason).toBe("rework-exhausted");
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
    fileWork(h, "app", { title: "x", body: "" });
    await d.tick();
    await settle(h);

    expect(reviewed).toBe(false); // never reviewed a preview that never came up
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.phase).toBe("parked");
    expect(issue.parked_reason).toBe("preview-never-up");
    expect(issue.change_state).toBe("open"); // the branch is left for a human
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
    fileWork(h, "platform", { title: "tweak the builder prompt", body: "b" });
    await d.tick();
    await settle(h, 1, 20_000, "platform");

    expect(reviewed).toBe(false); // config repo: no preview → the reviewer never runs
    const issue = h.store.getIssue("plat", "platform", 1)!;
    expect(issue.change_state).toBe("open"); // proposed, NOT auto-merged (human gate)
    expect(issue.phase).toBe("parked");
    expect(issue.parked_reason).toBe("self-repo-human-merge");

    // The human-gate Merge: the push event (which on plat/opd stops the
    // daemon for self-upgrade) must fire only AFTER the ledger says
    // shipped/merged — anything later than the event can die with the process.
    let atEvent: { phase: string; change: string | null } | null = null;
    h.git.onPush(() => {
      const i = h.store.getIssue("plat", "platform", 1)!;
      atEvent = { phase: i.phase, change: i.change_state };
    });
    Result.unwrap(await h.forge.mergeWork(h.admin, "plat", "platform", 1));
    expect(atEvent as unknown).toEqual({ phase: "shipped", change: "merged" });
    const comments = h.store
      .listComments("plat", "platform", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("Proposed the change");
    expect(comments).toContain("review the diff and Merge");
  });

  test("a declined build parks with the agent's explanation in the feed", async () => {
    const h = await harness();
    const runAgent: RunAgent = async () =>
      Result.ok({
        ok: true,
        result: "DECLINED: wrong repo — file this on plat/opd.",
        costUsd: 0.01,
        numTurns: 1,
      });
    const d = new Dispatcher(dispatcherReviewDeps(h, runAgent));
    fileWork(h, "app", { title: "x", body: "" });
    await d.tick();
    await settle(h);
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.phase).toBe("parked");
    expect(issue.parked_reason).toBe("declined");
    expect(issue.change_state).toBeNull(); // nothing was proposed
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("wrong repo — file this on plat/opd");
  });

  test("an app-template issue is PROPOSED for a human — no preview, no auto-merge", async () => {
    const h = await harness();
    const seed = await mkdtemp(join(tmpdir(), "op-tpl-"));
    dirs.push(seed);
    await writeFile(join(seed, "server.ts"), "// template\n");
    Result.unwrap(
      await h.forge.createRepo(h.admin, "plat", "app-template", {
        isTemplate: true,
      }),
    );
    Result.unwrap(
      await h.git.seedRepoFromDir("plat", "app-template", seed, "init"),
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
      await writeFile(join(run.cwd, "server.ts"), "// improved template\n");
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.02,
        numTurns: 1,
      });
    };
    const d = new Dispatcher(dispatcherReviewDeps(h, runAgent));
    fileWork(h, "app-template", { title: "polish the template", body: "b" });
    await d.tick();
    await settle(h, 1, 20_000, "app-template");

    expect(reviewed).toBe(false); // not deployed: no preview → no reviewer
    const issue = h.store.getIssue("plat", "app-template", 1)!;
    expect(issue.change_state).toBe("open"); // proposed, NOT auto-merged
    expect(issue.phase).toBe("parked");
    expect(issue.parked_reason).toBe("template-human-merge");
    const comments = h.store
      .listComments("plat", "app-template", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("template every future app starts from");
  });

  test("sweepStranded finishes a merge whose bookkeeping a restart cut short", async () => {
    const h = await harness();
    const seed = await mkdtemp(join(tmpdir(), "op-plat-"));
    dirs.push(seed);
    await writeFile(join(seed, "platform.json"), "{}\n");
    Result.unwrap(await h.forge.createRepo(h.admin, "plat", "platform"));
    Result.unwrap(
      await h.git.seedRepoFromDir("plat", "platform", seed, "init"),
    );
    const configAgent: RunAgent = async (run) => {
      await mkdir(join(run.cwd, "crew"), { recursive: true });
      await writeFile(join(run.cwd, "crew", "b.md"), "tweak\n");
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.01,
        numTurns: 1,
      });
    };
    const d = new Dispatcher(dispatcherReviewDeps(h, configAgent));
    fileWork(h, "platform", { title: "tweak", body: "b" });
    await d.tick();
    await settle(h, 1, 20_000, "platform"); // parked, change open

    // Simulate the interrupted merge: git merged, ledger writes lost.
    Result.unwrap(
      await h.git.mergeBranch(
        "plat",
        "platform",
        "main",
        "agent/issue-1",
        "merge",
      ),
    );
    expect(h.store.getIssue("plat", "platform", 1)!.phase).toBe("parked");

    // The next boot's sweep reads git as the truth and catches the ledger up.
    const d2 = new Dispatcher(dispatcherReviewDeps(h, null));
    d2.start(600_000);
    const t0 = performance.now();
    while (
      h.store.getIssue("plat", "platform", 1)!.phase !== "shipped" &&
      performance.now() - t0 < 10_000
    )
      await Bun.sleep(25);
    d2.stop();
    const repaired = h.store.getIssue("plat", "platform", 1)!;
    expect(repaired.phase).toBe("shipped");
    expect(repaired.change_state).toBe("merged");
    expect(repaired.state).toBe("closed");
    const comments = h.store
      .listComments("plat", "platform", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toContain("ledger is now caught up");
  });

  test("sweepStranded is race-safe: a concurrent phase change during the ancestor check never crashes or wrongly ships", async () => {
    const h = await harness();
    const seed = await mkdtemp(join(tmpdir(), "op-plat-"));
    dirs.push(seed);
    await writeFile(join(seed, "platform.json"), "{}\n");
    Result.unwrap(await h.forge.createRepo(h.admin, "plat", "platform"));
    Result.unwrap(
      await h.git.seedRepoFromDir("plat", "platform", seed, "init"),
    );
    const configAgent: RunAgent = async (run) => {
      await mkdir(join(run.cwd, "crew"), { recursive: true });
      await writeFile(join(run.cwd, "crew", "b.md"), "tweak\n");
      return Result.ok({
        ok: true,
        result: "done",
        costUsd: 0.01,
        numTurns: 1,
      });
    };
    const d = new Dispatcher(dispatcherReviewDeps(h, configAgent));
    fileWork(h, "platform", { title: "tweak", body: "b" });
    await d.tick();
    await settle(h, 1, 20_000, "platform");
    Result.unwrap(
      await h.git.mergeBranch("plat", "platform", "main", "agent/issue-1", "m"),
    );

    // A git whose isAncestor, mid-check, simulates a human closing the item
    // (parked → closed) — so the repair's setWorkPhase(...,'shipped') would be
    // an ILLEGAL transition. The guard must re-read and skip, never throw.
    const racingGit = new Proxy(h.git, {
      get(target, prop, recv) {
        if (prop === "isAncestor")
          return async (...args: unknown[]) => {
            h.forge.closeWork(h.admin, "plat", "platform", 1); // concurrent close
            return (target as unknown as { isAncestor: Function }).isAncestor(
              ...args,
            );
          };
        return Reflect.get(target, prop, recv);
      },
    });
    const deps = { ...dispatcherReviewDeps(h, null), git: racingGit };
    const d2 = new Dispatcher(deps);
    d2.start(600_000);
    await Bun.sleep(400); // let the guarded repair run to completion
    d2.stop();
    // Closed by the human, NOT force-shipped by the repair; process alive.
    const item = h.store.getIssue("plat", "platform", 1)!;
    expect(item.phase).toBe("closed");
  });

  test("without a credential, stays queued and does not build (no stale comment)", async () => {
    const h = await harness();
    const d = new Dispatcher(dispatcherReviewDeps(h, null, { httpsPort: 443 }));
    fileWork(h, "app", { title: "x", body: "" });
    await d.tick();
    await Bun.sleep(50);
    const issue = h.store.getIssue("plat", "app", 1)!;
    expect(issue.phase).toBe("queued"); // stays queued until a credential appears
    expect(issue.change_state).toBeNull();
    // No lingering comment — the console's live crew pill shows the token nudge,
    // so a work item's feed never carries a stale "not credentialed" note.
    const comments = h.store
      .listComments("plat", "app", 1)
      .map((c) => c.body)
      .join("\n");
    expect(comments).toBe("");
  });
});
