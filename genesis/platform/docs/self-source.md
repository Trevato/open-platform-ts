---
title: The platform edits itself
description: Host the daemon's source on itself, let the crew propose changes, and re-exec from a merge — always behind a human gate.
---

The platform can host its own source code as an ordinary repo, `plat/opd`,
and treat "change the platform" like any other [work item](/docs/work-items):
you file it, the crew drafts the change, a human merges, and the running
daemon re-execs from the new source. You care the first time you want a
platform feature built — not another app.

## The two self-repos

| Repo            | Contains                           | On merge                        |
| --------------- | ---------------------------------- | ------------------------------- |
| `plat/platform` | crew prompts + `platform.json`     | hot-reload, no restart          |
| `plat/opd`      | the daemon's own TypeScript source | the supervisor re-execs from it |

The platform marks both as self-repos — everything below treats them
differently from a normal app. The config side is covered in
[Operate the platform](/docs/operate); this page is about the source side.

## Publish the source

```sh title="Terminal"
op host-source
```

The command (`packages/opd/src/cli.ts:208`) publishes the platform's own
tracked source into `plat/opd` via `git archive HEAD`
(`packages/opd/src/platform.ts:851`): no `.git` history, and no untracked
files — a stray secret in the source directory can never land in the
world-readable repo, which an e2e test proves with a planted `SECRET.token`
(`test/host-source.e2e.test.ts:60`). Re-running is a no-op once `plat/opd`
has content.

## Self-upgrade on merge

Boot in supervised mode by pointing `OP_SRC` at a managed clone of
`plat/opd` (`packages/opd/src/cli.ts:89`):

```sh title="Terminal"
git clone ~/.op/<domain>/repos/plat/opd.git opd-src
cd opd-src && bun install
OP_SRC=$PWD op up
```

Now a push to `plat/opd` asks the daemon to upgrade
(`packages/opd/src/platform.ts:461`): it stops cleanly and exits with the
upgrade code; the supervisor pulls the new source into `OP_SRC` and
re-execs. If the new daemon fails to stay up, the supervisor resets the
source to the last-good ref and re-execs that
(`packages/opd/src/supervisor.ts:95`) — a bad commit degrades to the
previous version, never a dead platform. Apps run under Docker with
`--restart=always`, so they outlive the re-exec.

Without `OP_SRC` the platform serves inline: a push to `plat/opd` just
exits the process and the operator restarts it.

## The platform-dev role

Work filed on a self-repo is picked up by the `platform-dev` role instead
of the app builder (`packages/opd/src/crew/dispatcher.ts:434`) — a prompt
tuned to the daemon's strict-TypeScript, errors-as-values codebase. The
checkout has no `node_modules`, so the agent cannot run `bun` or `tsc`
(`genesis/platform/crew/platform-dev/instructions.md:13`); its code must be
correct by inspection, and the human who merges typechecks it.

> [!warning]
> Self-repos never auto-merge. The crew parks the finished branch as a
> proposed change — no preview, no reviewer verdict, no ship
> (`packages/opd/src/crew/dispatcher.ts:207`). A human reads the diff and
> presses Merge. The [crew](/docs/crew) can rewrite the platform, but only
> a person can make it so.

## File platform work from the console

The **Platform** page in the console (`packages/opd/src/console/index.ts:1190`)
shows two cards — Source (`plat/opd`) and Config (`plat/platform`) — each
with a "File an issue" path into the normal work-item flow. If the source
isn't hosted yet, the card tells you to run `op host-source` first. Docs
edits ride the same gate: see [how the docs work](/docs/docs).
