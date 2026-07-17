---
title: Architecture
description: Every subsystem inside the one process, and the exact path a request takes through it.
---

The entire platform is one Bun process. `Platform.up`
(`packages/opd/src/platform.ts:115`) is the composition root: it opens the
store, proves key custody, seeds the system repos, starts ingress, the
reconciler, and the crew — in one strict order, as function calls. There is
no service mesh and no message bus. You read this page to learn where a
behavior lives, and what a backup must cover.

## One process, twelve packages

| Package             | What it does                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core`     | Shared vocabulary: prefixed ids, the one name grammar, `Result` errors, the state-dir layout |
| `packages/store`    | The single SQLite database — users, repos, host routing, work items, deploy history          |
| `packages/git`      | Bare-repo hosting, smart-HTTP, push events, bundles                                          |
| `packages/forge`    | Users, orgs, PATs, repos, permissions, template repos                                        |
| `packages/identity` | The OIDC provider: discovery, authorization code, `client_credentials`, JWKS                 |
| `packages/secrets`  | `age` sealing to the sovereign key, the custody gate, seal verification                      |
| `packages/engine`   | Docker Engine API client over the unix socket: build, run, inspect, logs                     |
| `packages/data`     | Per-app data dirs, verified snapshots, copy-on-write preview branches                        |
| `packages/gate`     | TLS termination on `:80`/`:443`, host-table routing, the raw-TCP relay                       |
| `packages/crew`     | Agents as directories, run caged in containers                                               |
| `packages/mitosis`  | `seed()`, `germinate()`, the `ORIGIN` lineage ledger                                         |
| `packages/opd`      | The composition root: `Platform.up`, the reconciler, `/api/v1`, the console, the `op` CLI    |

## The request path

Every HTTPS request enters at the gate, which terminates TLS and resolves
identity — app-to-app bearer tokens are verified against the target host and
die right there (`packages/opd/src/platform.ts:394`; see
[Identity](/docs/identity)). Requests to app hosts are proxied straight to
the app's container, fail-closed when no repo row exists. Requests to the
platform host go through one handler that tries four routers in order; the
first non-null response wins (`packages/opd/src/platform.ts:373-377`):

1. **forge** — git smart-HTTP and repo machinery (machines win first)
2. **api** — `/api/v1` and `/healthz`
3. **oidc** — the identity provider's endpoints
4. **console** — the human-face fallback

Anything unmatched is a JSON `404`.

## The state directory

Everything lives under one root, `~/.op/<domain>` by default
(`packages/opd/src/cli.ts:15`), laid out by `stateDir`
(`packages/core/src/paths.ts:17`):

| Path        | Contents                                                                        |
| ----------- | ------------------------------------------------------------------------------- |
| `db.sqlite` | the store — WAL mode, append-only migrations (`packages/store/src/schema.ts:1`) |
| `key.age`   | the sovereign key — the only decryptor of this platform's secrets               |
| `repos/`    | bare git repos — the canonical desired state                                    |
| `appdata/`  | per-app tenant data: `app.db` plus `files/`                                     |
| `certs/`    | the platform CA and wildcard leaf                                               |
| `ORIGIN`    | the plain-text lineage ledger                                                   |

A full backup is a copy of this directory with the process stopped. A seed is
a deliberate subset of it — see [Sovereignty](/docs/sovereignty).

## Principles

- **Standards, not adapters.** The substrate is `bun`, `git`, and a Docker
  socket; exactly six external runtime dependencies are allowed, enforced by
  a CI allowlist (`test/deps.test.ts:8`).
- **Desired state lives in git.** Every app spec is a file in the
  `sys/gitops` repo (`packages/opd/src/gitops.ts:14`), and the push is the
  event — even the platform's own config and source reload or re-exec the
  daemon on merge (`packages/opd/src/platform.ts:435`). See
  [GitOps](/docs/gitops) and [self-source](/docs/self-source).
- **Policy enforced, or the mutation never happened.** Work-item phase moves
  are a compare-and-swap against a legal-edge table — an illegal move throws
  with nothing written (`packages/store/src/index.ts:976`). An out-of-policy
  `op.json` fails the deploy before the running container is touched
  (`packages/opd/src/manifest.ts:83`).
- **One sovereign key.** Every secret is sealed to `key.age`, and every boot
  proves every sealed value still decrypts with it — fail loud, not twenty
  minutes later (`packages/opd/src/platform.ts:239`).
- **Data is a directory.** Each app owns `appdata/<owner>/<app>` — SQLite
  plus files — so snapshots, preview branches, and migration between
  platforms are file operations. See [Data](/docs/data).

## Proven in under a minute

One timed CI test exercises the whole architecture: boot a platform, ship an
app with a real `git push`, snapshot its data, germinate a sovereign
daughter, prove the mother's key opens nothing the daughter sealed, then ship
an app on the daughter. Soft budget 60 seconds, hard ceiling 90
(`test/m1.e2e.test.ts:44`).

```sh title="Terminal"
bun run test:m1
```

> [!note]
> That test is the product constraint made executable: if the full loop ever
> takes longer than a minute, the build goes red.
