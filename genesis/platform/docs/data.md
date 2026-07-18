---
title: Data
description: Each app owns a directory — SQLite plus files — snapshotted, cloned, and restored as plain files.
---

App data on this platform is a directory, not a service. Each app gets its
own SQLite database plus a `files/` tree for blobs, and the platform
provisions that directory, mounts it into the container, snapshots it with
verification, forks it for previews, and ships it inside app exports. You
care about this page the moment your app stores anything.

## Where everything lives on disk

The platform's entire world sits under one state root
(`packages/core/src/paths.ts:7`):

| Path                                     | Contents                                               |
| ---------------------------------------- | ------------------------------------------------------ |
| `db.sqlite`                              | the platform store — users, repos, routing, work items |
| `key.age`                                | the sovereign key ([Sovereignty](/docs/sovereignty))   |
| `repos/<owner>/<name>.git`               | bare git repos — the desired state                     |
| `appdata/<owner>/<app>/`                 | one app's live data: `app.db` + `files/`               |
| `appdata/<owner>/<app>@<branch>/`        | preview data branches                                  |
| `appdata/.snapshots/<owner>/<app>/<id>/` | verified snapshots                                     |
| `certs/`                                 | platform CA and wildcard leaf                          |

> [!tip]
> Everything in this table is plain files. Any backup tool you already
> trust — `rsync`, `tar`, a filesystem snapshot — covers the whole platform
> by covering this one root.

## The app data directory

An app that declares data (see [the app manifest](/docs/app-manifest)) gets
`appdata/<owner>/<app>/` bind-mounted into its container at `/data`
(`packages/engine/src/index.ts:257`), and the container learns the path from
the `DATA_DIR` env var (`packages/opd/src/reconcile.ts:435`). Keep your
database at `$DATA_DIR/app.db` — that exact filename is what checkpointing
and snapshot verification operate on — and put blobs under `$DATA_DIR/files/`:

```ts title="server.ts"
import { Database } from "bun:sqlite";

const db = new Database(`${process.env.DATA_DIR}/app.db`);
```

Cached assets from `op.json` are fetched into this directory before the
container ever starts, so the app wakes up with its large files in place.

## Snapshots: verified or nothing

A snapshot (`packages/data/src/index.ts:148`) is three steps: checkpoint the
WAL from the host, clone the whole directory copy-on-write — APFS
`clonefile`, else `--reflink=always`, else a `VACUUM INTO` fallback
(`packages/data/src/index.ts:63`) — then open the clone read-only and run
`PRAGMA integrity_check`. A clone that fails verification is deleted and the
call errors (`packages/data/src/index.ts:189-196`): the platform never hands
you a bad snapshot. On a CoW filesystem a snapshot costs metadata, not a
full copy. Day-to-day operations — taking, listing, restoring — are on
[Snapshots](/docs/snapshots).

## Previews fork production data

A preview never shares prod's directory. The reconciler forks it as a
copy-on-write data branch (`packages/opd/src/reconcile.ts:392`) at
`appdata/<owner>/<app>@<branch>/` — `@` is illegal in app names, so a branch
can never collide with a real app's live dir. The fork is quiesced first and
idempotent: preview data survives redeploys, exactly like prod. The crew's
reviewer attacks realistic data shapes with zero risk to production; teardown
deletes the branch.

## Moving data between platforms

`op app export <owner>/<app>` bundles the app's full git history, its
manifest, and a fresh verified snapshot taken at export time
(`packages/opd/src/platform.ts:648`). On the receiving platform, `op app
import` lays the data down only if the app doesn't already have a live dir,
and verifies the imported database before accepting it. Restoring a snapshot
in place replaces the live directory wholesale
(`packages/data/src/index.ts:392`).

> [!warning]
> Restore assumes the app is stopped. Replacing `app.db` under a running
> container is a corruption risk the primitive does not guard against.

## Platform state is not app data

The platform's own SQLite database, `db.sqlite`, holds canonical platform
state — users and tokens, repos and orgs, host and TCP-port routing, deploy
history, OAuth clients, and the [work-item](/docs/work-items) phase machine.
Its schema only moves forward: migrations are append-only and applied in
order (`packages/store/src/schema.ts:1`). The split is deliberate: an app's
directory belongs to the tenant — snapshotted, branched, exportable — while
`db.sqlite`, build logs, and certs belong to the platform and never travel in
an app export.
