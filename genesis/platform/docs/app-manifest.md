---
title: The app manifest
description: Declare memory, TCP ports, assets, and peers in op.json — validated fail-closed at every deploy.
---

`op.json` is an optional file at the root of your app's repo, beside the
`Dockerfile`, that declares what the app **needs** — resources, raw TCP
ports, downloaded files, peer apps — and the platform provisions all of it
before your container starts (`packages/opd/src/manifest.ts:12`). No file
means you need nothing special. Because it lives in the repo, the manifest
travels with the code through forks, previews, and export. The container
contract itself is [Deploy an app](/docs/deploy-an-app); the full field
tables are in the [manifest schema](/docs/manifest-schema).

## A manifest that uses everything

The Minecraft server from [Run game servers](/docs/game-servers) exercises
all five fields (`genesis/examples/minecraft-network/server/op.json:2`):

```json title="op.json"
{
  "resources": { "memoryMb": 1792, "cpus": 2 },
  "tcpPorts": [25565],
  "assets": [
    {
      "url": "https://fill-data.papermc.io/v1/objects/…/paper-1.21.11-132.jar",
      "dest": "server.jar",
      "sha256": "5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba"
    }
  ],
  "provides": [
    {
      "name": "mc-control",
      "path": "/api",
      "description": "start/stop/console/settings for this Minecraft server"
    },
    {
      "name": "server-status",
      "path": "/api/status",
      "description": "live state, players, gamemode, join or hub address"
    }
  ],
  "consumes": [{ "app": "hub" }]
}
```

## What each stanza buys you

**`resources`** — container memory and CPU. Defaults are 512 MB and one
CPU; declared values become hard container limits at run
(`packages/opd/src/reconcile.ts:427-432`).

**`tcpPorts`** — container ports exposed as raw public TCP through the
[ingress](/docs/ingress) gate. Each port is allocated a public port from the
operator's range, sticky per app and port, so players keep the same address
across every redeploy (`packages/opd/src/reconcile.ts:342-349`). The
assignment is injected as `OP_TCP_PORT_<containerPort>`
(`packages/opd/src/reconcile.ts:452`) so the app can render its own join
address. Production only — previews are reviewed over HTTP and never bind
public ports.

**`assets`** — files the platform downloads into `/data/<dest>` before your
container starts, so the app wakes up with its `server.jar` (or model, or
dataset) already in place. URLs must be `https` and the host must be on the
operator's `assetHosts` allowlist (`packages/opd/src/manifest.ts:154`);
`dest` is jailed inside the data dir (`packages/opd/src/manifest.ts:72`). A
`sha256` mismatch fails the deploy (`packages/opd/src/assets.ts:154`).

> [!tip]
> `sha256` is optional on the first fetch: the platform computes and records
> the hash in the deploy event. Copy it into `op.json` in your next commit
> to pin the asset.

**`provides`** — labels for what you offer peers. Documentation-grade and
non-binding: they annotate the derived integration map, which any app can
fetch at `GET /api/v1/integration-map` to discover peers at runtime.

**`consumes`** — peer apps you call. Each entry injects
`OP_PEER_<APP>_URL` — app name upper-cased, `-` becomes `_`
(`packages/opd/src/manifest.ts:64`) — and `owner` defaults to your own. See
[Connect apps](/docs/connect-apps) for the wiring and the authenticated
`peerFetch` client.

## Admission is fail-closed

Every deploy reads `op.json` and admits it against operator policy — the
`apps` block of `platform.json` (`genesis/platform/platform.json:7`), a
hot-reloadable knob described in [Operate the platform](/docs/operate).
`admitManifest` accepts nothing it cannot fully validate
(`packages/opd/src/manifest.ts:83`): memory and CPU must sit within the
operator's caps, ports must be valid and under the per-app limit, asset
hosts must be allowlisted, and duplicate ports, dests, or peer env names are
rejected.

A manifest that fails admission never half-applies. The deploy stops before
anything is built or replaced, and the exact violation becomes the app's
error status while the running version keeps serving
(`packages/opd/src/reconcile.ts:303-305`).

> [!warning]
> `assetHosts` is empty by default, which denies all asset downloads
> (`packages/opd/src/manifest.ts:52`). Platform-side egress is opt-in: the
> operator must commit the host to `platform.json` before your asset stanza
> will admit.
