import { join } from "node:path";
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
  return {
    root,
    dbFile: join(root, "db.sqlite"),
    keyFile: join(root, "key.age"),
    reposDir: join(root, "repos"),
    appdataDir: join(root, "appdata"),
    certsDir: join(root, "certs"),
    originFile: join(root, "ORIGIN"),
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
