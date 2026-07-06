import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, stateDir } from "@op/core";
import { listSnapshots, provisionDataDir, restore, snapshot } from "@op/data";

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
  // which a plain readonly open refuses (SQLITE_CANTOPEN).
  const db = new Database(`file:${dbFile}?immutable=1`, { readonly: true });
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
