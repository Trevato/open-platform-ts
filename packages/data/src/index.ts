import { constants, Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StateDir } from "@op/core";
import { isValidName, Result, TaggedError } from "@op/core";

export class DataError extends TaggedError("DataError")<{
  message: string;
  op: string;
}>() {}

const DB_ARTIFACTS = new Set(["app.db", "app.db-wal", "app.db-shm"]);

function invalid(op: string, owner: string, app: string) {
  return Result.err(
    new DataError({ message: `invalid app name: ${owner}/${app}`, op }),
  );
}

function liveDir(sd: StateDir, owner: string, app: string): string {
  return resolve(sd.appdataDir, owner, app);
}

function snapshotsDir(sd: StateDir, owner: string, app: string): string {
  return resolve(sd.appdataDir, ".snapshots", owner, app);
}

/** mkdir appdata/<owner>/<app>/files; returns absolute dir. Idempotent. */
export async function provisionDataDir(
  sd: StateDir,
  owner: string,
  app: string,
): Promise<Result<string, DataError>> {
  const op = "provisionDataDir";
  if (!isValidName(owner) || !isValidName(app)) return invalid(op, owner, app);
  const dir = liveDir(sd, owner, app);
  return Result.tryPromise({
    try: async () => {
      await mkdir(join(dir, "files"), { recursive: true });
      // 0777 so the container's unprivileged 65534:65534 user can write to
      // the bind mount without a host-side chown (mkdir mode is umask-masked,
      // hence explicit chmod).
      await chmod(dir, 0o777);
      await chmod(join(dir, "files"), 0o777);
      return dir;
    },
    catch: (cause) => new DataError({ message: String(cause), op }),
  });
}

/** Flush the WAL into the main db file from the host side; POSIX locks
 *  coordinate with a running app on the same host. */
function checkpoint(dbFile: string): void {
  const db = new Database(dbFile);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}

async function cloneDir(src: string, dest: string): Promise<void> {
  // APFS clonefile
  const apfs = Bun.spawn(["cp", "-c", "-R", src, dest], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await apfs.exited) === 0) return;
  await rm(dest, { recursive: true, force: true });

  // GNU coreutils reflink (XFS/btrfs)
  const reflink = Bun.spawn(["cp", "-a", "--reflink=always", src, dest], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await reflink.exited) === 0) return;
  await rm(dest, { recursive: true, force: true });

  // No CoW available: VACUUM INTO gives a consistent db copy even without
  // an atomic clone; everything else is a plain copy.
  await mkdir(dest, { recursive: true });
  const dbFile = join(src, "app.db");
  if (existsSync(dbFile)) {
    const db = new Database(dbFile);
    try {
      db.run("VACUUM INTO ?", [join(dest, "app.db")]);
    } finally {
      db.close();
    }
  }
  for (const entry of await readdir(src)) {
    if (DB_ARTIFACTS.has(entry)) continue;
    await cp(join(src, entry), join(dest, entry), { recursive: true });
  }
}

// Recursively make a data tree readable+writable by any container user: dirs
// 0777, files 0666. Used after a cross-platform import, where the copied files
// are owned by the daemon, not the app's non-root container user.
async function makeContainerWritable(dir: string): Promise<void> {
  await chmod(dir, 0o777);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await makeContainerWritable(p);
    else await chmod(p, 0o666);
  }
}

function verifySnapshotDb(dbFile: string): string | null {
  let db: Database;
  try {
    // Plain readonly can't open a WAL-mode db whose -shm/-wal are absent
    // (SQLITE_CANTOPEN); immutable=1 is the sanctioned way to read a file
    // nothing else is writing — exactly what a snapshot is. %/?/# would
    // corrupt the URI, so escape them (sd.root is operator-chosen).
    // SQLITE_OPEN_URI is REQUIRED: bun:sqlite on Linux does not parse a
    // `file:…?immutable=1` filename as a URI without it (the {readonly:true}
    // form silently treats the whole string as a literal path → "unable to
    // open database file"). macOS's system SQLite enables URI by default,
    // which is why this only broke off-Mac. The flag makes it portable.
    const uri = dbFile.replace(/[%?#]/g, (c) => encodeURIComponent(c));
    db = new Database(
      `file:${uri}?immutable=1`,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
    );
  } catch (cause) {
    return String(cause);
  }
  try {
    const row = db.query("PRAGMA integrity_check").get() as Record<
      string,
      string
    > | null;
    const verdict = row ? Object.values(row)[0] : undefined;
    return verdict === "ok" ? null : `integrity_check: ${verdict ?? "empty"}`;
  } catch (cause) {
    return String(cause);
  } finally {
    db.close();
  }
}

/**
 * Crash-consistent snapshot: checkpoint the WAL, CoW-clone the app dir,
 * verify the clone's db. Never returns a snapshot that failed verification.
 */
export async function snapshot(
  sd: StateDir,
  owner: string,
  app: string,
): Promise<Result<{ id: string; dir: string }, DataError>> {
  const op = "snapshot";
  if (!isValidName(owner) || !isValidName(app)) return invalid(op, owner, app);
  const live = liveDir(sd, owner, app);
  if (!existsSync(live))
    return Result.err(
      new DataError({ message: `no data dir for ${owner}/${app}`, op }),
    );

  return Result.tryPromise({
    try: async () => {
      const dbFile = join(live, "app.db");
      if (existsSync(dbFile)) checkpoint(dbFile);

      const parent = snapshotsDir(sd, owner, app);
      await mkdir(parent, { recursive: true });
      let ms = Date.now();
      while (existsSync(join(parent, String(ms)))) ms++;
      const id = String(ms);
      const dir = join(parent, id);

      // Any failure past here must leave NO snapshot dir behind — a partial or
      // unverified clone must never be listable. (cloneDir creates the dir
      // before it can throw, e.g. a VACUUM-INTO fallback erroring on a corrupt
      // source; without this catch that empty dir would linger and count as a
      // snapshot.)
      try {
        await cloneDir(live, dir);
        // Post-checkpoint the wal is empty and the shm is a live-session
        // artifact; a cloned shm can force readonly-recovery and fail the
        // readonly verification open. The snapshot is app.db as of the
        // checkpoint — exactly the crash-consistency we promise.
        await rm(join(dir, "app.db-wal"), { force: true });
        await rm(join(dir, "app.db-shm"), { force: true });

        const snapDb = join(dir, "app.db");
        if (existsSync(snapDb)) {
          const failure = verifySnapshotDb(snapDb);
          if (failure !== null)
            throw new Error(`snapshot verification failed: ${failure}`);
        }
        return { id, dir };
      } catch (cause) {
        await rm(dir, { recursive: true, force: true });
        throw cause;
      }
    },
    catch: (cause) => new DataError({ message: String(cause), op }),
  });
}

// Preview/data-branch directory: appdata/<owner>/<app>@<branch>/. A distinct
// name (never a valid app) so it can never collide with a real app's live dir.
function branchDir(
  sd: StateDir,
  owner: string,
  app: string,
  branch: string,
): string {
  return resolve(sd.appdataDir, owner, `${app}@${branch}`);
}

/**
 * The data-branch primitive (the Lore-inspired arc, step one): give a preview
 * its OWN data as a copy-on-write clone of prod, quiesced first so it's
 * crash-consistent. Idempotent — an existing branch dir is reused (a preview's
 * data persists across its redeploys, exactly like prod). Prod with no data yet
 * yields an empty branch dir.
 */
export async function branchData(
  sd: StateDir,
  owner: string,
  app: string,
  branch: string,
): Promise<Result<string, DataError>> {
  const op = "branchData";
  if (!isValidName(owner) || !isValidName(app) || !isValidName(branch))
    return Result.err(
      new DataError({
        message: `invalid branch: ${owner}/${app}@${branch}`,
        op,
      }),
    );
  const dest = branchDir(sd, owner, app, branch);
  return Result.tryPromise({
    try: async () => {
      if (existsSync(dest)) {
        await chmod(dest, 0o777);
        const f = join(dest, "files");
        if (existsSync(f)) await chmod(f, 0o777);
        return dest;
      }
      const live = liveDir(sd, owner, app);
      if (!existsSync(live)) {
        await mkdir(join(dest, "files"), { recursive: true });
      } else {
        const dbFile = join(live, "app.db");
        if (existsSync(dbFile)) checkpoint(dbFile);
        await cloneDir(live, dest);
        await rm(join(dest, "app.db-wal"), { force: true });
        await rm(join(dest, "app.db-shm"), { force: true });
      }
      await chmod(dest, 0o777);
      const files = join(dest, "files");
      if (existsSync(files)) await chmod(files, 0o777);
      return dest;
    },
    catch: (cause) => new DataError({ message: String(cause), op }),
  });
}

export async function deleteBranchData(
  sd: StateDir,
  owner: string,
  app: string,
  branch: string,
): Promise<Result<void, DataError>> {
  const op = "deleteBranchData";
  if (!isValidName(owner) || !isValidName(app) || !isValidName(branch))
    return Result.err(
      new DataError({
        message: `invalid branch: ${owner}/${app}@${branch}`,
        op,
      }),
    );
  return Result.tryPromise({
    try: async () => {
      await rm(branchDir(sd, owner, app, branch), {
        recursive: true,
        force: true,
      });
    },
    catch: (cause) => new DataError({ message: String(cause), op }),
  });
}

export async function listSnapshots(
  sd: StateDir,
  owner: string,
  app: string,
): Promise<Result<string[], DataError>> {
  const op = "listSnapshots";
  if (!isValidName(owner) || !isValidName(app)) return invalid(op, owner, app);
  const dir = snapshotsDir(sd, owner, app);
  if (!existsSync(dir)) return Result.ok([]);
  return Result.tryPromise({
    try: async () => {
      const entries = await readdir(dir);
      return entries.sort((a, b) => Number(a) - Number(b));
    },
    catch: (cause) => new DataError({ message: String(cause), op }),
  });
}

/**
 * Ingest an app's data from an EXTERNAL directory (an app-seed's unpacked data)
 * into this platform's live dir for owner/app. Refuses to clobber an existing
 * live dir, verifies the imported db opens cleanly (integrity_check), and sets
 * the container-writable modes. The source is a snapshot-shaped dir: app.db
 * (+ optional files/), no live -wal/-shm.
 */
export async function importDataDir(
  sd: StateDir,
  owner: string,
  app: string,
  srcDir: string,
): Promise<Result<void, DataError>> {
  const op = "importDataDir";
  if (!isValidName(owner) || !isValidName(app)) return invalid(op, owner, app);
  if (!existsSync(srcDir))
    return Result.err(
      new DataError({ message: `no source data dir: ${srcDir}`, op }),
    );
  const live = liveDir(sd, owner, app);
  if (existsSync(live))
    return Result.err(
      new DataError({
        message: `data dir already exists: ${owner}/${app}`,
        op,
      }),
    );
  return Result.tryPromise({
    try: async () => {
      await mkdir(join(live, ".."), { recursive: true });
      await cp(srcDir, live, { recursive: true });
      // A migrated db must open cleanly here or the import is not trustworthy.
      const dbFile = join(live, "app.db");
      if (existsSync(dbFile)) {
        const failure = verifySnapshotDb(dbFile);
        if (failure !== null) {
          await rm(live, { recursive: true, force: true });
          throw new DataError({
            message: `imported db failed verification: ${failure}`,
            op,
          });
        }
      } else {
        // No db in the artifact — still guarantee the standard layout exists.
        await mkdir(join(live, "files"), { recursive: true });
      }
      // The importing daemon owns the copied tree, but the app runs as a
      // DIFFERENT (non-root) container user and must read AND write its own
      // db + blobs. Same-platform clones keep the app's own ownership; a
      // cross-platform import does not — so make every copied file writable,
      // not just the dirs (a 0644 app.db → the container can't open it rw →
      // the app crashes on boot).
      await makeContainerWritable(live);
    },
    catch: (cause) =>
      cause instanceof DataError
        ? cause
        : new DataError({ message: String(cause), op }),
  });
}

/** Replaces the live data dir with the snapshot (app must be stopped by caller). */
export async function restore(
  sd: StateDir,
  owner: string,
  app: string,
  snapshotId: string,
): Promise<Result<void, DataError>> {
  const op = "restore";
  if (!isValidName(owner) || !isValidName(app)) return invalid(op, owner, app);
  if (!/^\d+$/.test(snapshotId))
    return Result.err(
      new DataError({ message: `invalid snapshot id: ${snapshotId}`, op }),
    );
  const snapDir = join(snapshotsDir(sd, owner, app), snapshotId);
  if (!existsSync(snapDir))
    return Result.err(
      new DataError({
        message: `snapshot ${snapshotId} not found for ${owner}/${app}`,
        op,
      }),
    );
  const live = liveDir(sd, owner, app);
  return Result.tryPromise({
    try: async () => {
      await rm(live, { recursive: true, force: true });
      await cp(snapDir, live, { recursive: true });
      // Restore the container-writable modes (see provisionDataDir).
      await chmod(live, 0o777);
      const files = join(live, "files");
      if (existsSync(files)) await chmod(files, 0o777);
    },
    catch: (cause) => new DataError({ message: String(cause), op }),
  });
}
