# A Minecraft server network on the platform

A worked example of the platform's capability layer: `op.json` manifests
(assets, raw TCP ports, resources), the derived integration map, and
app-to-app auth via `peerFetch` — used to run a real Minecraft network with a
Velocity proxy, entirely as platform apps.

## The shape

```
                players
                   │  25565 (one public port)
             ┌─────▼─────┐
             │    hub    │  Velocity proxy app (this dir: hub/)
             │  /server  │  consumes the backends; holds the forwarding secret
             └──┬──┬──┬──┘
       ┌────────┘  │  └────────┐
   ┌───▼───┐   ┌───▼───┐   ┌───▼────┐
   │mc-lobby│  │survival│  │creative│   Paper backend apps (this dir: server/)
   └────────┘  └────────┘  └────────┘   online-mode off + modern forwarding
```

- **`server/`** — a Minecraft server as an app. Bun HTTP control plane +
  a Paper (java) child. `op.json` fetches the Paper jar into `/data`, asks
  for memory, and exposes TCP `25565`. A settings UI picks the role and
  gamemode/difficulty/MOTD — no raw `server.properties` editing.
  - **standalone** — public, real auth (`online-mode=true`), join directly.
  - **backend** — part of a network: `online-mode=false`, Velocity modern
    forwarding on, the shared secret fetched from the hub over `peerFetch`.
- **`hub/`** — a Velocity proxy as an app. It `consumes` the backends, so the
  platform injects each one's `OP_PEER_<APP>_URL`; the hub discovers their live
  addresses (`/api/status`) and writes `velocity.toml`. It owns the modern-
  forwarding secret and hands it only to its own backends via an authenticated
  `/api/forwarding-secret` endpoint (the gate stamps the caller as
  `x-plat-user: app:<owner>/<app>`).

## Why it's safe without hand-wiring

The classic Velocity footgun is that offline-mode backends let anyone spoof a
username. Two things close it here, both handled by the platform:

1. **Modern forwarding.** A backend with `proxies.velocity.enabled: true`
   demands a signed `velocity:player_info` handshake on every login. A client
   connecting directly to a backend port can't produce it and is rejected —
   verified: a direct login attempt gets a `velocity:player_info` login-plugin
   request it cannot answer.
2. **The secret travels over `peerFetch`.** The forwarding secret — the trust
   root — is minted by the hub and pulled by its backends over the gate-
   verified app-to-app channel, never copy-pasted. A foreign app or a human
   asking the hub for it gets `403`.

## Versions (pinned in `op.json`)

- Paper `1.21.11` build 132 (Java 21), from `fill-data.papermc.io`.
- Velocity `3.5.1` build 615 (Java 21). Velocity `4.0.0` needs Java 25 — hence
  3.5.x to match Paper's Java 21.
- Both hosts are on the platform's default `assetHosts` allowlist.

One config footgun worth knowing: Velocity injects its example `[forced-hosts]`
(`factions.example.com`, …) for an _omitted_ section, which then fail
validation — so the generated `velocity.toml` always writes an explicit empty
`[forced-hosts]`.

## Deploy

```sh
# one proxy + N backends under an org
op apps create hub --owner myorg          # or POST /api/v1/apps
op apps create mc-lobby --owner myorg
# push server/ into each backend repo, hub/ into the hub repo
# in each backend's settings: role = backend  (mc-creative → gamemode creative)
# start the backends, then start the hub — players join at the hub's port
```

The integration map (`/api/v1/integration-map?owner=myorg`, console →
Integrations) draws `hub → {mc-lobby, mc-survival, mc-creative}`.
