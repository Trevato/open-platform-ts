---
title: Run game servers
description: The Minecraft network example — raw TCP ports, pinned assets, and a self-wiring Velocity proxy.
---

Game servers are the app the platform's HTTP-only story can't serve: players
connect over raw TCP, worlds are big mutable state, and a network needs a
proxy that knows its backends. The worked example at
`genesis/examples/minecraft-network/README.md` runs a real Minecraft network
— a Velocity proxy fronting Paper backends — entirely as platform apps, and
exercises every field of the [app manifest](/docs/app-manifest) along the
way. Read it as the pattern for anything non-HTTP: game servers, databases,
brokers.

## Sticky public TCP ports

Each app declares the container port it speaks Minecraft on:

```json title="server/op.json"
{
  "resources": { "memoryMb": 1792, "cpus": 2 },
  "tcpPorts": [25565],
  "consumes": [{ "app": "hub" }]
}
```

The platform allocates a public port from the operator's `tcpPortRange`
policy and relays it to the container's loopback binding — containers never
touch the network edge, see [Ingress](/docs/ingress). The allocation is
sticky per app and container port: it survives every redeploy and restart,
and is released only when the app is removed
(`packages/store/src/index.ts:544-546`). The address players paste stays
valid. The container learns its port as `OP_TCP_PORT_25565` and renders its
own join address from it.

> [!note]
> PR previews never bind public TCP ports
> (`packages/opd/src/reconcile.ts:344-347`) — a preview of a game server is
> control-plane-only. Reviewers QA the HTTP surface; nobody joins a preview
> world.

## Assets before start

The Paper jar is not in the repo and not downloaded by app code. `op.json`
names it and the platform fetches it into `/data` before the container
starts (`genesis/examples/minecraft-network/server/op.json:4-9`):

- **sha256-pinned** — a mismatch fails the deploy; omit the pin on first
  fetch and copy the recorded hash into your next commit.
- **host-allowlisted** — only hosts in the platform's `assetHosts` policy,
  which ships with the Mojang and PaperMC hosts so this example works day
  one. See [Operate the platform](/docs/operate).
- **size-bounded** — capped at the operator's `maxAssetMb`.

Downloads fill a content-addressed cache before the build, then land in
`/data` before start (`packages/opd/src/reconcile.ts:399-406`) — the app
wakes up with `server.jar` in place, and slow downloads never extend the
window where the old container is gone.

## The self-wiring hub

The Velocity proxy `consumes` its backends in its own `op.json`, so the
platform injects an `OP_PEER_<APP>_URL` per backend — see
[Connect apps](/docs/connect-apps). At runtime the hub enumerates those
variables (`genesis/examples/minecraft-network/hub/server.ts:40-50`), asks
each backend's `/api/status` for its live address over the authenticated
app-to-app channel, and generates `velocity.toml` from whatever answered.

The trust root — Velocity's modern-forwarding secret — is minted by the hub
and served at `/api/forwarding-secret` only to callers the gate has stamped
as `app:<owner>/<backend>` for a consumed backend; humans and foreign apps
get `403` (`genesis/examples/minecraft-network/hub/server.ts:308-317`). This
closes the classic footgun where offline-mode backends let anyone spoof a
username: backends reject any login that didn't come through the proxy.

## Worlds

Backends expose a validated settings UI instead of raw `server.properties`.
Setting `worldType` to `flat` writes `level-type=flat` plus the
generator-settings layer stack a superflat world requires
(`genesis/examples/minecraft-network/server/server.ts:178-183`) — a clean
lobby floor. World type only affects newly generated chunks, so it pairs
with `POST /api/reset-world`, which stops the server, deletes the world
directories from `/data`, and regenerates on the next start
(`genesis/examples/minecraft-network/server/server.ts:451-462`). Worlds live
in `/data` like all app state, so [snapshots](/docs/data) carry them.

## Restart self-healing

After a platform restart, a backend can boot before the hub is serving the
secret, and the hub can boot before any backend answers. Both sides retry
their resume for up to five minutes instead of giving up
(`genesis/examples/minecraft-network/server/server.ts:626-634`,
`genesis/examples/minecraft-network/hub/server.ts:454-462`), so the boot
order converges without operator action: backends come up, then the hub
registers them.

> [!tip]
> Deploy the network as `op apps create hub --owner myorg` plus one backend
> app per world, push `hub/` and `server/` into them, start backends, then
> the hub. The integration map (`/api/v1/integration-map?owner=myorg`) draws
> `hub → backends` for you.
