# THE DESIGN — `op.json` manifests, wiring, m2m auth, derived integration map

Synthesis of three proposals (minimal / systems / crew-first), judged against the platform's
principles and — decisively — against the **in-flight uncommitted work already in the tree**,
which none of the proposals knew about and which settles several of their disputes:

- `packages/opd/src/manifest.ts` (untracked, new): `AppManifest {resources, tcpPorts, assets}`,
  `AppPolicy` bounds, `admitManifest` (unknown keys dropped, missing file → `EMPTY_MANIFEST`),
  `readManifest(srcDir, policy)`, `isSafeDest` /data jail, sha256 **optional** (compute+record).
- `packages/opd/src/platform-config.ts` (modified): `PlatformSettings.apps: AppPolicy` +
  fail-closed validation in `admitPlatformConfig`.
- `packages/store/src/schema.ts` (modified): migration #8 `app_ports` (public_port PK,
  UNIQUE(owner,app,container_port), nullable host_port) — the hosts-table analog for L4;
  `store.allocateAppPort` sticky lowest-free-in-range; org-member promote-never-demote fix.
- `packages/engine/src/index.ts` (modified): `RunAppSpec.tcpPorts` → **loopback-only**
  multi-port bindings; `runApp` returns `tcpHostPorts` — i.e. the TCP path is a TcpGate
  _relay_, not public Docker PortBindings.

## Scorecard

|                | inevitability                                                                                                                                                                                                                 | migration safety | crew-usability                                                                 | payoff/line |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ | ----------- |
| **minimal**    | 8 — deterministic URLs, no provides, defaults=today; but public Docker PortBindings contradicts the in-flight loopback+relay decision and single-ingress                                                                      | 9                | 7 — one `OP_PEERS` JSON blob is weaker for agents than per-peer env            | 9           |
| **systems**    | 6 — deny-unknown-keys contradicts admitSpec convention _and_ the in-flight admitter; WAIT-on-required-consume reintroduces deploy ordering (A↔B deadlock); wiring-hash restarts; `Principal` union changes the gate interface | 7                | 6 — optional flags, capability matching, two consume kinds to teach            | 6           |
| **crew-first** | 8 — concrete `{owner,app}` consumes, unconditional deterministic injection, map-as-runtime-discovery replaces capability machinery; `/assets:ro` mount contradicts in-flight /data jail                                       | 9                | 9 — per-peer env by derivation, machine-legible admission errors, skills-first | 8           |

**Winner: crew-first skeleton**, run with minimal's cutting discipline, grafting systems'
auth rigor (RFC 8707 `resource`, disjoint audiences, aud-checked-at-target). Rejected ideas
listed at the end with reasons.

## 0. Organizing invariants

1. **`app.json` says where/whether; `op.json` says what/how much.** The operator spec
   (`apps/<owner>/<app>/app.json` in sys/gitops) keeps exactly its 6 fields (policy.ts:10-17).
   The manifest lives at the **app repo root**, read from the clone at the built SHA
   (reconcile.ts:235-250) — atomically versioned with the code, previewable per-PR. The two
   documents are disjoint by construction: no merge policy exists because no key overlaps.
   The manifest is threaded through `deployVariant` as a second value — never folded into
   `AppSpec`; `admitSpec`, `readAppSpecs`, and all four spec-writing sites are untouched.
2. **Missing `op.json` = `EMPTY_MANIFEST` = today's behavior, byte for byte** (already true
   in manifest.ts:73). Present-but-invalid = that deploy fails via `fail()` **before** the
   old container is stopped (admission at reconcile.ts:~275, stop at :294) — fail-closed,
   zero downtime, and the crew's preview loop catches it pre-merge.
3. **Everything derived, nothing stored.** Wiring env, extraHosts, peer URLs, and the
   integration map are pure functions of (specs, repo-head manifests, platform.json bounds).
   `app_ports` and `hosts` are actual-state routing caches rebuilt by reconcile. Mitosis:
   manifests ride app-repo bundles (app-seed.ts:16-26), bounds+skills ride plat/platform
   (genome), `apps/` stays stripped (platform.ts:468). Nothing new must survive in the
   platform DB.
4. **Names are the capability system.** A peer is `{owner, app}`; its URL is
   `https://` + `hostFor` (policy.ts:84-86) — deterministic, so injection never blocks on,
   or goes stale with, peer presence. No registry, no matching, no indirection.

## 1. Manifest schema (final)

`op.json` at app repo root. Extends the in-flight `AppManifest` with two fields:

```jsonc
{
  "resources": { "memoryMb": 1536, "cpus": 1 }, // in-flight, as-is
  "tcpPorts": [25565], // in-flight, as-is (container ports)
  "assets": [
    // in-flight, + allowlist check (below)
    {
      "url": "https://piston-data.mojang.com/v1/objects/<h>/server.jar",
      "sha256": "<64 hex, optional but taught>",
      "dest": "server.jar",
    }, // dest jailed in /data
  ],
  "provides": [
    // NEW — documentation-grade, non-binding
    {
      "name": "server-status",
      "path": "/api/status",
      "description": "player count, MOTD",
    },
  ],
  "consumes": [
    // NEW — concrete peers, drives wiring
    { "app": "shop" }, // owner defaults to spec.owner
    { "owner": "greener", "app": "mc-alpha" },
  ],
}
```

`packages/opd/src/manifest.ts` deltas:

```ts
export interface AppManifest {
  resources: { memoryMb?: number; cpus?: number };
  tcpPorts: number[];
  assets: AppAsset[];
  provides: { name: string; path: string; description: string }[]; // NEW
  consumes: { owner: string | null; app: string }[]; // NEW; null = same owner
}
export interface AppPolicy {
  maxMemoryMb: number;
  maxCpus: number;
  tcpPortRange: [number, number];
  maxTcpPortsPerApp: number;
  maxAssetMb: number;
  assetHosts: string[]; // NEW — default [] = assets denied
}
```

Admission additions in `admitManifest` (same style: unknown keys silently dropped —
matches admitSpec's forward-compat convention and lets old daughters ignore new fields):

- `provides`: ≤ 8; `name` matches `/^[a-z0-9][a-z0-9-]{0,31}$/`; `path` starts with `/`;
  `description` ≤ 200 chars. **No binding semantics** — labels for the map, the composer,
  and runtime discovery only.
- `consumes`: ≤ 16; `owner`/`app` pass `isValidName`; not the app itself; **deny duplicate
  derived env names** (`UP(app)` collision across two owners) — one name, one peer.
- `assets`: add `parsed.hostname` must be ∈ `policy.assetHosts` (exact match, lowercase).
  This is the one deliberate tightening of the in-flight code: `DEFAULT_APP_POLICY.assetHosts
= []` (fail-closed — platform-side egress must be opted into by a sovereign commit);
  genesis + live `plat/platform platform.json` ship `["piston-data.mojang.com"]`.
- `sha256` stays optional per in-flight design: unpinned assets are fetched once, hashed,
  and the computed hash is **recorded in the deploy event**; the builder skill teaches
  pinning it in the next commit. Trust-on-first-use with an audit trail beats blocking the
  crew on hash discovery.

`admitPlatformConfig` (platform-config.ts): add `assetHosts` — array of ≤ 32 lowercase
hostnames matching `/^[a-z0-9.-]{1,253}$/`, default `[]`.

## 2. Reconciler wiring (reconcile.ts `deployVariant`, the single deploy path)

Reconciler gains one dep: `config: () => PlatformSettings`. In `Platform.up`, construct
`PlatformConfig` + `await reload()` **before** `new Reconciler` (today it's built after
`reconciler.start()`, platform.ts:354 — it depends only on git+log; mechanical hoist), and
keep the existing onPush hot-reload hook.

Sequence inside `deployVariant` (insertion points against current line numbers):

1. **After the Dockerfile check (:259-274):**
   `const man = await readManifest(join(work, "src"), this.deps.config().apps);`
   error → `return fail("op.json: " + reason)`. Old container untouched.
2. **Port claims (prod only):** for each `man.tcpPorts`,
   `store.allocateAppPort(owner, app, port, policy.tcpPortRange)`; `null` → fail
   `"tcp port range exhausted"`. Sticky across redeploys (players keep their address).
   **Previews never allocate** — admission validates, a `preview-note` event says
   "tcpPorts not bound in previews"; the reviewer QAs the HTTP control plane.
3. **Asset cache-fill (before `buildImage`, so a slow download never causes downtime):**
   new `packages/opd/src/assets.ts`:
   - `ensureAssetCached(sd, asset, policy)` → `<sd.root>/assets/sha256/<hash>`;
     `fetch` with `redirect: "manual"`, re-check `assetHosts` per hop, stream with
     `maxAssetMb` cap, verify pinned sha256 (mismatch → fail deploy), else compute+return
     hash. Content-addressed: one download ever, shared across apps/previews/redeploys.
   - `placeAssets(dataDir, assets, cache)` — hardlink (fallback copy) into
     `<dataDir>/<dest>` (jail already enforced by `isSafeDest`); skip when dest already
     has the right hash. Runs **after** data provisioning (:301-310), before `runApp`.
     Emits `assets` event listing `dest@sha256[:8]`.
     Requires `spec.data === true` when `assets` is non-empty (checked at this call site,
     where spec and manifest are both in hand).
4. **The `runApp` call (:321-346)** gains, derived purely from the manifest:
   ```ts
   memoryBytes: man.resources.memoryMb ? man.resources.memoryMb * 1024 * 1024 : undefined,
   nanoCpus:    man.resources.cpus ? Math.round(man.resources.cpus * 1e9) : undefined,
   tcpPorts:    man.tcpPorts,                          // in-flight engine change, loopback-only
   env: { ...existing,
     ...Object.fromEntries(peers.map(p => [envNameFor(p.app), p.url])),     // OP_PEER_<APP>_URL
     ...Object.fromEntries(prodPortPairs.map(([cp, pub]) =>
       [`OP_TCP_PORT_${cp}`, String(pub)])),           // app renders "connect at <domain>:<pub>"
   },
   extraHosts: [`${domain}:host-gateway`,
     ...peers.map(p => `${p.host}:host-gateway`)],     // fixes in-container peer resolution
   ```
   where `peers = man.consumes.map(c => host = `${c.app}-${c.owner ?? spec.owner}.${domain}`,
url = this.originFor(host))` and `envNameFor(app) = "OP_PEER_" + app.toUpperCase()
.replaceAll("-","_") + "_URL"`. Previews get the same (prod) peers.
5. **After `runApp`:** record loopback bindings — `store.bindAppPort(publicPort, hostPort)`
   from the returned `tcpHostPorts`; kick the TcpGate to re-read its table.
6. **`prune` (:391-429):** `store.deleteAppPortsFor(owner, app)` when the app is removed
   (next to `deleteHostsFor`, :426).

**Absent consumed app:** URL + extraHost are injected anyway (deterministic). The gate
answers 404 "unknown host" until the peer deploys; a deployed-but-down peer answers 502.
Same failure class, same defensive code path in the consumer, zero consumer redeploy when
the peer appears. No WAIT, no ordering, no deadlocks; the dangling edge is visible on the
map. A _new_ peer set requires the consumer to edit its own `op.json` — a commit, which
redeploys it naturally. No wiring-hash machinery needed.

**TCP public path** (Thread-1 scope, contract stated here): `packages/gate/src/tcp.ts`
`TcpGate` — `Bun.listen` on each `app_ports.public_port` (0.0.0.0), byte-pump to
`127.0.0.1:<host_port>`; rows with `host_port IS NULL` refuse connections. Started in
platform.ts beside `gate.start()`. Containers stay loopback-only (engine index.ts:233
posture preserved by the in-flight diff); the gate family remains the only ingress.

## 3. Machine-to-machine auth

**Shape: app tokens die at the gate; identity continues as the existing `x-plat-user`
header with an `app:` prefix.** Apps never verify JWTs; the gate stays the single verifier.

1. **Identity (`packages/identity/src/index.ts`)** — one signer, one verifier, generalized:
   - `signAccessToken` claims gain optional `aud?: string` (default stays
     `${issuer}/userinfo`, :150 — user tokens byte-identical).
   - `verifyAccessToken(token, key, issuer, audience?)` — default unchanged.
   - `discoveryDocument`: `grant_types_supported: ["authorization_code", "client_credentials"]` (:92).
2. **Token endpoint (`packages/opd/src/oidc.ts`)** — restructure the early
   `grant_type !== "authorization_code"` return (:152-153) into a branch; new
   `client_credentials` arm (~25 lines) reusing `clientCredsFrom` (:28-50) and the same
   secret-hash check (:157-159):
   ```
   POST /oauth/token
     grant_type=client_credentials & resource=https://shop-greener.<domain>   (RFC 8707)
   ```
   Validate `resource` is an https origin whose host equals `domain` or ends `.${domain}`.
   Mint via `signAccessToken` with `sub = username = "app:" + client.owner + "/" + client.app
(+ "@" + preview)`, `scope: "app"`, `aud: resourceOrigin`, `ttlSec: 600`, no refresh token.
   - The per-deploy OIDC client **is** the service credential — `OIDC_CLIENT_ID/SECRET`
     already in every container's env (reconcile.ts:335-336), rotated in lockstep. Zero new
     secret machinery. No store migration: preview clients are detected structurally by
     `client.client_id !== "app-" + owner + "-" + app` (oidc-clients.ts:39-41).
   - **Preview clients MAY mint** (unlike proposal-minimal): otherwise integration is
     unreviewable in previews and the crew loop goes blind. Their `sub` carries `@pr-N`
     (`isValidName` forbids `@:/` — the whole `app:` namespace is structurally
     un-forgeable by users).
   - Disjoint audiences are the load-bearing invariant: user tokens aud=userinfo, app
     tokens aud=target-origin — neither can ever authenticate as the other.
3. **Gate bearer path — closure only.** `packages/gate/src/gate.ts` is untouched
   (interface stays `{username} | null`, gate.ts:14). The change is the injected
   `resolveUser` in platform.ts:337-340:
   ```ts
   resolveUser: async (req) => {
     const auth = req.headers.get("authorization") ?? "";
     if (auth.toLowerCase().startsWith("bearer ")) {
       const host = stripPort(req.headers.get("host") ?? "");
       const v = await verifyAccessToken(auth.slice(7).trim(), oidcKey, issuer,
         originFor(host));                       // aud checked against the TARGET host
       if (v.status === "ok" && v.value.sub.startsWith("app:"))
         return { username: v.value.username };  // "app:greener/website"
       // not one of ours → fall through: apps may run their own bearer schemes
     }
     const user = await forge.authenticate(req);
     return user ? { username: user.username } : null;
   },
   ```
   Audience-at-target makes confused-deputy structural: a token minted for `shop` replayed
   at `hub` verifies as nothing → anonymous. The Authorization header is forwarded upstream
   as today — harmless by construction (the token's aud is the receiving app itself).
   `authorizeApp` stays M1 public-read (platform.ts:343-344); when Thread-5 org authz
   lands, `app:` principals carry their owner in-band — one-line rule at that seam.
4. **Template helper** — ~25 zero-dep lines in `genesis/app-template/server.ts` (+ live
   commit to plat/app-template): `peerFetch(name, path, init)` — reads
   `OP_PEER_<name>_URL`, POSTs `client_credentials` + `resource` to
   `${OIDC_ISSUER}/oauth/token` with env creds, caches token per resource until expiry,
   retries once on 401, sends `Authorization: Bearer`. Peers read `x-plat-user` with the
   code they already have for humans. README documents the `app:` prefix and
   handle-absent-peers rule.

## 4. Derived integration map

**Never stored — recomputed from git heads.** New `packages/opd/src/integration.ts`:

```ts
export async function readManifestAt(git, repoOwner, repoName, ref, policy);
// git.readFile (githost.ts:283) on the bare repo — single file, no clone
export async function computeIntegrationMap(
  git,
  store,
  domain,
  policy,
): Promise<IntegrationMap>;

interface IntegrationMap {
  apps: Array<{
    owner: string;
    app: string;
    host: string;
    state: "running" | "building" | "pending" | "error" | null; // app_status join
    manifestError: string | null; // invalid op.json shows, never vanishes
    provides: { name; path; description }[];
    tcp: { containerPort: number; publicPort: number }[]; // app_ports join
    consumes: { owner; app; satisfied: boolean }[]; // satisfied = target spec admitted
  }>;
  edges: Array<{
    from: { owner; app };
    to: { owner; app };
    satisfied: boolean;
  }>;
}
```

Inputs: `readAppSpecs` (gitops.ts:83) + per-spec `readManifestAt` at `spec.ref` head +
store joins. N is small: compute per request, no cache, no staleness bookkeeping. On a
daughter it is correct the moment apps import — both inputs travel.

**Served:**

- `GET /api/v1/integration-map[?owner=]` in api.ts — **public read under M1** (it derives
  from public-read repos and statuses; same posture as `authorizeApp`). This makes it a
  _runtime discovery surface for apps themselves_ via the bare-domain extraHost: the
  Minecraft hub fetches the map and filters `provides.name === "mc-control"` /
  `tcp` endpoints — set-valued discovery with zero deploy-time capability machinery,
  always current, no consumer restarts when servers come and go. Tightens with Thread 5.
- Console `/integrations` route in console/index.ts (+ a filtered section on the org page,
  :400-423): server-rendered, dep-free, CSP-safe. Table of apps (provides chips, TCP
  endpoints as `<domain>:25500`, status pill from the existing kit) + table of edges;
  unsatisfied edge = red pill "consumes greener/shop — not deployed". No graph library.

## 5. Teaching the crew (the free win, wired first)

1. `builder.ts:202` and `reviewer.ts:170`:
   `systemPrompt: [agent.value.instructions, ...agent.value.skills].join("\n\n---\n\n")`
   — un-deadens platform-config.ts:135-146. Two lines, ship immediately.
2. Skills (genesis/platform/crew/… **and** live plat/platform commit — two-place
   discipline, map §3.2; crew-editable thereafter under builder.ts:251-258 allowlist):
   - `crew/builder/skills/manifest.md` — op.json vocabulary + worked MC example; the
     derivations (`OP_PEER_<APP>_URL`, `OP_TCP_PORT_<n>`, assets → `/data/<dest>`);
     invariants: _handle absent peers (404/502); never hardcode domains or peer URLs;
     tcpPorts don't bind in previews; pin sha256 (copy it from the deploy event on first
     fetch); call peers only via peerFetch_.
   - `crew/reviewer/skills/integration.md` — fetch `/api/v1/integration-map` for the app
     under review; unsatisfied edges are findings; QA TCP apps on their HTTP control plane;
     verify degradation with a peer absent; check `x-plat-user: app:` handling if the app
     authorizes callers.
   - Builder instructions: drop the "MUST serve HTTP" absolutism (instructions.md:9) —
     HTTP on `PORT` remains mandatory as the control plane; `tcpPorts` are _additional_.
3. Composer: move the hardcoded `SYSTEM` (crew/composer.ts:34, used :144, :229) into
   `plat/platform crew/composer/instructions.md` via the existing `loadAgent` — issues for
   integration-shaped ideas must name the consumed apps so the builder writes `consumes`.

## 6. Migration order (append-only, each step independently shippable)

0. **Land the in-flight work** (manifest.ts; platform-config apps block; app_ports
   migration + store accessors; engine multi-port loopback; org-role fix) — it is this
   design's substrate.
1. Skills channel one-liners (builder.ts:202, reviewer.ts:170).
2. manifest.ts: `provides`/`consumes` fields + `assetHosts` in AppPolicy (+ platform-config
   validation; genesis + live platform.json with the Mojang allowlist + tcp range).
3. platform.ts: hoist PlatformConfig above `new Reconciler`; add `config` dep.
4. reconcile.ts: manifest read/admit → port claims (prod) → asset cache-fill → build →
   stop-old → data → placeAssets → runApp(resources/tcpPorts/peer env/extraHosts/OP_TCP_PORT) →
   bindAppPort → prune releases ports. Plus `packages/opd/src/assets.ts`.
5. identity: optional `aud` on sign/verify + discovery line; oidc.ts: client_credentials
   branch; platform.ts resolveUser bearer path.
6. gate/src/tcp.ts TcpGate + platform.ts start (Thread-1 convergence point).
7. integration.ts + `GET /api/v1/integration-map` + console `/integrations` + org-page section.
8. Template: `peerFetch` + README (genesis + live plat/app-template).
9. Skills + composer move (genesis + live plat/platform).
10. Tests (below).

## 7. Test plan

- **Unit** (packages/opd/test): admitManifest — provides/consumes bounds, self-consume
  deny, duplicate env-name deny, assetHosts deny-by-default; envNameFor derivation;
  resource-origin validation; token round-trip with aud; preview-client sub carries `@pr-N`.
- **e2e**: two template apps A consumes B — assert B receives `x-plat-user: app:<owner>/a`
  via peerFetch through the gate; replay A→B token against C → header absent (anonymous);
  `client_credentials` with foreign-domain `resource` → 400; out-of-bounds op.json push →
  app_status `error` names the bound, prior container still serving; asset sha mismatch →
  deploy fails; unpinned asset → deploy event records computed hash.
- **Sim invariants** (test/sim/invariants.ts): every `app_ports` row corresponds to a
  tcpPort in the head manifest of an admitted prod spec (and vice versa after converge);
  integration-map edges ⊆ admitted specs; no container env contains a peer URL not
  derivable from its head manifest.
- **Mitosis e2e**: migrate an org with manifests → daughter's first converge re-derives
  wiring + fresh port allocations; map renders with zero imported platform-DB state.

## 8. What does NOT change

`AppSpec`/`admitSpec` (policy.ts:10-82) and all four spec-writing sites (api.ts:166-173,
246-253, 332-339; platform.ts:615-622). `readAppSpecs`. `hostFor`. The Gate package
interface and HTTP proxy (only the injected closure). `authorizeApp` M1 semantics. The
`hosts` table. authorization_code/PKCE/id-token/userinfo flows; user access tokens
byte-identical. oauth_clients schema. Data-plane CoW/snapshot format (assets live inside
/data as ordinary files). Both mitosis packages and the genome list. Dispatcher label
protocol. Engine loopback posture.

## 9. Rejected ideas (and why)

- **Capability registry / capability consumes / binding `provides`** (systems): interface
  indirection; runtime map queries give set-valued discovery with zero deploy-time
  machinery. `provides` survives only as non-binding documentation.
- **Deny-unknown-keys manifests** (systems): contradicts admitSpec's forward-compat
  convention and the in-flight admitter; old daughters must ignore new fields silently.
- **WAIT on required consumes + `optional` flag** (systems): reintroduces deploy ordering,
  deadlocks on mutual consumption; deterministic URLs make absence a runtime condition,
  which any network caller must handle anyway.
- **Wiring-hash convergence identity** (systems): unneeded once injection is unconditional
  and deterministic; a consumer's env can only change via its own commit.
- **Public Docker PortBindings** (minimal): contradicts in-flight loopback+TcpGate and
  the single-ingress invariant.
- **`Principal` union in the gate interface** (systems): the closure + `app:` username
  prefix carries the same information with zero interface churn.
- **Separate `signAppToken`** (systems): one signer with an optional aud — one
  implementation per subsystem.
- **Single `OP_PEERS` JSON env** (minimal): per-peer `OP_PEER_<APP>_URL` is the better
  agent convention; one convention only.
- **`preview` column on oauth_clients** (minimal): the client-id shape already encodes it.
- **Refusing client_credentials to preview clients** (minimal): makes integration
  unreviewable in preview; preview subs self-identify instead.
- **`/assets:ro` separate mount** (crew-first): in-flight jails assets in /data; one mount,
  one convention ("/data is the app's disk; the platform pre-places declared inputs").
- **Mandatory sha256** (all three): in-flight TOFU-with-recorded-hash keeps the crew
  unblocked; the skill closes the loop by teaching pin-on-next-commit.
- **Strip-Authorization-when-consumed** (systems): requires a proxy change; forwarding is
  harmless since the token's audience is the receiving app.
- **Shared bridge / DNS aliases / mesh; cross-preview peer graphs; SVG graph rendering;
  asset-cache GC; manifest version field; custom env names; per-app egress fields**: cut
  until something hurts.

## 10. Accepted risks

- Public TCP bypasses gate authz — bounded by the platform.json range, loopback+relay
  ownership, and the app protocol's own auth (Minecraft's); per-port L7 authz explicitly
  not attempted.
- Previews consume prod peers and can mint real tokens — subs carry `@pr-N` so providers
  can distinguish; reviewer skill says treat peers as read-mostly; durable fix is Thread-5
  org authz.
- Invalid bearer degrades to anonymous under M1 public-read (200-as-anon, not 401) —
  becomes a visible 403 the moment authorizeApp tightens.
- Daemon-side asset fetch is SSRF surface — https-only, exact-host allowlist re-checked
  per redirect hop, size cap, hash verification, allowlist in reviewable platform.json.

## Minecraft walkthrough (acceptance)

Operator commits `platform.json` `apps` bounds (range [25500,25599], Mojang allowlist).
`mc-alpha` op.json: `resources 1536MB`, `tcpPorts [25565]`, `assets [server.jar@sha]`,
`provides [{mc-control,/api},{server-status,/api/status}]` → jar verified into /data, JVM
sized, public 25500 assigned sticky, `OP_TCP_PORT_25565=25500` rendered as the join
address; control plane stays HTTP behind the gate. `website` consumes shop + mc-alpha →
`OP_PEER_SHOP_URL`/`OP_PEER_MC_ALPHA_URL` resolve in-container via extraHosts; peerFetch
mints aud-bound tokens from existing env creds; shop sees `x-plat-user: app:greener/website`.
`hub` reads `/api/v1/integration-map`, filters `provides: mc-control` — new servers appear
with no hub redeploy. Org migrates to a daughter: manifests in repo bundles, bounds in the
genome, first converge re-derives ports + wiring, map renders from zero platform-DB state.
