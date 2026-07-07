import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, Result, stateDir } from "@op/core";
import { GitHost } from "@op/git";
import { Store } from "@op/store";
import { Forge } from "../src/forge.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "op-iss-"));
  dirs.push(dir);
  const sd = stateDir(dir);
  const store = new Store(sd.dbFile);
  const forge = new Forge(store, new GitHost(sd, { log: createLog("t") }));
  const ada = Result.unwrap(await forge.createUser("ada", "pw-123456"));
  const bob = Result.unwrap(await forge.createUser("bob", "pw-123456"));
  Result.unwrap(await forge.createRepo(ada, "ada", "app"));
  return { store, forge, ada, bob };
}

describe("issues", () => {
  test("create → number → comment → close, newest-first listing", async () => {
    const h = await harness();
    const i1 = Result.unwrap(
      h.forge.createIssue(h.ada, "ada", "app", { title: "first" }),
    );
    const i2 = Result.unwrap(
      h.forge.createIssue(h.bob, "ada", "app", {
        title: "second",
        body: "details",
        labels: ["bug"],
      }),
    );
    expect([i1.number, i2.number]).toEqual([1, 2]);
    expect(i2.author).toBe("bob"); // anyone signed in can file
    expect(
      h.store.listIssues("ada", "app", "open").map((i) => i.number),
    ).toEqual([2, 1]);

    Result.unwrap(h.forge.comment(h.bob, "ada", "app", 1, "I hit this too"));
    Result.unwrap(h.forge.comment(h.ada, "ada", "app", 1, "looking"));
    expect(h.store.listComments("ada", "app", 1).map((c) => c.author)).toEqual([
      "bob",
      "ada",
    ]);

    Result.unwrap(h.forge.closeIssue(h.ada, "ada", "app", 1));
    expect(h.store.getIssue("ada", "app", 1)?.state).toBe("closed");
    expect(h.store.listIssues("ada", "app", "open").length).toBe(1);
  });

  test("agent-work label is discoverable across repos", async () => {
    const h = await harness();
    Result.unwrap(await h.forge.createRepo(h.ada, "ada", "site"));
    Result.unwrap(
      h.forge.createIssue(h.ada, "ada", "app", {
        title: "build me",
        labels: ["agent-work"],
      }),
    );
    Result.unwrap(
      h.forge.createIssue(h.ada, "ada", "site", {
        title: "and me",
        labels: ["agent-work", "ui"],
      }),
    );
    Result.unwrap(
      h.forge.createIssue(h.ada, "ada", "app", {
        title: "not this",
        labels: ["question"],
      }),
    );
    const work = h.store.listIssuesByLabel("agent-work");
    expect(work.map((i) => i.title).sort()).toEqual(["and me", "build me"]);
  });

  test("label changes need write; comments don't; close needs write", async () => {
    const h = await harness();
    const iss = Result.unwrap(
      h.forge.createIssue(h.ada, "ada", "app", { title: "x" }),
    );
    // bob (not owner/admin) can comment...
    expect(h.forge.comment(h.bob, "ada", "app", iss.number, "hi").status).toBe(
      "ok",
    );
    // ...but cannot relabel or close
    expect(
      h.forge.setIssueLabels(h.bob, "ada", "app", iss.number, ["agent-work"])
        .status,
    ).toBe("error");
    expect(h.forge.closeIssue(h.bob, "ada", "app", iss.number).status).toBe(
      "error",
    );
    // ada (owner) can relabel → the crew would pick it up
    const relabeled = Result.unwrap(
      h.forge.setIssueLabels(h.ada, "ada", "app", iss.number, ["agent-work"]),
    );
    expect(relabeled.labels).toBe("agent-work");
    expect(h.store.listIssuesByLabel("agent-work").length).toBe(1);
  });

  test("fails closed on missing repo/issue and empty input", async () => {
    const h = await harness();
    expect(
      h.forge.createIssue(h.ada, "ada", "ghost", { title: "x" }).status,
    ).toBe("error");
    expect(
      h.forge.createIssue(h.ada, "ada", "app", { title: "   " }).status,
    ).toBe("error");
    expect(h.forge.comment(h.ada, "ada", "app", 999, "x").status).toBe("error");
  });
});
