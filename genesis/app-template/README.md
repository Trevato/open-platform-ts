# Your app

Push to `main` and the platform builds the Dockerfile and ships it to
`https://<app>-<you>.<your-platform-domain>`.

## The contract

- `DATA_DIR` (default `/data`) is your durable data directory — put your
  SQLite database and files there. The platform snapshots, backs up, and can
  branch it.
- `PORT` is where your HTTP server must listen (default 8080). HTTP on `PORT`
  is your control plane — always serve it, even when your real protocol is
  raw TCP.
- Authenticated callers reach you with an `X-Plat-User` header — verified at
  the edge; a client can never spoof it. Humans arrive as `alice`; peer apps
  arrive as `app:<owner>/<app>` (previews append `@pr-N`).

## UI kit (`ui.ts`)

The platform console's design language — OKLCH tokens, light + dark themes,
focus rings — as template-literal helpers. Zero dependencies, everything
inlined; pages render offline and under the strict CSP that `html()` sets.

- `layout({title, user?, nav?, body})` — full document: sticky header, theme
  toggle, main column. Return `html(layout({...}))` from your handler.
- `pageHeader({title, sub?, actions?})` · `card(body, {title?, desc?, footer?, tone?})`
- `button(label, {href?, variant: "primary" | "ghost" | "danger", small?})`
- `field({label, name, type?, value?, desc?, error?})` — label, input,
  description, and error in one block
- `table(head, rows)` · `pill(label, "ok" | "warn" | "danger" | "neutral")`
- `stat({label, value, hint?})` · `empty({icon?, title, desc?, actions?})`
- `esc(text)` — escape anything user-supplied before interpolating it into a
  raw-HTML slot (`body`, `actions`, `footer`, table cells).

## Declaring needs: `op.json`

Optional file at the repo root, beside the Dockerfile. Absent = you need
nothing special. Invalid or over platform bounds = the deploy fails with the
reason and the running version keeps serving. Five fields — a Minecraft
server uses all of them:

```json
{
  "resources": { "memoryMb": 1536, "cpus": 1 },
  "tcpPorts": [25565],
  "assets": [
    {
      "url": "https://piston-data.mojang.com/v1/objects/<hash>/server.jar",
      "sha256": "<64 hex — optional on first fetch, then pin it>",
      "dest": "server.jar"
    }
  ],
  "provides": [
    {
      "name": "server-status",
      "path": "/api/status",
      "description": "player count, MOTD"
    }
  ],
  "consumes": [{ "app": "shop" }]
}
```

- **resources** — container memory/CPU (defaults 512 MB / 1 CPU; platform
  bounds apply).
- **tcpPorts** — container ports to expose as raw public TCP. Each gets a
  sticky public port from the platform's range, injected as
  `OP_TCP_PORT_<containerPort>` (e.g. `OP_TCP_PORT_25565=25500`) — render it
  as your join address. Previews never bind TCP ports; reviewers QA your HTTP
  control plane instead.
- **assets** — files the platform downloads (from allowlisted hosts) into
  `/data/<dest>` before your container starts. `sha256` is optional on first
  fetch: the computed hash is recorded in the deploy event — copy it into
  `op.json` in your next commit to pin it.
- **provides** — what you offer peers. Documentation, not binding: it labels
  the integration map (`GET https://<domain>/api/v1/integration-map`), which
  any app can fetch at runtime to discover peers by name.
- **consumes** — peer apps you call. Each injects `OP_PEER_<APP>_URL`
  (app name upper-cased, `-` → `_`: shop → `OP_PEER_SHOP_URL`). `owner`
  defaults to your own owner.

## Calling peers: `peerFetch`

```ts
const res = await peerFetch("shop", "/api/items");
if (res.ok) {
  /* ... */
}
```

`peerFetch(name, path, init?)` reads `OP_PEER_<NAME>_URL`, mints a short-lived
token audience-bound to that peer (cached until just before expiry, one retry
on 401), and sends it as a Bearer. The peer sees
`x-plat-user: app:<owner>/<app>` — the same header it already reads for
humans; the token verifies as nothing anywhere else. Peer URLs are injected
whether or not the peer is deployed: an absent peer answers 404, a down one 502. Both are normal — handle them; never treat a peer as guaranteed.
