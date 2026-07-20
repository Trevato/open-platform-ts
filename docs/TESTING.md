# Catch-up & testing guide

The living doc for the July 2026 push. Read this to get current, then follow
any recipe to see a feature working. Updated after every milestone.

**Status (2026-07-14):** the capability release. Apps now declare what they
NEED in `op.json` beside their Dockerfile — memory/cpus, raw TCP ports (a
Minecraft server's 25565), assets the platform fetches into `/data` before
start (sha256-pinned, allowlisted hosts), and `provides`/`consumes` peer
declarations. The platform derives an **integration map** from repo heads
(`/api/v1/integration-map` + the console's Integrations page), wires peers by
injection (`OP_PEER_<APP>_URL` + `peerFetch` in the template with
client_credentials tokens that die at the gate as `x-plat-user: app:o/a`),
and relays public TCP through the gate on sticky ports. The app template now
ships a real UI kit (`ui.ts`, the console's design language). Issues and PRs
collapsed into **work items** — one lifecycle (intent → queued → building →
reviewing ⇄ reworking → shipped | parked), a legal-edge phase machine in the
store, a persisted attempts ledger (restart-safe rework, reviewer memory),
cross-repo deps, and human branches entering the same review machinery. The
crew skills channel is live (plat/platform `crew/<role>/skills/*.md` reach
prompts, hot-reloadable). Designs: `docs/design/04-work-items.md`,
`docs/design/05-manifest-integration.md`.

### Feel the capability release in one test

```sh
bun test test/capabilities.e2e.test.ts
```

~20s against real Docker: pushes an app whose `op.json` asks for 700 MB and a
raw TCP port → the container really gets the memory, the public port relays
bytes, an out-of-policy manifest fails closed while the old container keeps
serving, and the port survives redeploys (players keep their address).

### Try the on-ramp (the fastest way to feel it)

Boot a platform with a Claude token so the crew is live:

```sh
CLAUDE_CODE_OAUTH_TOKEN="$(cat claude-token)" op up
```

Open the console. The dashboard leads with **"What do you do?"** — type a task you
handle (or click a starter like _Intake tracker_), press **Build my tool**. The
platform names it, deploys it, and files the first build; you land on a live
progress view — **Got it → Building it → Making sure it works → Live**. When it's
live, use it, then change it by typing **"Tell me what to change."**

One call does it: `POST /api/v1/onramp {"description": "..."}` → creates the app +
files the first build. Proven offline in `test/console.e2e.test.ts`; the full
on-ramp→crew→ship loop on Sonnet 5 is `test/crew-live.e2e.test.ts` (gated behind
`OP_CREW_LIVE=1` + a token).

## Milestones

| #   | Milestone                                                      | State      | Proof                                                    |
| --- | -------------------------------------------------------------- | ---------- | -------------------------------------------------------- |
| 1   | Crew led by Sonnet 5 (`crew.model` config, hot-reload)         | ✅         | `bun test packages/opd/test/platform-config.test.ts`     |
| —   | Fix: seed carries `plat/platform` (crew was dead on daughters) | ✅         | `bun run test:m1` (asserts crew loads on the daughter)   |
| 2   | Orgs — shared namespaces owning repos/apps                     | ✅         | `bun test packages/forge/test/orgs.test.ts`              |
| 3   | GitHub import — drop a URL, crew tunes & deploys               | ✅ built\* | `bun test packages/git/test/githost.test.ts`             |
| 4   | App migration — export an app, a client platform ingests it    | ✅         | `bun test test/migration.e2e.test.ts`                    |
| 5   | Console design refresh (shadcn language, still dep-free)       | ✅         | `bun test test/console.e2e.test.ts`                      |
| 6   | Issue dependencies + flow (blocked-by, cycle-safe, DAG)        | ✅         | `bun test packages/forge/test/issue-deps.test.ts`        |
| 7   | Simulation harness — swarm platforms with personas             | ✅         | `bun test test/sim/sim.test.ts`                          |
| 8   | Demo: business org → built software → sold via migration       | ✅         | `docs/DEMO.md` (+ migration & console e2e)               |
| 9   | Live proof: Sonnet 5 builds & ships 3 office apps in tandem    | ✅         | `test/crew-live.e2e.test.ts` (`OP_CREW_LIVE=1`+token)    |
| 10  | On-ramp: describe a workflow → working tool (for non-coders)   | ✅         | `bun test test/console.e2e.test.ts` (+ crew-live)        |
| 11  | `op.json` manifests: resources, TCP ports, assets, peers       | ✅         | `bun test packages/opd/test/manifest.test.ts`            |
| 12  | Raw TCP ingress (TcpGate relay, sticky public ports)           | ✅         | `bun test test/capabilities.e2e.test.ts`                 |
| 13  | Platform-fetched assets (cache, sha256 pin, allowlist)         | ✅         | `bun test packages/opd/test/assets.test.ts`              |
| 14  | App-to-app auth (client_credentials, aud dies at the gate)     | ✅         | `bun test packages/opd/test/oidc.test.ts` (+ e2e)        |
| 15  | Derived integration map (API + console Integrations page)      | ✅         | `GET /api/v1/integration-map` on any platform            |
| 16  | Template UI kit (`ui.ts`) + `peerFetch` in the genome          | ✅         | `genesis/app-template/` (+ README contract)              |
| 17  | Work items: one lifecycle, attempts ledger, cross-repo deps    | ✅         | `bun test packages/store packages/opd/test/crew.test.ts` |

\* Import backend, console control, and the `importer` crew role are built and
the clone path is tested. The full crew-tuning loop needs `CLAUDE_CODE_OAUTH_TOKEN`
set (run `claude setup-token`); without it the import lands the repo + files the
conversion issue and the crew picks it up once credentialed.

## Recipes

### Boot a platform, open the refreshed console

```sh
op up                 # prints your card: admin password + first-app curl
```

Open the platform URL. New this round:

- **Orgs** nav item → create an org, see its software in one place.
- **Import from GitHub** field on the Apps page.
- The whole UI now uses the shadcn token system (OKLCH tokens, the two-part
  focus ring, 36px controls, 24px cards) across all three themes — hand-built,
  still zero dependencies and strict-CSP.

### Crew on Sonnet 5

Model lives in git — `plat/platform:platform.json` — and hot-reloads on push:

```json
{ "crew": { "maxRework": 2, "sweepMs": 30000, "model": "claude-sonnet-5" } }
```

Fresh platforms default to `claude-sonnet-5`. Change it with a commit to
`plat/platform` (e.g. `"model": "claude-opus-4-8"`); a malformed value is
rejected fail-closed. The composer (spec drafting) stays on Haiku
(`OP_COMPOSER_MODEL` overrides). Builder + reviewer now pass `--model` from config.

### Orgs — visualize a business's software

In the console: **Orgs → Create org** (e.g. `acme`). On the org page: create apps
under the org, add members, and see every app/repo the org owns in one grid.
Members can write under the org namespace; non-members get read-only. Names can't
collide with usernames or reserved names (both directions guarded).

CLI/API equivalents:

```sh
curl -XPOST $API/api/v1/orgs -d '{"name":"acme","displayName":"Acme Inc"}'
curl -XPOST $API/api/v1/apps  -d '{"name":"store","owner":"acme"}'
curl -XPOST $API/api/v1/orgs/acme/members -d '{"username":"bob"}'
```

### Import a GitHub repo

Paste a repo URL into **Import from GitHub** (or `POST /api/v1/apps/import
{"url": "..."}`). The platform clones it into its own git host, registers it as
an app, and files an `agent-import` issue; the `importer` crew role (led by
Sonnet 5) adds a Dockerfile serving `$PORT`, points data at `$DATA_DIR`, and the
normal preview → review → merge pipeline ships it.

### Sell an app via migration

```sh
# on the seller's platform
op app export acme/store store.tar.gz
# hand store.tar.gz to a client, who runs it on THEIR platform:
op app import store.tar.gz            # or: op app import store.tar.gz newowner/store
op up                                 # the client serves it
```

The artifact carries the repo (full history), a verified data snapshot, and the
app.json — no keys, no platform secrets (OIDC client + APP_SECRET are re-minted
on the client at deploy). The migration e2e proves the client's copy serves with
the seller's data intact (visit counter continues, not reset).

### Simulation at scale

A seeded, deterministic swarm drives real traffic (HTTPS API + git + Docker) at
a live platform with 5 personas (builder, churner, forker, noisy-neighbor,
attacker) and checks invariants between batches — tenant isolation, credential
canaries (no secret in any git history / event / comment), deploy state-machine,
container hygiene, and fleet sovereignty.

```sh
bun test test/sim/sim.test.ts                  # ~34s default
OP_SIM_SEED=0x504c4154 bun test test/sim       # reproduce a specific run
OP_SIM_HEAVY=1 bun test test/sim               # more personas + PR previews
OP_SIM_FLEET=1 bun test test/sim               # + germinate a daughter, check sovereignty
```

The seed prints at the start of every run and is embedded in each failure, so a
red run reproduces exactly. See `test/sim/README.md`.

### A Minecraft server network (the capability layer, end to end)

`genesis/examples/minecraft-network/` runs a real Velocity network as platform
apps — proof that `op.json` (assets, TCP ports, resources), the integration
map, and `peerFetch` auth compose into something substantial with **zero
platform changes**.

- `server/` — a Minecraft server app: Paper via an `op.json` asset, a settings
  UI for role/gamemode/MOTD, TCP `25565`. Role `backend` joins a network with
  modern forwarding; `standalone` is publicly joinable on its own.
- `hub/` — a Velocity proxy app that `consumes` the backends, holds the
  forwarding secret, and hands it to its backends over `peerFetch`. One public
  port; `/server` hops between worlds; the integration map draws the topology.

Create one `hub` + N `server` apps under an org, set each server's role to
`backend` in its settings, start the backends then the hub — players connect to
the hub's port. A direct login to a backend is rejected with a
`velocity:player_info` challenge (modern forwarding closes the offline-mode
spoof hole). See the example's `README.md`.

### Whole-loop sanity

```sh
bun run typecheck && bun test packages   # all unit tests (fast, ~22s)
bun run test:m1                          # <1min full platform loop
bun test test/migration.e2e.test.ts      # seller → client app migration (~15s)
bun test test/console.e2e.test.ts        # orgs + deps + design render (~3s)
bun test test/capabilities.e2e.test.ts   # op.json resources/TCP/fail-closed (~20s)
```

### Run the local version (not the npm one)

The dev loop runs the CLI straight from source — the workspace resolves every
`@op/*` package, no build step:

```sh
bun packages/opd/src/cli.ts up           # any env applies: OP_ROOT, DOMAIN, ports
```

Before a release, test the **packaged** artifact exactly as npm serves it —
bundle, pack the tarball, install it into a scratch dir, boot from there:

```sh
bun run build:npm
TGZ=$(cd dist && npm pack --silent)
mkdir -p /tmp/op-pkg-test && cd /tmp/op-pkg-test
bun add "$OLDPWD/dist/$TGZ"
HTTP_PORT=9080 HTTPS_PORT=9443 OP_ROOT=./fresh FORK_KEY_ACK=1 ./node_modules/.bin/op up
```

Genesis should print the card in about a second; a second `up` on the same
root must resume (`isGenesis:false`), `/docs` must serve 200, and
`OP_ROOT=./fresh ./node_modules/.bin/op admin-password` must print the
password. This catches whole-package failures (bundling, genesis-dir
resolution, relative `OP_ROOT`) that unit tests structurally can't.

Full walkthrough of the business story: **`docs/DEMO.md`**.
