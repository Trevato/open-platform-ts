# Platform vocabulary — op.json, peers, TCP, assets, the UI kit

The repo you work in is a platform app. Beyond HTTP on `PORT`, it declares
extra needs in `op.json` at the repo root, beside the Dockerfile. Absent =
no special needs. Invalid or over the operator's bounds = the deploy fails
naming the exact reason (the running version keeps serving) — fix `op.json`
and commit again.

## op.json — five fields (a Minecraft server uses all of them)

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

Declare only what the issue needs — every field defaults to nothing.

## Resources

`memoryMb`/`cpus` size the container (defaults 512 MB / 1 CPU). A JVM run
with `-Xmx1024M` needs `memoryMb: 1536` — don't guess low and get OOM-killed.

## Raw TCP ports (`tcpPorts`)

- HTTP on `PORT` stays mandatory — it is the control plane the platform, the
  reviewer, and peer apps talk to. `tcpPorts` are ADDITIONAL listeners for raw
  protocols (game servers etc.), never a replacement.
- Each container port gets a sticky public port, injected as
  `OP_TCP_PORT_<containerPort>` (e.g. `OP_TCP_PORT_25565=25500`). Render the
  join address from env, never a literal:
  `${process.env.OP_HOST}:${process.env.OP_TCP_PORT_25565}`.
- Previews NEVER bind `tcpPorts` (the env vars are absent there). Build the
  HTTP control plane so the feature is provable over HTTP — a status route,
  a config view — and render a clear "no public port yet" state when the env
  is missing. That is exactly what the reviewer will QA.

## Assets

- Declared files are downloaded by the platform (operator-allowlisted hosts
  only) into `/data/<dest>` BEFORE the container starts. Just open the file —
  never download at runtime.
- `sha256` may be omitted on the first fetch: the deploy event records
  `fetched <dest> (<n> MB) sha256=<hash>`. Pin that hash into `op.json` in
  your NEXT commit — never leave an asset unpinned longer than one commit.

## Peers — `consumes` + `peerFetch`

- To call app `shop`, add `{ "app": "shop" }` to `consumes` (same owner by
  default; `{ "owner": "acme", "app": "shop" }` crosses owners). The platform
  injects `OP_PEER_SHOP_URL` (name upper-cased, `-` → `_`).
- Call peers ONLY through the template's `peerFetch` — it reads that env,
  mints and caches an audience-bound token, retries once on 401:

  ```ts
  const res = await peerFetch("shop", "/api/items");
  if (!res.ok) return renderShopUnavailable(); // 404/502 are NORMAL
  ```

- An absent peer answers 404; a down one 502. Every peer call needs a
  degraded path — an empty list, a "shop unavailable" note — never a crash
  or a 500 of your own.
- NEVER hardcode a domain, hostname, or peer URL — not in `fetch`, not in
  rendered HTML. If you typed a literal `https://` outside an `op.json`
  asset URL, stop and use the injected env instead.
- The peer sees you as `x-plat-user: app:<owner>/<app>` (previews append
  `@pr-N`) — the same gate-verified header it already reads for humans.
- Runtime discovery: `GET ${new URL(process.env.OIDC_ISSUER).origin}/api/v1/integration-map`
  lists every app's `provides`/`consumes`/`tcp` — filter by `provides.name`
  to find peers by capability instead of hardcoding a peer list.

## UI — use `ui.ts`, don't hand-roll

The repo ships `ui.ts`: the platform's design language (OKLCH tokens, light +
dark themes) as template-literal helpers. Compose every page from
`layout`, `pageHeader`, `card`, `button`, `field`, `table`, `pill`, `stat`,
`empty` and return `html(layout({ title, user, body }))` — do NOT write
`<style>` blocks, ad-hoc CSS, or new components. Helpers escape their text
params; the raw-HTML slots (`body`, `actions`, `footer`, table cells) do not
— run user text through `esc()` there.

## Dual render (unchanged)

Every route keeps the JSON-for-machines / HTML-for-browsers contract. Machine
callers — including peers via `peerFetch` — get JSON; browsers get kit HTML.
