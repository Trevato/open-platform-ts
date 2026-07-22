---
title: CLI
description: Every op command — what it does, the environment it reads, and an example.
---

`op` is the platform's single command-line entrypoint: one binary that boots
the daemon, reproduces the platform, moves apps between platforms, and
publishes its own source. Run with no arguments it prints this same command
list; an unknown command prints it and exits `2`
(`packages/opd/src/cli.ts:303`).

## Command reference

| Command                             | What it does                                                  | Key env                  |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------ |
| `op up`                             | Boot (or resume) the platform; self-upgrading when supervised | `OP_SRC`, `FORK_KEY_ACK` |
| `op admin-password`                 | Print the admin password (recover it if you missed the card)  | `OP_ROOT`                |
| `op serve`                          | The daemon proper — run by the supervisor, or by `up` inline  | same as `up`             |
| `op seed [out]`                     | Boot, export a keyless platform seed tarball, stop            | —                        |
| `op germinate [seed]`               | Grow a seed into a new sovereign platform and serve           | `SEED`, `FORK_KEY_ACK`   |
| `op app export <owner>/<app> [out]` | Export one app (repo + data + spec) as a portable seed        | —                        |
| `op app import <seed> [owner/app]`  | Ingest an app seed, optionally remapped to a new owner/name   | —                        |
| `op host-source [dir]`              | Publish the platform's own tracked source into `plat/opd`     | `OP_SRC`                 |
| `op lineage`                        | Print this platform's family tree from `<root>/ORIGIN`        | `OP_ROOT`                |

## Shared environment

Every command builds its options the same way
(`packages/opd/src/cli.ts:18-26`): `DOMAIN` (default `plat.localtest.me`),
`OP_ROOT` for the state directory (default `~/.op/<domain>`), `HTTP_PORT`
(default `80`) and `HTTPS_PORT` (default `443`), and the sovereign-key
custody acknowledgment — `FORK_KEY_ACK=1`, or an interactive TTY on stdin.
The full catalog lives in [Environment](/docs/env).

> [!warning]
> The default ports `80`/`443` need elevated privileges. For local
> development set `HTTP_PORT` and `HTTPS_PORT`. Non-interactive boots (CI, a
> process manager) must set `FORK_KEY_ACK=1` or the boot refuses to mint a
> key — see [Sovereignty](/docs/sovereignty).

## op up

Boots the platform, prints the platform card, and serves forever. If
`OP_SRC` points at a managed clone of `plat/opd` (and `OP_SUPERVISED` is not
set), `up` wraps the daemon in a supervisor so a merge to `plat/opd`
re-execs the process from its own new source
(`packages/opd/src/cli.ts:123`). Otherwise it serves inline with no
self-upgrade — a merge to `plat/opd` waits for the next boot. Every boot
also publishes the platform's own source into `plat/opd` if it isn't hosted
yet (see [Self-hosted source](/docs/self-source)).

```sh title="Terminal"
op up                        # dev/simple mode
OP_SRC=~/opd-clone op up     # supervised, self-upgrading
```

At boot the platform also reads `CLAUDE_CODE_OAUTH_TOKEN`, the crew's
inference credential (`packages/opd/src/platform.ts:353`); without it
everything runs except the [crew](/docs/crew). See the
[Quickstart](/docs/quickstart) for the first-boot walkthrough.

## op admin-password

Prints this platform's admin password. The boot card shows it only once, at
genesis; every later boot just notes it exists. This decrypts it from the
sealed store with the local sovereign key and prints it — the way back when
you looked away, or a first boot failed after genesis (a port clash) so you
never saw the card. It reads state only — no server starts
(`packages/opd/src/cli.ts:290`, `packages/opd/src/platform.ts:1007`).

```sh title="Terminal"
op admin-password            # → the password for user `plat`
```

## op serve

The daemon proper (`packages/opd/src/cli.ts:136`) — what the supervisor
launches, and what `up` runs inline. When its own source changes under a
supervisor it exits with the upgrade code and gets re-execed; unsupervised,
it keeps serving the old code and the merge applies on the next boot. You
rarely type this yourself.

## op seed

Boots, writes a platform seed tarball, and stops. The default filename is
`seed-<YYYY-MM-DD>.tar.gz` (`packages/opd/src/cli.ts:140`). The seed carries
no key and no secrets — hand it to anyone.

```sh title="Terminal"
op seed                      # → seed-2026-07-17.tar.gz
op seed acme-genome.tar.gz
```

`op seed`, `op germinate`, and `op app export/import` each boot a full
platform, so they bind `HTTP_PORT`/`HTTPS_PORT`. Run them against an
**idle** state directory, or — to seed a platform that is currently serving
under `op up` — pass different ports (`HTTP_PORT=… HTTPS_PORT=… op seed`)
so they don't clash with the running gate.

## op germinate

Grows a seed into a new, fully sovereign platform — fresh key, fresh
secrets — then serves. The seed path comes from `SEED` or the first
argument (`packages/opd/src/cli.ts:161`). Germination is one-shot: on
failure, remove the root directory and re-run. Details in
[Sovereignty](/docs/sovereignty).

```sh title="Terminal"
SEED=seed-2026-07-17.tar.gz DOMAIN=you.example op germinate
```

## op app export

Exports one app — repo history, a fresh data snapshot, and its spec — as a
portable seed (`packages/opd/src/cli.ts:191`). No platform secret travels;
the target re-mints credentials at deploy.

```sh title="Terminal"
op app export plat/hello     # → plat-hello-2026-07-17.tar.gz
```

## op app import

Ingests an app seed, optionally remapping it to a new `owner/app`
(`packages/opd/src/cli.ts:215`), then deploys it via the reconciler. See
[Import an app](/docs/import-an-app) for the git-URL alternative.

```sh title="Terminal"
op app import plat-hello-2026-07-17.tar.gz acme/hello
```

## op host-source

Publishes the platform's own tracked source (`git archive HEAD` — no
history, no untracked files) into the `plat/opd` repo
(`packages/opd/src/cli.ts:253`). The source directory is the argument,
`OP_SRC`, or the running checkout; from an npm install the shipped source
tarball is used instead. `op up` already does this automatically on every
boot, so this command is only for publishing from a **specific** checkout or
repairing a failed boot-time publish. It is publish-once: if `plat/opd`
already has content it reports so and does nothing (remove the repo first to
re-publish from a different source). See [Self-hosted source](/docs/self-source).

```sh title="Terminal"
op host-source
```

## op lineage

Prints this platform's family tree from the `ORIGIN` file in the state root
(`packages/opd/src/cli.ts:286`) — who seeded whom, all the way up.

```sh title="Terminal"
op lineage
```
