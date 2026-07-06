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
});
