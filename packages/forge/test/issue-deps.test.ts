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
  const dir = mkdtempSync(join(tmpdir(), "op-idep-"));
  dirs.push(dir);
  const sd = stateDir(dir);
  const store = new Store(sd.dbFile);
  const forge = new Forge(store, new GitHost(sd, { log: createLog("t") }));
  const ada = Result.unwrap(await forge.createUser("ada", "pw-123456"));
  const bob = Result.unwrap(await forge.createUser("bob", "pw-123456"));
  Result.unwrap(await forge.createRepo(ada, "ada", "app"));
  const mk = (title: string) =>
    Result.unwrap(forge.createIssue(ada, "ada", "app", { title })).number;
  return { store, forge, ada, bob, mk };
}

describe("issue dependencies", () => {
  test("blocked-by edge gates only while the blocker is open", async () => {
    const h = await harness();
    const a = h.mk("feature"); // #1
    const b = h.mk("prerequisite"); // #2
    Result.unwrap(h.forge.setIssueDep(h.ada, "ada", "app", a, b)); // #1 blocked by #2
    expect(h.store.openBlockers("ada", "app", a)).toEqual([b]);

    // Close the blocker → the edge remains, but it no longer gates.
    Result.unwrap(h.forge.closeIssue(h.ada, "ada", "app", b));
    expect(h.store.listIssueBlockers("ada", "app", a)).toEqual([b]);
    expect(h.store.openBlockers("ada", "app", a)).toEqual([]);
  });

  test("rejects a dependency on an item already past 'queued' (silent-ignore guard)", async () => {
    const h = await harness();
    const a = h.mk("dependent"); // #1, intent
    const b = h.mk("blocker"); // #2, intent
    // Queue #1 then advance it to building (what the dispatcher's claim does).
    h.store.setWorkPhase("ada", "app", a, "queued");
    h.store.claimWork("ada", "app", a); // → building
    const r = h.forge.setIssueDep(h.ada, "ada", "app", a, b);
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error.message).toContain("already in");
    // Still allowed while queued (before the crew claims it).
    const c = h.mk("dep2"); // #3, intent
    h.store.setWorkPhase("ada", "app", c, "queued");
    Result.unwrap(h.forge.setIssueDep(h.ada, "ada", "app", c, b));
  });

  test("rejects self-edges and cycles (graph stays a DAG)", async () => {
    const h = await harness();
    const a = h.mk("a");
    const b = h.mk("b");
    const c = h.mk("c");
    expect(h.forge.setIssueDep(h.ada, "ada", "app", a, a).status).toBe("error");
    Result.unwrap(h.forge.setIssueDep(h.ada, "ada", "app", a, b)); // a←b
    Result.unwrap(h.forge.setIssueDep(h.ada, "ada", "app", b, c)); // b←c
    // c depending on a would close the loop a→b→c→a.
    expect(h.forge.setIssueDep(h.ada, "ada", "app", c, a).status).toBe("error");
  });

  test("write-gated; unknown issues rejected; removable", async () => {
    const h = await harness();
    const a = h.mk("a");
    const b = h.mk("b");
    // bob can't write ada's repo.
    expect(h.forge.setIssueDep(h.bob, "ada", "app", a, b).status).toBe("error");
    // non-existent blocker.
    expect(h.forge.setIssueDep(h.ada, "ada", "app", a, 999).status).toBe(
      "error",
    );
    Result.unwrap(h.forge.setIssueDep(h.ada, "ada", "app", a, b));
    Result.unwrap(h.forge.removeIssueDep(h.ada, "ada", "app", a, b));
    expect(h.store.listIssueBlockers("ada", "app", a)).toEqual([]);
  });
});
