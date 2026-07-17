---
title: Connect apps
description: Peer wiring by derivation — declare a peer in op.json and the platform injects the URL, authenticates the call, and maps the edge.
---

Apps connect by declaration, not registration: you name the peers you call
in `op.json`, and the platform derives everything else — the peer's URL as
an environment variable, a credential scoped to exactly that peer, and a
live map of who talks to whom. There is no service registry to update and
no config that can drift; the wiring is a pure function of what's in git.

## Declare peers in op.json

Two manifest fields carry the wiring (see [The app manifest](/docs/app-manifest)
for the full format):

```json title="op.json"
{
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

Each `consumes` entry injects `OP_PEER_<APP>_URL` into your container at
deploy — the app name uppercased, dashes to underscores
(`packages/opd/src/manifest.ts:64`, injected at
`packages/opd/src/reconcile.ts:448`). Omitting `owner` defaults the peer to
your own owner. `provides` is documentation-grade: it labels your surface on
the integration map, nothing enforces it.

> [!note]
> Peer URLs are injected whether or not the peer is deployed. An absent peer
> answers 404, a stopped one 502 — handle both as normal conditions, like any
> network call.

## Call a peer with peerFetch

The app template ships `peerFetch(name, path, init?)`
(`genesis/app-template/server.ts:130`). It resolves `OP_PEER_<APP>_URL`,
mints a `client_credentials` token from your app's per-deploy OIDC client
with the peer's origin as the RFC 8707 `resource` — so the token's `aud` is
that one target (`packages/opd/src/oidc.ts:196`) — caches it until 30
seconds before expiry, and retries once on 401.

The token dies at the gate: the audience is verified against the host
actually being called, so a token minted for one app verifies as nothing at
any other (`packages/opd/src/platform.ts:397`). Your peer never parses a
JWT — it reads the gate-stamped `x-plat-user: app:<owner>/<app>` header, the
same header human visitors arrive with. See [Identity](/docs/identity) for
why that header is unforgeable.

## The derived integration map

The map is derived, never stored: a pure function of the app specs in
`sys/gitops`, each repo's `op.json` read at its deployed ref, and live
status (`packages/opd/src/integration.ts:12`). Nothing has to be
invalidated, so it can never go stale — and it survives
[platform reproduction](/docs/sovereignty) for free, because both inputs
travel with the repos.

Read it at `GET /api/v1/integration-map`, optionally `?owner=` scoped
(`packages/opd/src/api.ts:170`). It is unauthenticated by design, so apps
can poll it as runtime discovery — a hub sees new peers with no redeploy.
The console renders the same graph on the **Integrations** page. Each node
carries `provides`, `consumes` (with a `satisfied` flag per edge), and TCP
port mappings.

## One edge, end to end

The Minecraft network in `genesis/examples/minecraft-network` runs this
whole loop. A backend server declares the proxy as its peer
(`genesis/examples/minecraft-network/server/op.json:23`), so its container
boots with `OP_PEER_HUB_URL` set. On start it fetches the shared Velocity
forwarding secret from the hub over the app-to-app channel — token minted
with `resource` = the hub's origin, then a `GET /api/forwarding-secret`
(`genesis/examples/minecraft-network/server/server.ts:135`). The hub checks
that the gate-verified actor is `app:<owner>/<backend>` for a backend it
consumes, and answers 403 to everyone else
(`genesis/examples/minecraft-network/hub/server.ts:308`). The secret never
travels by hand, and no app ever holds a credential that works anywhere but
its one intended peer. See [Run game servers](/docs/game-servers) for the
rest of the example.
