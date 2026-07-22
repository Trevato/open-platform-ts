---
title: The platform edits itself
description: The daemon's source is hosted on itself from the first boot; the crew proposes changes, a human merges, and a supervised boot re-execs from the merge.
---

The platform hosts its own source code as an ordinary repo, `plat/opd`, and
treats "change the platform" like any other [work item](/docs/work-items):
you file it, the crew drafts the change, a human merges, and a supervised
daemon re-execs from the new source. Add a console feature, a new agent
role, a theme — the loop is the same one that builds your apps, pointed at
the platform itself.

## The self-modification surface

| Repo                | Contains                           | On merge                           |
| ------------------- | ---------------------------------- | ---------------------------------- |
| `plat/platform`     | crew prompts + `platform.json`     | hot-reload, no restart             |
| `plat/opd`          | the daemon's own TypeScript source | supervised boot re-execs from it   |
| `plat/app-template` | the repo every new app starts from | future apps use it; existing don't |

The platform marks the first two as self-repos and the third as a template —
everything below treats them differently from a normal app. The config side
is covered in [Operate the platform](/docs/operate); this page is about the
source side.

## The source is hosted automatically

Every boot publishes the daemon's own tracked source into `plat/opd` if it
isn't there yet (`packages/opd/src/platform.ts:581`). From a git checkout
that's `git archive HEAD` (`packages/opd/src/platform.ts:896`): no `.git`
history, and no untracked files — a stray secret in the source directory can
never land in the world-readable repo, which an e2e test proves with a
planted `SECRET.token` (`test/host-source.e2e.test.ts:65`). From an npm
install (`bunx open-platform-ts up`) there is no checkout, so the publish
falls back to the source tarball the package ships beside `genesis/`
(`packages/opd/src/platform.ts:965`) — the exact tree the running binary was
built from. `op host-source <dir>` remains as the manual override
(`packages/opd/src/cli.ts:231`).

## Self-upgrade on merge

Boot in supervised mode by pointing `OP_SRC` at a managed clone of
`plat/opd` (`packages/opd/src/cli.ts:101`):

```sh title="Terminal"
git clone ~/.op/<domain>/repos/plat/opd.git opd-src
cd opd-src && bun install
OP_SRC=$PWD op up
```

Now a merge to `plat/opd` — the console's Merge button or a direct push;
both fire the push event (`packages/git/src/githost.ts:428`) — asks the
daemon to upgrade
(`packages/opd/src/platform.ts:501`): it stops cleanly and exits with the
upgrade code; the supervisor pulls the new source into `OP_SRC` and
re-execs. If the new daemon fails to stay up, the supervisor resets the
source to the last-good ref and re-execs that
(`packages/opd/src/supervisor.ts:95`) — a bad commit degrades to the
previous version, never a dead platform. Apps run under Docker with
`--restart=always`, so they outlive the re-exec.

Without `OP_SRC` the daemon keeps serving the old code on a merge — exiting
with nothing to restart it would just kill the platform
(`packages/opd/src/platform.ts:505`). The merge applies on the next boot,
ideally a supervised one.

## The platform-dev role

Work filed on a self-repo is picked up by the `platform-dev` role instead
of the app builder (`packages/opd/src/crew/dispatcher.ts:467`) — a prompt
tuned to the daemon's strict-TypeScript, errors-as-values codebase. The
checkout has no `node_modules`, so the agent cannot run `bun` or `tsc`
(`genesis/platform/crew/platform-dev/instructions.md:13`); its code must be
correct by inspection, and the human who merges typechecks it.

An agent that finds the issue mis-scoped — config work filed on the source
repo, daemon work filed on config — doesn't guess: it invokes the decline
contract (`packages/opd/src/crew/builder.ts:151`) and the item parks with
the agent's own explanation of where the work belongs
(`packages/opd/src/crew/dispatcher.ts:202`). Edit the issue, or re-file it
on the right repo, and Re-queue.

> [!warning]
> Self-repos never auto-merge. The crew parks the finished branch as a
> proposed change — no preview, no reviewer verdict, no ship
> (`packages/opd/src/crew/dispatcher.ts:219`). A human reads the diff and
> presses Merge. The same gate covers `plat/app-template`
> (`packages/opd/src/crew/dispatcher.ts:235`) — a template merge shapes
> every future app. The [crew](/docs/crew) can rewrite the platform, but
> only a person can make it so.

## File platform work from the console

The **Platform** page in the console (`packages/opd/src/console/index.ts:1194`)
shows three cards — Source (`plat/opd`), Config (`plat/platform`), and
Template (`plat/app-template`) — each with a "File an issue" path into the
normal work-item flow. The composer knows which repo it is drafting for and
switches contracts accordingly (`packages/opd/src/crew/composer.ts:41`): a
platform-source idea is drafted against the daemon's architecture with
diff-review acceptance checks, not as a single-file app. Docs edits ride the
same gate: see [how the docs work](/docs/docs).
