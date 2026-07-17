---
title: Manifest schema
description: Every field of op.json, platform.json, and app.json — types, defaults, and bounds.
---

Three JSON files govern an app's life, and the platform validates each one
fail-closed: a file that doesn't parse or exceeds bounds never takes effect.
`op.json` in the app repo declares what the app **needs**; `platform.json` in
`plat/platform` sets the operator's **bounds** on those needs; `app.json` in
`sys/gitops` records **where** the app runs. This page is the field-by-field
reference — for the guided tours, see [The app manifest](/docs/app-manifest)
and [Operate the platform](/docs/operate).

## op.json — what the app needs

Lives at the app repo root, beside the Dockerfile
(`packages/opd/src/manifest.ts:12`). Every field is optional; a missing file
is the empty manifest (`packages/opd/src/manifest.ts:235`). `admitManifest`
checks each field against the operator's policy — a violation becomes the
app's error status (`packages/opd/src/manifest.ts:83`).

| Field                    | Type     | Default        | Bounds                                                   | What it does                                                         |
| ------------------------ | -------- | -------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| `resources.memoryMb`     | integer  | engine default | 64 – `apps.maxMemoryMb`                                  | container memory limit in MiB                                        |
| `resources.cpus`         | number   | engine default | 0.1 – `apps.maxCpus`                                     | container CPU limit                                                  |
| `tcpPorts`               | number[] | `[]`           | ports 1–65535, no duplicates, ≤ `apps.maxTcpPortsPerApp` | container-side raw TCP ports, each relayed from a stable public port |
| `assets[].url`           | string   | —              | `https:` only; host must be on `apps.assetHosts`         | file fetched into the app's data dir before the container starts     |
| `assets[].dest`          | string   | —              | relative path ≤ 200 chars, jailed inside `/data`, unique | where the fetched file lands                                         |
| `assets[].sha256`        | string   | none           | 64 lowercase hex chars                                   | integrity pin; computed and recorded either way                      |
| `provides[].name`        | string   | —              | lowercase kebab ≤ 32 chars, unique                       | capability label for the integration map — documentation-grade       |
| `provides[].path`        | string   | —              | starts with `/`, ≤ 200 chars                             | route the capability lives at                                        |
| `provides[].description` | string   | —              | ≤ 200 chars                                              | one line for peers and the composer                                  |
| `consumes[].app`         | string   | —              | valid app name; one env name per peer                    | peer app; its URL is injected as `OP_PEER_<APP>_URL`                 |
| `consumes[].owner`       | string   | consumer's own | valid owner name                                         | peer's owner when it isn't yours                                     |

`assets` allows at most 8 entries, `provides` 8, `consumes` 16. Asset `dest`
paths are jailed — no absolute paths, no `..` escapes
(`packages/opd/src/manifest.ts:72`). Peer env names come from `envNameFor`,
which uppercases the app name and swaps `-` for `_`
(`packages/opd/src/manifest.ts:64`) — two same-named peers from different
owners collide and are rejected. See [Connect apps](/docs/connect-apps) for
how wiring behaves at runtime.

```json title="op.json"
{
  "resources": { "memoryMb": 1792, "cpus": 2 },
  "tcpPorts": [25565],
  "assets": [
    {
      "url": "https://fill-data.papermc.io/v1/objects/5ffe…ccfba/paper-1.21.11-132.jar",
      "dest": "server.jar",
      "sha256": "5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba"
    }
  ],
  "provides": [
    {
      "name": "server-status",
      "path": "/api/status",
      "description": "live state, players, join address"
    }
  ],
  "consumes": [{ "app": "hub" }]
}
```

The full version runs a real Minecraft server
(`genesis/examples/minecraft-network/server/op.json`).

## platform.json — operator bounds

Lives in the `plat/platform` repo and hot-reloads on push; an unreadable or
invalid commit keeps the last-good config in memory
(`packages/opd/src/platform-config.ts:150`). The shape is `crew` plus `apps`
(`packages/opd/src/platform-config.ts:37`), validated by
`admitPlatformConfig` (`packages/opd/src/platform-config.ts:54`). Defaults
are `DEFAULT_APP_POLICY` (`packages/opd/src/manifest.ts:46`).

| Field                    | Type       | Default           | Bounds                            | What it does                                        |
| ------------------------ | ---------- | ----------------- | --------------------------------- | --------------------------------------------------- |
| `crew.maxRework`         | integer    | `2`               | 0–5                               | review-fail rework attempts before an item parks    |
| `crew.sweepMs`           | number     | `30000`           | 5000–600000                       | dispatcher sweep interval in ms                     |
| `crew.model`             | string     | `claude-sonnet-5` | model-id chars; may not start `-` | model the crew invokes                              |
| `apps.maxMemoryMb`       | integer    | `2048`            | 64–65536                          | ceiling on any manifest's `resources.memoryMb`      |
| `apps.maxCpus`           | number     | `2`               | 0.1–64                            | ceiling on any manifest's `resources.cpus`          |
| `apps.tcpPortRange`      | [int, int] | `[25500, 25599]`  | within 1024–65535, from ≤ to      | public port pool the TCP gate allocates from        |
| `apps.maxTcpPortsPerApp` | integer    | `4`               | 0–16                              | ceiling on any manifest's `tcpPorts` count          |
| `apps.maxAssetMb`        | integer    | `512`             | 1–10240                           | per-asset download size cap                         |
| `apps.assetHosts`        | string[]   | `[]`              | ≤ 32 lowercase hostnames          | allowlist of hosts the daemon may fetch assets from |

> [!warning]
> `assetHosts` defaults to empty, which means **all assets are denied**
> (`packages/opd/src/manifest.ts:154`). Platform-side egress is opt-in by a
> sovereign commit to `platform.json`.

```json title="platform.json"
{
  "crew": { "maxRework": 2, "sweepMs": 30000, "model": "claude-sonnet-5" },
  "apps": {
    "maxMemoryMb": 2048,
    "maxCpus": 2,
    "tcpPortRange": [25500, 25599],
    "maxTcpPortsPerApp": 4,
    "maxAssetMb": 512,
    "assetHosts": ["fill-data.papermc.io"]
  }
}
```

## app.json — where the app runs

Stored at `apps/<owner>/<app>/app.json` in `sys/gitops`
(`packages/opd/src/gitops.ts:130`) and reconciled by [GitOps](/docs/gitops).
The shape is `AppSpec` (`packages/opd/src/policy.ts:10`); `admitSpec` is the
only path to a deploy and fails closed (`packages/opd/src/policy.ts:21`). All
six fields are required — the "defaults" below are what the platform stamps
when it creates an app for you (`packages/opd/src/api.ts:219`).

| Field           | Type    | Stamped default | Bounds                                       | What it does                                        |
| --------------- | ------- | --------------- | -------------------------------------------- | --------------------------------------------------- |
| `owner`         | string  | your user/org   | valid name                                   | who the app belongs to; part of its host            |
| `app`           | string  | repo name       | valid name, not reserved (`pr-<n>` collides) | the app's name; part of its host                    |
| `repo.owner`    | string  | = `owner`       | valid name                                   | source repo owner                                   |
| `repo.name`     | string  | = `app`         | valid name                                   | source repo name                                    |
| `ref`           | string  | `main`          | ≤ 100 chars of `[A-Za-z0-9._/-]`, no `..`    | branch or ref the platform builds and deploys       |
| `containerPort` | integer | `8080`          | 1–65535                                      | HTTP port your container listens on                 |
| `data`          | boolean | `true`          | —                                            | whether the app gets a persistent `/data` directory |

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

The deployed host is always `<app>-<owner>.<domain>`
(`packages/opd/src/policy.ts:84`). See [Deploy an app](/docs/deploy-an-app)
for the container contract behind `containerPort`.
