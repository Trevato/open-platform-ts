import { afterAll, describe, expect, test } from "bun:test";
import { constants, Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, stateDir } from "@op/core";
import {
  branchData,
  deleteBranchData,
  listSnapshots,
  provisionDataDir,
  restore,
  snapshot,
} from "@op/data";

const root = mkdtempSync(join(tmpdir(), "op-data-"));
const sd = stateDir(root);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function openLiveDb(dir: string): Database {
  const db = new Database(join(dir, "app.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  return db;
}

function rowCount(dbFile: string): number {
  // immutable: snapshot/restored dbs are WAL-mode with no -shm/-wal on disk,
  // which a plain readonly open refuses (SQLITE_CANTOPEN). SQLITE_OPEN_URI is
  // required for bun:sqlite to parse the file: URI off-macOS (see the same
  // flag in verifySnapshotDb).
  const db = new Database(
    `file:${dbFile}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  );
  try {
    const row = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t")
      .get();
    return row?.n ?? -1;
  } finally {
    db.close();
  }
}

describe("provisionDataDir", () => {
  test("creates <owner>/<app>/files, 0777, idempotent, absolute", async () => {
    const dir = Result.unwrap(await provisionDataDir(sd, "alice", "blog"));
    expect(dir.startsWith("/")).toBe(true);
    expect(existsSync(join(dir, "files"))).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o777);
    expect((await stat(join(dir, "files"))).mode & 0o777).toBe(0o777);
    const again = Result.unwrap(await provisionDataDir(sd, "alice", "blog"));
    expect(again).toBe(dir);
  });

  test("rejects invalid names", async () => {
    const res = await provisionDataDir(sd, "../evil", "app");
    expect(res.status).toBe("error");
  });
});

describe("branchData (copy-on-write data branch)", () => {
  test("a branch forks prod's rows but diverges independently", async () => {
    const prod = Result.unwrap(await provisionDataDir(sd, "carol", "shop"));
    const db = openLiveDb(prod);
    db.run("INSERT INTO t (v) VALUES ('base1'), ('base2')");
    db.close();

    const branch = Result.unwrap(await branchData(sd, "carol", "shop", "pr-1"));
    expect(branch).toContain("shop@pr-1");
    // The branch starts with prod's rows...
    expect(rowCount(join(branch, "app.db"))).toBe(2);

    // ...then mutate the branch and prod independently.
    const bdb = new Database(join(branch, "app.db"));
    bdb.run("INSERT INTO t (v) VALUES ('branch-only')");
    bdb.close();
    const pdb = new Database(join(prod, "app.db"));
    pdb.run("INSERT INTO t (v) VALUES ('prod-only-1'), ('prod-only-2')");
    pdb.close();

    expect(rowCount(join(branch, "app.db"))).toBe(3); // 2 base + 1 branch
    expect(rowCount(join(prod, "app.db"))).toBe(4); // 2 base + 2 prod

    // Idempotent: re-branching reuses the existing dir (does not re-clone).
    const again = Result.unwrap(await branchData(sd, "carol", "shop", "pr-1"));
    expect(again).toBe(branch);
    expect(rowCount(join(branch, "app.db"))).toBe(3);

    // files/ ride along in the clone.
    const filesBranch = Result.unwrap(
      await branchData(sd, "carol", "shop", "pr-2"),
    );
    await writeFile(join(prod, "files", "a.txt"), "x");
    const withFiles = Result.unwrap(
      await branchData(sd, "carol", "shop", "pr-3"),
    );
    expect(existsSync(join(withFiles, "files"))).toBe(true);
    void filesBranch;

    Result.unwrap(await deleteBranchData(sd, "carol", "shop", "pr-1"));
    expect(existsSync(branch)).toBe(false);
  });

  test("branching an app with no prod data yields an empty branch dir", async () => {
    const branch = Result.unwrap(await branchData(sd, "dave", "fresh", "pr-9"));
    expect(existsSync(join(branch, "files"))).toBe(true);
    expect(existsSync(join(branch, "app.db"))).toBe(false);
  });
});

describe("snapshot / restore cycle", () => {
  test("full cycle: hot WAL db + files → snapshot → mutate → restore", async () => {
    const dir = Result.unwrap(await provisionDataDir(sd, "bob", "shop"));
    const db = openLiveDb(dir);
    db.run("INSERT INTO t (v) VALUES (?), (?)", ["one", "two"]);
    // No close, no checkpoint — the WAL stays hot, like a running app.
    expect(Bun.file(join(dir, "app.db-wal")).size).toBeGreaterThan(0);
    await writeFile(join(dir, "files", "upload.txt"), "v1");

    const snap = Result.unwrap(await snapshot(sd, "bob", "shop"));
    expect(snap.dir.endsWith(snap.id)).toBe(true);
    expect(rowCount(join(snap.dir, "app.db"))).toBe(2);
    expect(await readFile(join(snap.dir, "files", "upload.txt"), "utf8")).toBe(
      "v1",
    );

    db.run("INSERT INTO t (v) VALUES (?)", ["three"]);
    await writeFile(join(dir, "files", "upload.txt"), "v2");
    const snap2 = Result.unwrap(await snapshot(sd, "bob", "shop"));

    const list = Result.unwrap(await listSnapshots(sd, "bob", "shop"));
    expect(list).toEqual([snap.id, snap2.id]);
    expect(Number(snap2.id)).toBeGreaterThan(Number(snap.id));

    db.close(); // caller stops the app before restore
    Result.unwrap(await restore(sd, "bob", "shop", snap.id));
    expect(rowCount(join(dir, "app.db"))).toBe(2);
    expect(await readFile(join(dir, "files", "upload.txt"), "utf8")).toBe("v1");
    expect((await stat(dir)).mode & 0o777).toBe(0o777);
  });

  test("files-only app (no db) snapshots fine", async () => {
    const dir = Result.unwrap(await provisionDataDir(sd, "carol", "static"));
    await writeFile(join(dir, "files", "index.html"), "<h1>hi</h1>");
    const snap = Result.unwrap(await snapshot(sd, "carol", "static"));
    expect(existsSync(join(snap.dir, "app.db"))).toBe(false);
    expect(await readFile(join(snap.dir, "files", "index.html"), "utf8")).toBe(
      "<h1>hi</h1>",
    );
  });

  test("snapshot of an unprovisioned app errors", async () => {
    const res = await snapshot(sd, "nobody", "nothing");
    expect(res.status).toBe("error");
  });

  test("listSnapshots of an unsnapshotted app is empty", async () => {
    Result.unwrap(await provisionDataDir(sd, "dave", "fresh"));
    expect(Result.unwrap(await listSnapshots(sd, "dave", "fresh"))).toEqual([]);
  });

  test("restore of a missing snapshot errors", async () => {
    const res = await restore(sd, "bob", "shop", "1234567890123");
    expect(res.status).toBe("error");
  });

  test("corrupt live db never becomes a snapshot", async () => {
    const dir = Result.unwrap(await provisionDataDir(sd, "eve", "broken"));
    const db = openLiveDb(dir);
    db.run("INSERT INTO t (v) VALUES (?)", ["x".repeat(2000)]);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
    // Stomp page 2's b-tree page header — structural damage that
    // integrity_check must flag (payload-only damage passes).
    const bytes = new Uint8Array(await Bun.file(join(dir, "app.db")).bytes());
    bytes.fill(0xff, 4096, 4160);
    await writeFile(join(dir, "app.db"), bytes);

    const res = await snapshot(sd, "eve", "broken");
    expect(res.status).toBe("error");
    expect(Result.unwrap(await listSnapshots(sd, "eve", "broken"))).toEqual([]);
  });
});
