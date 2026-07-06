# open-platform-ts — Build Plan

## Context

Open Platform (mitosis + gitops + mcp + agents + \_app-template + ci-builder on k8s)
is validated: a production app migrated today, SOWs are out. But the implementation
has outgrown the idea. The evidence is in the repo itself: `bin/germinate` is 790
lines of bash negotiating with the substrate (sqlite→postgres Forgejo handoff
gates, dind MTU shims, Flux race kicks); boots take 30–60 min; CI germination
gates take 55 min; **every Kyverno policy is Audit-only, forwardAuth is
default-off, the cosign key is a placeholder** — much of the k8s weight enforces
nothing. The 9 primitives that make the platform work are substrate-independent.

**Mission:** reimplement the idea in TypeScript at `~/projects/open-platform-ts`
(exists, empty). An open-source GitHub+Vercel+Supabase whose headline property is
**mitosis**: any platform seeds sovereign daughter platforms in seconds, and the
whole loop is proven by one CI test in **under a minute** (vs 55 min today).

**Decisions made by trevato (fixed):**

1. **Own git in TS** — no Forgejo. Git hosting/identity/PRs are product modules.
2. **No adapters** — one principled implementation per subsystem; portability
   comes from open _standards_ (git protocol, OCI/Dockerfile, SQL/SQLite file
   format, S3 API, OIDC, HTTP/TLS/ACME), never from adapter indirection.
3. **Clean room** — zero compatibility obligations to the k8s platform.
4. **M1 = full loop, shallow** — boot → user → push Dockerfile app → build → run
   → URL 200 → app data round-trip → seed → germinate sovereign daughter →
   daughter passes the same checks. All timed, <60s.
5. Bun toolchain; better-result approved for errors-as-values.
6. **Data backbone = SQLite + files, one "data" primitive** (trevato's trim,
   validated by adversarial review — see Data plane below). No shared Postgres.
   "Tying data to source control" (Lore-inspired) is a staged roadmap, not v1.

Design process: 12-agent recon (mitosis architecture ×4 lenses + 8 research
tracks) → 3 independent architects (minimalist / production-honest /
mitosis-first) + adversarial critic (agreed 11/14; critic verdicts adopted) →
data-plane round (Lore + SQLite-in-production + versioned-data research + a
second adversarial attack on the SQLite-first redesign). Full dossiers:
`/private/tmp/claude-501/-Users-trevato-projects-mitosis/85591c3f-3ca0-43c4-968d-a6be3817c27c/scratchpad/{research-full,designs-full,data-plane-full}.md`

## Architecture

**One Bun process, `opd`** (daemon; `bun build --compile` later) + `op` CLI.
Forgejo, Flux, Traefik, cert-manager, Kyverno, KEDA, MinIO, CNPG, coredns all
collapse into modules of one daemon. Apps run as containers beside it; agent
runs as containers. **The platform itself starts zero containers** — the data
plane is files. "Forest approach" = many small sharp packages in one monorepo
composing into one runtime — not microservices.

**Substrate contract (total): `bun`, `git`, a Docker-Engine-API socket.**

**State on disk** (`~/.op/<domain>/` or `/var/lib/op/`): `key.age` (sovereign, 0600) · `db.sqlite` (WAL) · `repos/<owner>/<name>.git` · `appdata/<owner>/<app>/`
· `certs/` · `ORIGIN`. Desired state lives in git — system repo `sys/gitops`
holds `apps/<owner>/<app>/{app.json, secrets.age.json}`; the reconciler
converges HEAD event-driven (post-receive hook = in-process event; no polling,
no Flux races by construction). SQLite is canonical for forge/identity data
(users, PATs, PRs, sessions, statuses) — WAL-shipped to backup targets.
**Backup inventory = db.sqlite + repos/ + appdata/ (db + files, quiesced) —
never omit repos/ (canonical desired state).**

**Boot** (<2s): open SQLite → load/mint sovereign key → mint CA + wildcard cert →
init system repos from embedded genesis (first boot) → start one listener
(router+git+API+OIDC+MCP+S3) → start reconciler → print YOUR PLATFORM card.
No phases, no handoffs, no containers. Crash-only: level-based idempotent
reconcile, apps outlive the daemon (`--restart=always`), supervisor restarts
`opd` in ~1s.

### Packages (`packages/*`, ~21k LOC core — production-honest accounting)

| package      | responsibility                                                                                                                                                                                                                                                                                                | LOC   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `core`       | TaggedError unions (better-result), config, ids, structured log                                                                                                                                                                                                                                               | 800   |
| `store`      | bun:sqlite WAL schema + typed queries + migrations + WAL shipping                                                                                                                                                                                                                                             | 1,200 |
| `git`        | bare-repo store, smart-HTTP (spawn `git upload-pack/receive-pack --stateless-rpc`), `cat-file --batch` read pool, hooks→events, bundles                                                                                                                                                                       | 2,000 |
| `forge`      | users/orgs/teams, repos, PRs/issues, webhooks (HMAC), PATs, template repos, branch protection                                                                                                                                                                                                                 | 3,000 |
| `identity`   | minimal OIDC provider on `jose`: discovery, code+PKCE, client_credentials, JWKS; sessions                                                                                                                                                                                                                     | 1,500 |
| `secrets`    | typage (age) sealing; custody gate; regen-all; verifyAllSealed                                                                                                                                                                                                                                                | 600   |
| `engine`     | Docker Engine API client — raw fetch over unix socket: build/create/start/inspect/logs/events (streaming)                                                                                                                                                                                                     | 1,000 |
| `builder`    | Dockerfile→image orchestration, digest pinning, image GC                                                                                                                                                                                                                                                      | 600   |
| `data`       | per-app data dir provisioning + quota; **snapshot protocol** (open app.db from host side → `PRAGMA wal_checkpoint(TRUNCATE)` → CoW clone via APFS clonefile/XFS reflink, `VACUUM INTO` + copy fallback on ext4); restore + `integrity_check` verification; per-PR data branches; backup pipeline (db + files) | 900   |
| `blobs`      | S3-subset API server (SigV4, presign, **multipart**, ListObjectsV2) **storing into the app's data dir** — presigned URLs/SDK compat are the API, fs layout is the implementation; conformance-tested against official AWS SDK                                                                                 | 1,200 |
| `gate`       | ingress `Bun.serve` :80/:443, SNI, host table, forward-auth middleware (**on by default**), ACME (RFC 8555 on jose, M2)                                                                                                                                                                                       | 1,500 |
| `reconcile`  | desired(git) vs actual(engine labels) diff/converge; app cron jobs                                                                                                                                                                                                                                            | 1,500 |
| `policy`     | synchronous fail-closed admission at pre-receive + deploy; **no audit mode exists**                                                                                                                                                                                                                           | 700   |
| `mcp`        | REST+MCP tool surface; `authorize()` against git permissions; scoped ephemeral agent tokens (#16)                                                                                                                                                                                                             | 1,500 |
| `crew`       | dispatcher; agents-as-directories (`sys/crew`, eve-inspired, no eve dep); runs in containers; Playwright validator                                                                                                                                                                                            | 1,500 |
| `mitosis`    | `seed()` / `germinate()` / lineage(ORIGIN); **versioned manifest**                                                                                                                                                                                                                                            | 900   |
| `opd` / `op` | composition root, supervision / CLI (`up seed germinate status data`)                                                                                                                                                                                                                                         | 1,100 |

**Runtime deps (counted, ~8):** `better-result`, `typage` (age-encryption — by
age's own author), `jose`, `@peculiar/x509`, `ai` + `zod`,
`@modelcontextprotocol/sdk`, playwright (crew only). Everything else is Bun
built-ins (serve/TLS, sqlite, spawn, unix-socket fetch). Dependency count
asserted in CI from the lockfile.

### Subsystem positions (settled)

- **Git wire = system git binary** (`--stateless-rpc`), exactly like every real
  forge; TS owns auth/HTTP/product surface. **No isomorphic-git** — two git
  implementations on the same bare repos is a ref-lock corruption surface.
- **OIDC = hand-rolled minimal provider on `jose`** — better-auth's provider
  plugin is mid-deprecation; own the identity root. Template apps consume it via
  better-auth _client_ (their dependency; symmetric with today).
- **Build = Engine `POST /build`; no registry in M1** — the engine image store
  is the registry on one node. Kills MANIFEST_UNKNOWN races, registry-mirror-at-
  creation, serial in-cluster builds, and the public-ci-builder 401 dance.
- **Secrets = sovereignty invariant verbatim** from
  `mitosis/docs/security/secrets-threat-model.md`: every value sealed to exactly
  one recipient, minted at germination, no escrow/second recipient/parent copy;
  regenerate-all on fork; `verifyAllSealed` hard gate; SEC-1 custody gate; the
  Vault non-decision carries over.
- **CI = build-is-the-check** + `checks` commands run inside the built image;
  statuses gate branch protection. No Actions dialect (trigger-deferred).
- **Policy = admission function calls** at the only write paths (pre-receive +
  deploy admission). Provenance = deployed digest must equal platform-built
  digest. A violation means the mutation never happened.
- **Crew = ai-sdk v7 direct-to-provider**; agents-as-directories versioned in
  git; **agent runs in containers** holding only a minted MCP token pinned to
  (owner, repo) + per-run deploy key — #16 boundary as a credential class, with
  a CI test asserting admin creds never appear in an agent environment.
- **Mitosis = two TS functions.** `seed()`: git bundles + `manifest.json`
  (**seedVersion**, createdFrom, refs, recipient), state history squashed,
  genesis excluded. `germinate()`: fresh key → restore → regenerate ALL secrets
  → rewrite identity → verifyAllSealed → ORIGIN lineage → boot. Seconds, not
  30–60 min; `Result.gen` sequence with typed failures.

### Data plane — "db and blob generalize to just data"

Every app gets one durable, quota'd, backed-up **data directory** (bind-mounted
volume): `app.db` (SQLite via the app's own driver — bun:sqlite in the template)

- `files/` (served via the platform's S3-subset API). No DSN, no shared DB
  server, no MinIO. The platform provides provisioning, snapshots, CoW clones,
  restore, backup. Adversarial-review verdict: **SQLite-first as the default
  primitive survives**, with three non-negotiable mitigations, all adopted:

1. **The S3-subset server stays** (deleting it saves ~days and loses the
   presigned-URL/SDK ecosystem contract — Uppy, direct browser upload, sharing).
   It stores into `files/` in the same data dir, so blobs are versioned with it.
2. **Snapshot protocol, not snapshot hope.** Platform opens `app.db` directly
   (same host, same filesystem — POSIX locks coordinate with the app), runs
   `wal_checkpoint(TRUNCATE)`, then CoW-clones the dir (APFS clonefile /
   `cp --reflink`; **fallback `VACUUM INTO` + copy on ext4**). Every backup is
   **restore-verified with `PRAGMA integrity_check` in CI** (Litestream's 2026
   restore-corruption issue is the cautionary tale).
3. **Postgres as a documented escape-hatch recipe, not a primitive** — an app
   that needs Postgres-class features runs it as part of its own deployment,
   with a recipe that wires `pg_dump` into the same platform backup pipeline.
   Advertised envelope, honest: SQLite tier ≤ ~10 GB, single writer, single
   replica; stateful apps deploy stop→start (a same-host overlap is
   SQLITE_BUSY-safe but not promised); external BI/`psql` access is not a
   feature of the SQLite tier.

What this buys: platform boots with zero containers; M1 drops the postgres pull
entirely; isolation gets _stronger and simpler_ (no shared DB server = no
network path between tenant data at all — the earlier multi-attach network fix
is moot); mitosis and per-PR data branches become file operations; backups are
file copies; the browser story keeps a real path (SQLite WASM is the most
battle-tested WASM DB). Prior art at this exact shape: val.town (SQLite per
val, fork copies the DB), Cloudflare D1/Durable Objects (SQLite per object).

**Versioned data — the Lore-inspired arc (staged, trigger-honest):**

- **M1:** snapshots (the protocol above) + `op data snapshot/restore`.
- **M2:** per-PR **data branches** — preview containers get a CoW clone of a
  quiesced snapshot of prod data (or seed data); scheduled backups off-host;
  restore drill in CI.
- **M3/M4:** `sqlite3session` changesets — SQLite's official diff/patch/3-way-
  merge for databases ("git diff for data"; the single highest-leverage
  discovery of the research). Changesets stored as git blobs beside source →
  time-travel restore + semantic data diffs on PRs. **Spike required:** the
  session extension is compile-time gated; verify bun:sqlite's build or load a
  custom-compiled libsqlite3 via `Database.setCustomSQLite()`.
- **M4+:** content-addressed, FastCDC-chunked store for `files/` (steal Lore's
  ideas — Merkle identity, chunking-per-content-type, branch-as-pointer — never
  the Rust dependency). Research found no prior art combining structured-data
  changesets + chunked blob dedup in one git-native scheme: genuinely novel
  territory, earned only after the boring parts work.

### Isolation truth (the client-security-review answer)

Three enforced planes: **(1) kernel/containers** — non-root, `cap-drop=ALL`,
`no-new-privileges`, mandatory limits (policy-enforced), per-app network, no
socket mounts, secrets injected in-memory at create; **(2) filesystem** — each
app's entire data plane is its own bind-mounted directory; there is no shared
database server, hence _no network path to another tenant's data at all_;
**(3) platform code** — SigV4 per-bucket creds on the S3 API, forward-auth on
every app host. Documented v1 trust boundary: shared kernel ("tenants
trusted-but-separated"); microVMs trigger-deferred. **Sovereignty rule (from
critic): shared-engine daughters are test-only** — production daughters get
their own engine/host; a daughter on the mother's docker socket could read the
mother's secrets.

## Milestones

**M1 — full loop, shallow (<60s CI).** The one test below green 3 consecutive
runs, in GitHub-Actions-class CI and on this Mac. Minimal-real versions of:
git+forge(PAT only), identity(sessions), state/reconcile, builder/engine, gate
(TLS, self-CA), secrets, data, mitosis. Default local domain `*.localtest.me`
(public DNS → 127.0.0.1: kills the /etc/hosts dance).

**M2 — identity + day-2 spine.** OIDC SSO consumed by template app (better-auth
client on bun:sqlite); PRs/reviews/webhooks/branch protection complete; both
admission points + policy rejection tests; blobs S3-subset incl. multipart +
conformance suite; **per-PR data branches**; backups off-host (WAL-ship,
appdata snapshots, repos/) + **destroy-and-restore drill in CI with
integrity_check**; app-owner day-2 surface (logs, restart, exec, usage); app
cron primitive (KEDA's replacement); ACME when a public domain is configured;
minimal console UI (card, use-this-template, app page); MCP surface v1 (mine
the 43-tool taxonomy from `~/projects/open-platform/apps/op-api`).

**M3 — crew + self-hosting.** Dispatcher/builder/reviewer/worker on `agent-work`
issues; validator browser-tests before ship; unattended issue→shipped-app E2E
nightly (reborn E1–E8); platform hosts its own monorepo and ships itself
(self-upgrade: release tag → build → snapshot → re-exec, apps unaffected);
germinate-as-test-fixture pattern; sqlite3session spike → changeset capture.

**M4 — world-facing + fleet.** Public-domain onboarding UX; seed-handoff
(`op seed --give`); lineage explorer; multi-node on standards (worker = engine
API over mTLS; gate routes cross-node; blobs re-pointable at R2/S3 — same wire
API); data-versioning deepens (changesets in PRs, CAS file store); browser demo
mode as a stretch.

## The M1 CI test (the product constraint, kept forever as a regression gate)

Setup (untimed): `bun install`; pre-pull `oven/bun:alpine`. **No database image
— the data plane is files.** Timed, with **per-phase budget assertions** (soft
total 60s, hard 90s; cold-cache lane soft-fails):

1. Boot mother at `plat.localtest.me` → card printed (~1.5s, zero containers)
2. API: create user + PAT (~0.3s)
3. Repo from `_app-template`; push zero-npm-dep Bun app, COPY-only Dockerfile
   (build variance removed structurally) (~1s)
4. Push event → reconcile: build (~2–6s warm) → admission → run with data-dir
   mount → route (~2s)
5. `fetch https://hello-<user>.plat.localtest.me` (platform CA) → 200, response
   proves a row round-tripped through `app.db` (bun:sqlite in-app) (~0.5s)
6. `op data snapshot` → checkpoint + clone + `integrity_check` passes (~1s)
7. `seed()` → tarball (~1s)
8. `germinate(seed, "d1.localtest.me", offset ports)` — test-only shared engine
   (~3s)
9. **Sovereignty asserts:** daughter key ≠ mother key; every daughter secret
   decrypts with daughter key; **mother key fails to decrypt (negative test)**;
   ORIGIN lineage recorded
10. Daughter repeats 2–5 (warm layer cache, ~8s)

Total ≈ 30–45s. Distill assertions from `mitosis/scripts/coldstart-assert.sh`
(A1–A7/E1–E8 inventory).

## Execution order (M1)

1. Scaffold monorepo (bun workspaces, tsconfig, lint/format hook parity,
   `bun test` + the timed e2e skeleton failing-first).
2. `core` + `store` + `secrets` (typage; invariant tests ported from threat model).
3. `git` (smart-HTTP against real git clients: clone/push/fetch/shallow/force
   conformance matrix from day one) + `forge` minimal (users/PATs/repos/templates).
4. `engine` + `builder` + `data` (provision/snapshot/verify) + `reconcile`
   minimal + `policy` skeleton (fail-closed from the first deploy).
5. `gate` (SNI, self-CA via `@peculiar/x509`, forward-auth middleware).
6. `mitosis` (`seed`/`germinate`, ported semantics from `bin/germinate` +
   `bin/lib.sh`: regen inventory, verify gate, custody ack, ORIGIN).
7. Genesis content: embedded `_app-template` (zero-dep Bun server + bun:sqlite
   on DATA_DIR + Dockerfile), `sys/gitops` skeleton. Wire the full M1 test
   green; tune budgets.

## Risks (top 5)

1. **Own-git auth bugs** (push bypass) — wire delegated to git binary;
   fail-closed auth; conformance + protection suite in CI from M1.
2. **Snapshot/restore integrity** (the data plane IS files now) — checkpoint
   protocol + CoW-or-VACUUM-INTO fallback; every backup restore-verified with
   `integrity_check` in CI; fsync discipline; Litestream's restore-corruption
   record is the standing warning.
3. **Docker-socket hard dependency** — Engine API served compatibly by
   Docker/OrbStack/Colima/Podman-compat; thin client (~1k LOC); loud failures.
4. **Hand-rolled security surfaces** (OIDC/SigV4/sessions) — token crypto via
   `jose`; PKCE-only; AWS-SDK conformance client; security review gate before
   M2 exit.
5. **SQLite envelope misfit for a future client** (multi-writer, 20GB
   analytics, BI endpoint) — honest advertised envelope; Postgres escape-hatch
   recipe wired into platform backups; managed-PG primitive only on a real
   client contract (trigger).

## Not building (trigger-gated, Vault-style)

Managed Postgres primitive (→ client contract; recipe until then) · registry
(→ multi-node/external pulls) · Actions-compatible CI (→ real demand) ·
microVMs/BoxLite (→ hostile-tenant requirement) · Vault/escrow (never — SPOF is
the design) · k8s/Flux/Helm (never) · adapters (never) · libSQL fork dependency
(never for now — stock SQLite + bun:sqlite) · Lore/eve/deepsec as dependencies
(steal ideas; deepsec viable later as async PR audit) · Mailpit/Zulip/Jitsi-
class services (they're just apps).

## Verification

- **M1:** the timed e2e above IS the verification; plus unit suites per package
  (git conformance matrix, sovereignty negative tests, policy rejection tests,
  snapshot integrity tests, S3 conformance via AWS SDK). `bun test` +
  `tsc --noEmit` + lint clean.
- **Continuous:** per-phase wall-clock budgets keep the 60s promise honest;
  restore drills with integrity_check; #16 test greps agent env for admin
  creds; dep-count lockfile assertion.
- **On this Mac:** `op up` → card → browser → template → app at
  `https://<app>-<user>.plat.localtest.me` → `op data snapshot` →
  `op seed` → `op germinate` → daughter card. Same motions as today's
  platform, minutes → seconds.

## Reference files

- `~/projects/mitosis/bin/germinate` + `bin/lib.sh` — semantics to port
  (regen inventory, verify gate, custody, protect-workflows)
- `~/projects/mitosis/docs/security/secrets-threat-model.md` — invariant,
  verbatim (DB-credential sections superseded by the data-dir model)
- `~/projects/mitosis/docs/design/forgejo-identity-to-postgres-rbac.md` —
  explicitly superseded: its own recommendation was already app-code authz
  (Option 1), which the SQLite model keeps
- `~/projects/mitosis/scripts/coldstart-assert.sh` — assertion inventory
- `~/projects/open-platform/apps/op-api` — prior TS art: tool taxonomy, REST+MCP
- Research + design + data-plane dossiers in this session's scratchpad
  (paths in Context)
