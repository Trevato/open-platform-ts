import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@op/store";

let dirs: string[] = [];
function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "op-store-"));
  dirs.push(dir);
  return new Store(join(dir, "db.sqlite"));
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("Store", () => {
  test("opens in WAL mode", () => {
    const s = freshStore();
    const row = s.db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();
    expect(row?.journal_mode).toBe("wal");
    s.close();
  });

  test("migrations are idempotent across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "op-store-"));
    dirs.push(dir);
    const file = join(dir, "db.sqlite");
    new Store(file).close();
    const s = new Store(file); // second open must not re-apply
    expect(s.listRepos()).toEqual([]);
    s.close();
  });

  test("user + token roundtrip", () => {
    const s = freshStore();
    const user = s.createUser("ada", "hash123", true);
    s.createToken(user.id, "ci", "tokenhash456");
    expect(s.userByTokenHash("tokenhash456")?.username).toBe("ada");
    expect(s.userByTokenHash("wrong")).toBeNull();
    s.close();
  });

  test("session expiry is enforced", () => {
    const s = freshStore();
    const user = s.createUser("ada", "h");
    const live = s.createSession(user.id, 60_000);
    const dead = s.createSession(user.id, -1);
    expect(s.userBySession(live.id)?.username).toBe("ada");
    expect(s.userBySession(dead.id)).toBeNull();
    s.close();
  });

  test("repo uniqueness per owner", () => {
    const s = freshStore();
    s.createRepo("ada", "hello");
    expect(() => s.createRepo("ada", "hello")).toThrow();
    s.createRepo("bob", "hello"); // same name, different owner is fine
    expect(s.getRepo("ada", "hello")?.owner).toBe("ada");
    s.close();
  });

  test("deploy events: newest-first + bounded to 60", () => {
    const s = freshStore();
    for (let i = 0; i < 70; i++)
      s.appendEvent("ada", "hello", "building", `step ${i}`, "abc");
    const events = s.listEvents("ada", "hello", 100);
    expect(events.length).toBe(60); // oldest 10 pruned
    expect(events[0]!.message).toBe("step 69"); // newest first
    expect(events[59]!.message).toBe("step 10");
    // isolation between apps
    s.appendEvent("bob", "other", "running", "x", null);
    expect(s.listEvents("bob", "other").length).toBe(1);
    s.close();
  });

  test("host table upsert + resolve", () => {
    const s = freshStore();
    s.setHost("hello-ada.plat.localtest.me", "ada", "hello", "c1", 3000);
    s.setHost("hello-ada.plat.localtest.me", "ada", "hello", "c2", 3001);
    const row = s.resolveHost("hello-ada.plat.localtest.me");
    expect(row?.container_id).toBe("c2");
    expect(row?.container_port).toBe(3001);
    s.deleteHostsFor("ada", "hello");
    expect(s.resolveHost("hello-ada.plat.localtest.me")).toBeNull();
    s.close();
  });

  test("work items: legal-edge phase machine, CAS claim, derived state", () => {
    const s = freshStore();
    s.createRepo("ada", "shop");
    const item = s.createIssue("ada", "shop", {
      title: "checkout",
      body: "",
      author: "ada",
      labels: ["agent-work"],
    });
    expect(item.phase).toBe("intent");

    s.setWorkPhase("ada", "shop", item.number, "queued");
    // Claim is a CAS: first wins, second loses cleanly (no throw).
    expect(s.claimWork("ada", "shop", item.number)).toBe(true);
    expect(s.claimWork("ada", "shop", item.number)).toBe(false);

    // Illegal jump throws and mutates nothing.
    expect(() => s.setWorkPhase("ada", "shop", item.number, "shipped")).toThrow(
      /illegal transition building → shipped/,
    );
    expect(s.getIssue("ada", "shop", item.number)?.phase).toBe("building");

    s.attachChange("ada", "shop", item.number, {
      head: `agent/issue-${item.number}`,
      base: "main",
    });
    s.setWorkPhase("ada", "shop", item.number, "reviewing");
    expect(s.listOpenChanges().map((w) => w.number)).toEqual([item.number]);

    s.setWorkPhase("ada", "shop", item.number, "reworking");
    s.setWorkPhase("ada", "shop", item.number, "reviewing");
    s.setWorkPhase("ada", "shop", item.number, "shipped");
    s.setChangeState("ada", "shop", item.number, "merged");

    const shipped = s.getIssue("ada", "shop", item.number);
    expect(shipped?.phase).toBe("shipped");
    expect(shipped?.state).toBe("closed"); // derived, one write site
    expect(shipped?.change_state).toBe("merged");
    // Terminal is terminal.
    expect(() => s.setWorkPhase("ada", "shop", item.number, "queued")).toThrow(
      /illegal/,
    );
    s.close();
  });

  test("work items: parked carries a reason; re-queue clears it", () => {
    const s = freshStore();
    s.createRepo("ada", "shop");
    const item = s.createIssue("ada", "shop", {
      title: "x",
      body: "",
      author: "ada",
      labels: [],
    });
    s.setWorkPhase("ada", "shop", item.number, "queued");
    s.claimWork("ada", "shop", item.number);
    s.setWorkPhase("ada", "shop", item.number, "parked", {
      parkedReason: "preview-never-up",
    });
    expect(s.getIssue("ada", "shop", item.number)?.parked_reason).toBe(
      "preview-never-up",
    );
    s.setWorkPhase("ada", "shop", item.number, "queued");
    const requeued = s.getIssue("ada", "shop", item.number);
    expect(requeued?.phase).toBe("queued");
    expect(requeued?.parked_reason).toBeNull();
    s.close();
  });

  test("work attempts: append-only ledger with monotone numbering", () => {
    const s = freshStore();
    s.createRepo("ada", "shop");
    const item = s.createIssue("ada", "shop", {
      title: "x",
      body: "",
      author: "ada",
      labels: [],
    });
    expect(
      s.openWorkAttempt("ada", "shop", item.number, { builderCostUsd: 1.42 }),
    ).toBe(1);
    s.setAttemptVerdict("ada", "shop", item.number, 1, {
      verdict: "fail",
      verdictLine: "FAIL — cart total ignores qty",
      reviewerCostUsd: 0.31,
    });
    expect(s.openWorkAttempt("ada", "shop", item.number)).toBe(2);
    expect(s.countAttempts("ada", "shop", item.number)).toBe(2);
    const ledger = s.listAttempts("ada", "shop", item.number);
    expect(ledger[0]?.verdict).toBe("fail");
    expect(ledger[0]?.verdict_line).toContain("cart total");
    expect(ledger[1]?.verdict).toBeNull();
    s.close();
  });

  test("work deps: cross-repo blockers gate until terminal", () => {
    const s = freshStore();
    s.createRepo("ada", "website");
    s.createRepo("ada", "shop");
    const site = s.createIssue("ada", "website", {
      title: "storefront link",
      body: "",
      author: "ada",
      labels: [],
    });
    const shop = s.createIssue("ada", "shop", {
      title: "catalog api",
      body: "",
      author: "ada",
      labels: [],
    });
    const siteRef = { owner: "ada", repo: "website", number: site.number };
    const shopRef = { owner: "ada", repo: "shop", number: shop.number };
    s.addWorkDep(siteRef, shopRef);
    expect(s.openWorkBlockers("ada", "website", site.number)).toHaveLength(1);

    // A parked blocker still blocks; only terminal phases unblock.
    s.setWorkPhase("ada", "shop", shop.number, "queued");
    s.claimWork("ada", "shop", shop.number);
    s.setWorkPhase("ada", "shop", shop.number, "parked", {
      parkedReason: "rework-exhausted",
    });
    expect(s.openWorkBlockers("ada", "website", site.number)).toHaveLength(1);
    s.setWorkPhase("ada", "shop", shop.number, "closed");
    expect(s.openWorkBlockers("ada", "website", site.number)).toHaveLength(0);
    s.close();
  });

  test("app_ports: sticky allocation, binding updates, release on removal", () => {
    const s = freshStore();
    const range: [number, number] = [25500, 25502];

    // Allocation is stable per (owner, app, containerPort) across calls.
    expect(s.allocateAppPort("ada", "mc", 25565, range)).toBe(25500);
    expect(s.allocateAppPort("ada", "mc", 25565, range)).toBe(25500);
    expect(s.allocateAppPort("ada", "mc", 25566, range)).toBe(25501);
    expect(s.allocateAppPort("bob", "mc", 25565, range)).toBe(25502);
    // Range exhausted → null, nothing inserted.
    expect(s.allocateAppPort("eve", "mc", 25565, range)).toBeNull();

    // Binding points the relay at the container's loopback port; null = stopped.
    s.setAppPortBinding("ada", "mc", 25565, 41234);
    const rows = s.listAppPortsFor("ada", "mc");
    expect(rows.map((r) => [r.public_port, r.host_port])).toEqual([
      [25500, 41234],
      [25501, null],
    ]);

    // Removal releases the app's ports; other apps keep theirs.
    s.deleteAppPortsFor("ada", "mc");
    expect(s.listAppPortsFor("ada", "mc")).toEqual([]);
    expect(s.listAppPorts().map((r) => r.public_port)).toEqual([25502]);
    // The freed port is reusable.
    expect(s.allocateAppPort("eve", "mc", 25565, range)).toBe(25500);
    s.close();
  });
});
