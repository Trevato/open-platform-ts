import { join, resolve } from "node:path";
import { isValidName } from "./ids.ts";
import { panic } from "./result.ts";

// The platform's entire world on disk. Everything a seed carries, a backup
// covers, or a daughter mints lives under this one root.
export interface StateDir {
  readonly root: string;
  readonly dbFile: string; // canonical forge/identity data (SQLite, WAL)
  readonly keyFile: string; // sovereign age identity — THE key
  readonly reposDir: string; // bare git repos, canonical desired state
  readonly appdataDir: string; // per-app data dirs (app.db + files/)
  readonly certsDir: string; // platform CA + wildcard leaf
  readonly originFile: string; // plain-text lineage ledger
}

export function stateDir(root: string): StateDir {
  // Absolute from the start: downstream git operations run from temp working
  // directories, where a relative OP_ROOT would silently point nowhere.
  const abs = resolve(root);
  return {
    root: abs,
    dbFile: join(abs, "db.sqlite"),
    keyFile: join(abs, "key.age"),
    reposDir: join(abs, "repos"),
    appdataDir: join(abs, "appdata"),
    certsDir: join(abs, "certs"),
    originFile: join(abs, "ORIGIN"),
  };
}

// All path builders validate names — these are the only functions allowed to
// turn user input into filesystem paths.
export function repoPath(sd: StateDir, owner: string, name: string): string {
  if (!isValidName(owner) || !isValidName(name))
    panic(`invalid repo path: ${owner}/${name}`);
  return join(sd.reposDir, owner, `${name}.git`);
}

export function appDataDir(sd: StateDir, owner: string, app: string): string {
  if (!isValidName(owner) || !isValidName(app))
    panic(`invalid app path: ${owner}/${app}`);
  return join(sd.appdataDir, owner, app);
}

// Platform-owned build logs, kept OUT of the app's data dir (that dir is the
// tenant's, snapshotted and seedable; build logs are the platform's).
export function buildLogPath(sd: StateDir, owner: string, app: string): string {
  if (!isValidName(owner) || !isValidName(app))
    panic(`invalid build-log path: ${owner}/${app}`);
  return join(sd.root, "buildlogs", `${owner}__${app}.log`);
}
