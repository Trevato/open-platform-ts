---
title: Data snapshots
description: Verified point-in-time copies of an app's data — and the copy-on-write clones previews run on.
---

A snapshot is a point-in-time, integrity-verified copy of everything an app
stores: its `app.db` database plus its `files/` directory (see
[Data](/docs/data) for the layout). The platform takes one on demand, verifies
it before admitting it exists, and uses the same clone primitive to give
previews real data and to package apps for export. Take one before a risky
schema change or a bulk import.

## What a snapshot contains

The app's entire data directory, cloned as-is into
`appdata/.snapshots/<owner>/<app>/<id>/` beside the live dir. The ID is a
millisecond timestamp, so
listings sort chronologically. Clones are copy-on-write where the filesystem
allows it (APFS, XFS, btrfs), so a snapshot of a large app is near-instant and
initially costs almost no disk.

## Taking one

Press **Snapshot** on the app's console page, or hit the API — both call the
same route (`packages/opd/src/console/index.ts:842`):

```sh title="Terminal"
curl -sk -u plat:<password> -X POST \
  https://plat.localtest.me/api/v1/apps/plat/hello/snapshots
```

You need write access to the app; the route returns `201` with the new
snapshot's `id` (`packages/opd/src/api.ts:1217`). A `GET` on the same URL
lists existing snapshot IDs, oldest first (`packages/opd/src/api.ts:1220`).

## Checkpoint, clone, verify

Every snapshot goes through three steps, and a failure at the last one means
no snapshot at all (`packages/data/src/index.ts:195`):

1. **Checkpoint.** The platform flushes the app's WAL into `app.db` with
   `PRAGMA wal_checkpoint(TRUNCATE)` from the host side — SQLite's POSIX locks
   coordinate with the running container, so the app keeps serving.
2. **Clone.** The whole dir is copied with a three-tier strategy: APFS
   `clonefile`, then GNU `--reflink=always`, then a non-CoW fallback where
   `app.db` gets a consistent copy via `VACUUM INTO`
   (`packages/data/src/index.ts:63`).
3. **Verify.** The cloned database is opened read-only (`immutable=1`) and
   must pass `PRAGMA integrity_check`; on any failure the clone is deleted and
   the request errors (`packages/data/src/index.ts:131`). A snapshot that
   exists is a snapshot that opened cleanly.

## Previews run on clones

The same checkpoint-and-clone primitive backs preview environments: when a
work item's preview deploys, the platform forks prod's data into
`appdata/<owner>/<app>@pr-<n>/` (`packages/data/src/index.ts:250`) and mounts
that instead of the live dir (`packages/opd/src/reconcile.ts:392`). Reviewers
exercise real data; prod is never written. The branch persists across preview
redeploys and is deleted when the change closes.

## Export ships a snapshot

`op app export` packages an app for another sovereign platform: its full git
history, its `op.json`, and a fresh verified snapshot taken at export time as
the data-of-record (`packages/opd/src/platform.ts:707`). On the target,
[import](/docs/import-an-app) lays that data down with the same
`integrity_check` gate before the app ever starts.

## Restore paths today

Restoring is deliberately narrower than snapshotting:

- The data plane has a `restore()` primitive that replaces the live dir with a
  named snapshot (`packages/data/src/index.ts:368`), but no console button,
  CLI command, or HTTP endpoint calls it yet.
- Snapshots are plain directories. An operator with shell access can inspect
  one, copy files out, or restore by hand — stop the app first.
- App import restores exported data onto a fresh app, and refuses to clobber
  an existing data dir.

> [!warning]
> `restore()` does not stop the app — it replaces the directory under
> whatever is running. If you restore by hand, stop the container first and
> let the reconciler bring the app back up.
