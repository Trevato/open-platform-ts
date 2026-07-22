---
title: Environment
description: Every variable the platform reads at boot, and every variable it injects into your app's container.
---

The platform is configured in two places: environment variables on the `op`
process for restart-only concerns (domain, ports, credentials), and
`platform.json` in the `plat/platform` repo for hot-reloadable policy — see
[Operate the platform](/docs/operate). This page is the env reference: what
the daemon reads, and what your app's container receives at run time.

## Variables the platform reads

| Variable                     | Default                         | What it does                                                                                                                                                              |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                     | `plat.localtest.me`             | The platform's domain; every app gets a subdomain of it (`packages/opd/src/cli.ts:94`).                                                                                   |
| `OP_ROOT`                    | `~/.op/<domain>`                | State root: store, repos, data dirs, certs (`packages/opd/src/cli.ts:20`).                                                                                                |
| `HTTP_PORT` / `HTTPS_PORT`   | `80` / `443`                    | The gate's listen ports. Defaults need elevated privileges; local dev usually sets both (`packages/opd/src/cli.ts:22-23`).                                                |
| `FORK_KEY_ACK`               | unset                           | `1` acknowledges sovereign-key custody for non-interactive boots; an interactive TTY also counts (`packages/opd/src/cli.ts:25`). See [Sovereignty](/docs/sovereignty).    |
| `SEED`                       | unset                           | Seed tarball path for `op germinate`, as an alternative to the positional argument (`packages/opd/src/cli.ts:139`).                                                       |
| `OP_SRC`                     | unset                           | A managed clone of `plat/opd`; when set, `op up` runs supervised and a merge to `plat/opd` re-execs the daemon from its own source (`packages/opd/src/cli.ts:101`).       |
| `OP_SUPERVISED`              | set by the supervisor           | Marks the supervised child so it serves instead of re-supervising (`packages/opd/src/supervisor.ts:136`). Never set it yourself.                                          |
| `OP_SOURCE_TARBALL`          | shipped beside `genesis/`       | Override for the source tarball the boot self-publish uses when no git checkout exists (`packages/opd/src/platform.ts:130`). See [Self-hosted source](/docs/self-source). |
| `CLAUDE_CODE_OAUTH_TOKEN`    | unset                           | The crew's inference credential, from `claude setup-token` (`packages/opd/src/platform.ts:353`). Absent, the crew idles. See [The crew](/docs/crew).                      |
| `ANTHROPIC_API_KEY`          | unset                           | Composer fast lane only: a real API key skips the SDK subprocess and hits the Messages API directly (`packages/opd/src/crew/composer.ts:188`).                            |
| `OP_COMPOSER_MODEL`          | `claude-haiku-4-5`              | Model for the issue composer (`packages/opd/src/crew/composer.ts:63`).                                                                                                    |
| `OP_GUIDE_MODEL`             | crew model from `platform.json` | Model override for the docs guide agent (`packages/opd/src/crew/guide.ts:62`).                                                                                            |
| `OP_CLAUDE_BIN`              | `claude`                        | Path to the `claude` binary for the host agent runner (`packages/crew/src/runner.ts:51`). The container runner's binary is baked into `op/agent:latest`.                  |
| `OP_LOG_LEVEL`               | `info`                          | Log threshold: `debug`, `info`, `warn`, or `error` (`packages/core/src/log.ts:11`).                                                                                       |
| `OP_FORCE_FIRST_REVIEW_FAIL` | unset                           | Demo/test hook: fails the first crew review of every item so the rework loop can be watched (`packages/opd/src/platform.ts:545`). Leave unset in real use.                |
| `DOCKER_HOST`                | unset                           | Container engine socket, `unix://` form only (`packages/engine/src/index.ts:43`).                                                                                         |

The crew's builder and reviewer models are not env — they hot-reload from
`crew.model` in `platform.json`.

### Engine socket resolution

The platform takes the first Unix socket that exists: `DOCKER_HOST` (when it
is a `unix://` URL), then the current Docker context's endpoint, then
`/var/run/docker.sock`, then `~/.docker/run/docker.sock`
(`packages/engine/src/index.ts:41`). No variable is needed on a standard
Docker install.

> [!note]
> The crew credential is strictly a Claude Code OAuth token (`sk-ant-oat01-…`
> from `claude setup-token`). An ordinary API key does not credential the
> crew — `ANTHROPIC_API_KEY` only speeds up the issue composer.

## Variables your app receives

The reconciler assembles the container environment fresh on every deploy
(`packages/opd/src/reconcile.ts:433-455`):

| Variable                                | Value                      | Notes                                                                                                                                                                      |
| --------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                  | `8080`                     | The port your server must bind. See [Deploy an app](/docs/deploy-an-app).                                                                                                  |
| `DATA_DIR`                              | `/data`                    | Your writable, snapshotted directory. See [Data](/docs/data).                                                                                                              |
| `OP_APP` / `OP_OWNER`                   | app name / owner           | This instance's identity.                                                                                                                                                  |
| `OP_HOST`                               | e.g. `hello-plat.<domain>` | The hostname this instance serves.                                                                                                                                         |
| `OP_PREVIEW`                            | preview id                 | Present only in preview containers — branch behavior on it, never hardcode hosts.                                                                                          |
| `OIDC_ISSUER`                           | platform origin            | Sign-in and app-to-app tokens. See [Identity](/docs/identity).                                                                                                             |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | per-app client             | Minted per app (and per preview) at deploy; never travels in exports.                                                                                                      |
| `OIDC_REDIRECT_URI`                     | `https://<host>/callback`  | The registered callback for this instance.                                                                                                                                 |
| `OP_CA_FILE` / `NODE_EXTRA_CA_CERTS`    | `/etc/op/ca.crt`           | The platform CA, mounted read-only, so in-container HTTPS to the platform and peers verifies.                                                                              |
| `APP_SECRET`                            | random per deploy          | Session-signing secret, re-minted every deploy (`packages/opd/src/reconcile.ts:446`) — signed cookies reset; durable state belongs in `DATA_DIR`.                          |
| `OP_PEER_<APP>_URL`                     | `https://<peer-host>`      | One per `consumes` entry in `op.json`; the name uppercases the app and maps `-` to `_` (`packages/opd/src/manifest.ts:65`). See [Connect apps](/docs/connect-apps).        |
| `OP_TCP_PORT_<port>`                    | public TCP port            | One per `tcpPorts` entry, prod only — sticky across redeploys so join addresses survive (`packages/opd/src/reconcile.ts:343`). See [Run game servers](/docs/game-servers). |

> [!tip]
> Read all of these lazily and tolerate absence. Previews get no
> `OP_TCP_PORT_*`, a consumed peer may not be deployed yet, and defaulting
> `PORT` to `8080` keeps `bun run server.ts` working on a laptop.
