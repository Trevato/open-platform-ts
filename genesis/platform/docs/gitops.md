---
title: GitOps
description: Desired state lives in git inside the system that reconciles it — a push is the event, not a poll.
---

GitOps here means the platform's desired state is a git repo, and that repo
lives inside the same process that acts on it. There is no external CD
system watching from outside and no polling loop: the git host and the
reconciler share a process, so a successful push _is_ the trigger. You care
about this page when you want to know what actually happens between
`git push` and a running container — or want to edit desired state by hand.

## The desired-state repo

One special repo, `sys/gitops` (`packages/opd/src/gitops.ts:14`), holds what
should be running. Each deployed app is one JSON file on `main` at
`apps/<owner>/<app>/app.json`:

```json title="apps/plat/hello/app.json"
{
  "owner": "plat",
  "app": "hello",
  "repo": { "owner": "plat", "name": "hello" },
  "ref": "main",
  "containerPort": 8080,
  "data": true
}
```

The spec names a repo and ref to build and deploy — the app's own code and
its `op.json` manifest live in that repo (see
[the app manifest](/docs/app-manifest)). The reconciler reads specs straight
out of git: it lists every file on `sys/gitops@main`, keeps those matching
`apps/<owner>/<app>/app.json` (`packages/opd/src/gitops.ts:93`), and runs
each through the policy gate. A spec that fails admission is skipped, never
deployed in a degraded form. Sealed secrets live in the same repo as
`secrets.age.json`.

## A push is the event

The platform hosts its own git over Smart HTTP. When a `git-receive-pack`
process exits `0` — the push landed — the git host emits an in-process push
event naming the repo (`packages/git/src/githost.ts:261-263`). No hook
scripts, no webhook round-trip, no polling gap to race.

The reconciler subscribes at startup: a push to `sys/gitops` re-converges
the whole world; a push to an app's repo converges just that app and its
previews (`packages/opd/src/reconcile.ts:72-76`). A rejected push emits
nothing.

## The converge loop

Every pass recomputes desired versus actual from scratch — git HEAD on one
side, container labels on the other — with no incremental state, so a crash
mid-pass costs nothing and the next pass converges. All passes run
serialized on one queue; there is no lock to leak
(`packages/opd/src/reconcile.ts:35-39`).

A full pass reads all app specs, converges each app, converges preview
environments for open changes, then prunes anything that no longer belongs
(`packages/opd/src/reconcile.ts:88-100`). What "converge one app" means —
clone, build, swap containers — is [deploy an app](/docs/deploy-an-app).

## Local commits kick directly

When the platform itself mutates desired state — registering a new app,
rotating a secret — it commits to the bare repo on disk via a temp clone
(`packages/opd/src/gitops.ts:34`). That path never touches Smart HTTP, so
no push event fires; the caller kicks the reconciler explicitly instead
(`packages/opd/src/api.ts:239-240`). Same converge loop, different doorbell.

> [!tip]
> You can edit desired state the same way the platform does: clone
> `sys/gitops`, change an `app.json`, and push. Your push goes through
> Smart HTTP, so the event fires for you automatically.

## Two more repos get special handling

The same push wiring drives the platform's own configuration and source
(`packages/opd/src/platform.ts:452-461`):

| Repo            | On push                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `plat/platform` | Config hot-reloads, then a full re-converge — see [operate](/docs/operate)                 |
| `plat/opd`      | The daemon requests re-exec from its own new source — see [self-source](/docs/self-source) |

A merge to `plat/opd` makes the daemon exit with the upgrade code
(`packages/opd/src/supervisor.ts:14`); a supervisor pulls the new source
and re-execs, rolling back automatically if the new code fast-crashes.
