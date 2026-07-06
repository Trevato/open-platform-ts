

══════════ ? ══════════
# open-platform-ts — Design Document

## A. Process & package architecture

**One process.** The platform is a single Bun process, `opd`, plus the app containers it manages. Forgejo, Flux, Traefik, cert-manager, Kyverno, KEDA, MinIO, CNPG, coredns-custom — all nine k8s components collapse into modules of one daemon. "Forest" = small sharp packages in one Bun workspace composing into one runtime, not processes.

**Substrate contract (total): `bun`, `docker`, `git`.** Nothing else installed, ever.

**State model.** Canonical desired state lives in git — a `platform/state` repo hosted by our own git server (primitive #2, finally: desired state lives *inside* the system that reconciles it). Runtime index is `bun:sqlite` (zero-dep, built into Bun), always rebuildable from git — sqlite is never canonical, so the sqlite→postgres handoff class of pain is dead permanently: there is no migration because there is nothing to migrate. Secrets in the state repo are age-sealed to the sovereign key (threat-model invariant verbatim: sealed to exactly one recipient, no escrow, no second recipient, no parent copy; lose-the-key SPOF is the deliberate cost).

**Packages** (workspace `packages/*`, LOC budgets are ceilings; total core ~9.5k LOC):

| package | responsibility | LOC |
|---|---|---|
| `op-git` | smart-HTTP git hosting: auth, spawn `git upload-pack/receive-pack --stateless-rpc`, post-receive events, repo CRUD, template repos, branch protection, PR/issue records | 1400 |
| `op-identity` | users/orgs/teams, PATs, sessions, minimal OIDC provider (code+PKCE, client_credentials, JWKS, discovery) on `jose` | 900 |
| `op-state` | desired-state types, admission (policy) gate, commit-to-state-repo API, status write-back | 600 |
| `op-reconcile` | the loop: state repo → diff vs `docker ps`/sqlite → converge (build, run, db, route, checks) | 700 |
| `op-build` | Dockerfile→image via `docker build --load`; image ID recorded in status | 350 |
| `op-run` | container lifecycle via docker CLI (`run/stop/rm/inspect`), restart policy, resource limits, per-app network | 500 |
| `op-router` | `Bun.serve` on 80/443: SNI TLS, host→container routing, inline forwardAuth (session→git-permission→`X-Plat-*` injection), default-ON | 700 |
| `op-ca` | mint platform CA + one wildcard cert at germination (`@peculiar/x509`) | 250 |
| `op-secrets` | age sealing via `typage`; seal/unseal/regen-all/verify-all-sealed | 400 |
| `op-data` | shared Postgres container; database+role per app; `pg_dump` backups to blobs (client: built-in `Bun.sql`) | 500 |
| `op-blobs` | S3-subset server over fs: SigV4, GET/PUT/DELETE/HEAD/ListObjectsV2, presigned URLs; bucket+scoped-key per app | 650 |
| `op-checks` | CI = reconciler running checks: on push, run repo's `op.yaml` check commands in a container of the built image; commit statuses; gate release | 450 |
| `op-policy` | TS validator policies executed at the single admission point, fail-closed, ENFORCED (no audit mode exists) | 300 |
| `op-mcp` | MCP + REST surface; every mutation authorized against git permissions; mints scoped ephemeral agent tokens (#16) | 1500 |
| `op-crew` | dispatcher + builder/reviewer/worker agents on `ai` (ai-sdk v7); agents-as-directories (`instructions.md` + `tools/`) versioned in git; eve-inspired, no eve dependency | 1200 |
| `op-mitosis` | `seed()` and `germinate()` as TS functions | 500 |
| `op-cli` / `opd` | entrypoints; `bunx open-platform up` | 300 |

**Runtime dependencies (counted, total 7):** `better-result` (errors-as-values at I/O boundaries only, `Result.gen` for germinate orchestration), `typage`, `jose`, `@peculiar/x509`, `ai` + `zod`, `@modelcontextprotocol/sdk`. Everything else is Bun built-ins (serve/TLS, sqlite, `Bun.sql` Postgres client, spawn, S3 client for tests).

**Boot sequence** (fresh dir → serving in ~2s): open sqlite index → if empty data dir: mint sovereign age key, CA + wildcard cert, admin user, init state repo from genesis → start router listener → start reconciler → start Postgres container lazily on first DB claim. No phases, no waits, no handoff. Crash-only: apps keep running under `--restart=always` while `opd` restarts; index rebuilds from git.

## B. Per-subsystem decisions

**Git server — wrap the system git binary. Firm position.** Every real forge shells to git for pack negotiation; isomorphic-git's server is WIP and reimplementing the pack protocol is exactly the speculative cleverness to avoid. Smart HTTP is ~200 LOC: route `/:owner/:repo/info/refs?service=…` and the two RPC endpoints, auth in front, stream request body into `Bun.spawn(["git","upload-pack","--stateless-rpc",…])`. Reads (file browse, diffs) via `git cat-file --batch` / `git log --format`. No isomorphic-git anywhere — zero git deps beyond the binary.

**Identity/OIDC — hand-rolled minimal provider on `jose`.** better-auth's OIDC plugin is mid-deprecation churn; panva's `oidc-provider` is large and Node/Koa-shaped. The subset we need (code+PKCE for apps, client_credentials for services, JWKS, discovery) is small, and OIDC is the standard that makes daughter apps portable. Apps in the template consume it with better-auth's *client* side — their dependency, not ours.

**Platform DB — `bun:sqlite` index over git-canonical state.** See §A. Postgres is for tenants, not for the control plane.

**Build — `docker build --load`.** The container engine is already the run substrate; its builder (BuildKit) is the boring standard with a layer cache we get for free. **No registry**: on single node the engine's image store *is* the registry; the build step's output is an image ID in status. This deletes the registry-mirror-at-cluster-creation hack, the public-ci-builder-image 401 dance, and MANIFEST_UNKNOWN Flux races wholesale.

**Run — Docker Engine, one answer.** Not BoxLite (pre-1.0, native addons, no Dockerfile build anyway), not k8s (clean room), not Podman-as-alternative (that's an adapter by the back door — we document Docker Engine; Podman happening to work is unsupported luck). Reconciler owns convergence: desired (git) vs actual (`docker ps`), labels carry ownership.

**Routing/TLS — the reverse proxy is `Bun.serve`.** SNI with one wildcard cert per platform minted at germination from the platform CA. forwardAuth is an inline function, not a network hop: strip client `X-Plat-*`, resolve session, probe git permission, inject headers, and it is **on by default** — killing the default-off pain. ACME is deferred (§F).

**Per-app Postgres — one shared `postgres:alpine` container, database+role per app. Firm position against PGlite for tenant data**: apps are separate containers that need the wire protocol; PGlite is in-process/single-connection and its socket-server story is experimental — using it here is cleverness against the standard. PGlite *is* used in unit tests where an ephemeral PG is wanted in-process. Isolation = per-app role owning only its database, no CREATEDB/SUPERUSER, `pg_hba` scoped. `query_db` MCP tool connects as the app role, read-only txn.

**Blobs — build the S3 subset over fs (~650 LOC). Position.** The standard is the S3 API (owner's principle: portability from standards). MinIO is a second 100MB daemon with its own secret domain; files-sdk is a *client* whose fs adapter is documented dev-only. The subset real apps use (put/get/delete/head/list-v2/presign, SigV4) is small and testable against the official AWS SDK as conformance client.

**Secrets — `typage`** (age in TS, by age's author). `regenSecrets()` regenerates every secret value fresh; `verifyAllSealed()` is a hard gate (each secret decrypts with the sovereign key AND lists exactly one recipient). The negative test — parent key fails to decrypt daughter secrets — ships in M1's CI.

**CI/checks — CI is the reconciler running checks.** No Actions YAML dialect, no runner fleet, no KEDA, no dind. Push → post-receive event → reconciler builds the image, runs `op.yaml`-declared check commands inside a container of that image, posts commit statuses, gates merge/release on them. Builds run on the host engine with a warm shared cache — the 15–25min serial in-cluster build sink becomes seconds.

**Policy — enforced at the only write path.** All mutations (MCP, REST, git push to state repo via hook) pass through `op-state` admission, where TS validator policies run fail-closed. Because `op-run` only runs what the reconciler admits and `op-router` only routes what's in state, enforcement is structural. There is no audit mode. Kyverno's generate-policies become reconciler defaults (every app gets its own docker network, limits, quota) — self-healing because the reconciler converges continuously.

**AI crew — ai-sdk v7 `ToolLoopAgent` + platform MCP tools.** Agents are directories (`instructions.md`, `tools/`, optional `schedule`) in a git repo — eve's shape without eve (3-week-old Vercel-coupled beta). The dispatcher is just another reconciler concern: an issue labeled `agent-work` is desired state, the run record is status. Credential boundary #16 preserved exactly: dispatcher holds admin PAT; each run gets a minted MCP token pinned to `(owner,repo)` with a tool whitelist plus a per-run deploy key; admin creds never enter the agent process env — asserted by test.

**Mitosis — two TS functions.** `seed(platform) → seed.tar.gz`: git bundles of system repos + apps + `manifest.yaml` (createdFrom, refs, sovereign recipient), state repo squashed to orphan commit, genesis excluded (no nesting). `germinate(seed, {domain, dataDir, ports})`: unpack bundles → mint fresh typage key → regenerate ALL secrets → rewrite identity/domain → `verifyAllSealed` gate → mint CA/cert/admin → boot daughter `opd` → append lineage (daughter ORIGIN + parent ledger). The 790-line bash monolith existed to negotiate with Forgejo/Flux/CNPG/registries; with no substrate to fight, germinate is ~300 LOC of `Result.gen` and completes in seconds. One-shot, no resume machinery — cheap enough to just rerun.

## C. Milestone-1 CI test

One `bun test` e2e on `ubuntu-latest` (Docker preinstalled). Setup step (outside the timed window, cached): `bun install`, pre-pull `oven/bun:alpine` + `postgres:17-alpine`, warm hello-app layer cache. Timed sequence with budget:

1. `boot(motherDir, "plat.localtest.me")` — key+CA+admin+state repo+listen. **~1.5s**
2. API: create user `ada`, PAT. **~0.2s**
3. Create repo from `_app-template`; git-push a hello app (Bun.serve + one `Bun.sql` query; 8-line Dockerfile) over smart HTTP. **~1s**
4. Reconciler: `docker build` (warm base → **~6s**), first-DB-claim boots Postgres container (**~3s**) + `CREATE DATABASE/ROLE` (**~0.2s**), `docker run` (**~1s**), route live.
5. `fetch https://hello-ada.plat.localtest.me` via router with test CA trust → 200; response proves a row round-tripped through per-app Postgres. **~0.5s**
6. `seed(mother)` → tarball. **~1s**
7. `germinate(seed, "d1.localtest.me", offset ports)` → daughter up. Assert: daughter key ≠ mother key; every daughter secret decrypts with daughter key only; **mother key fails to decrypt** (negative test); lineage line present. **~3s**
8. Daughter runs the same checks (create user, push same app — build hits the *shared host layer cache* → **~4s** — URL 200, DB works). **~10s**

Total ≈ **32–38s**, ~40% headroom. What makes <60s achievable: no cluster, no platform images to build or pull (opd *is* the platform), no registry hop, shared Docker layer cache across mother/daughter, sqlite, lazy Postgres. Threats: cold BuildKit cache (mitigate: CI cache mount + tiny base), Docker daemon flake (retry once, fail loud), budget erosion (the test asserts its own wall-clock budget — a perf regression is a red build), Postgres cold start (pre-pull; consider `--shm-size` tuning).

## D. Milestones

- **M1 — Full loop, shallow.** §C green in GitHub Actions and on a Mac laptop. Exit: <60s CI run, 7-day green streak; `op-git`+`op-identity`(PAT only)+`op-state/reconcile`+`op-build/run`+`op-router`(TLS)+`op-secrets`+`op-data`(PG)+`op-mitosis` minimally real.
- **M2 — Identity, tenancy, policy deep.** OIDC provider consumed by template app (SSO login works); orgs/teams; PRs + reviews + branch protection + webhooks; forwardAuth default-on with 4-tier decide; policy set v1 enforced (rejection test in CI); blobs S3-subset + nightly pg_dump backups. Exit: template app full lifecycle incl. SSO; a policy-violating deploy is *rejected*, not audited.
- **M3 — Crew + mediated API.** ~20 MCP tools; scoped agent tokens; #16 boundary test (grep agent env for admin creds fails the build); dispatcher builder→reviewer→auto-merge→release on `agent-work` issues; validator browser-tests before ship. Exit: unattended issue→shipped-app E2E (the old E1–E8) green nightly.
- **M4 — Operability + fleet.** Console UI (mine prior console); `bunx open-platform up`; nightly reseed→germination gate (reseed.yml reborn as a crew schedule); key rotation; backup/restore drill; ACME if a public domain is configured. Exit: stranger installs in <5 min; week of green nightly reseed+coldstart.

## E. Risk register

1. **Smart-HTTP edge cases** (protocol v2, shallow clones, auth on both RPCs). *Mitigation:* `--stateless-rpc` keeps the protocol in git's code, not ours; CI conformance matrix with real git clients (clone/fetch/push/shallow/force).
2. **Docker as hard dependency** (rootless quirks, mac perf, CI availability). *Mitigation:* CLI surface kept to ~6 subcommands; Docker Engine documented as the substrate; fail loud with actionable message; laptop path validated every M1 run.
3. **Hand-rolled security surfaces (OIDC, SigV4, sessions).** *Mitigation:* all token crypto via `jose`; PKCE-only public clients, no implicit flow; S3 auth verified against official AWS SDK as conformance client; dedicated security review gate before M2 exit; typage from age's author.
4. **Single-process blast radius.** *Mitigation:* crash-only design — apps survive opd restarts (`--restart=always`), sqlite index rebuilds from git, systemd/launchd supervises; status endpoint distinguishes "router down" from "apps down".
5. **<60s budget erosion / minimalism decay.** *Mitigation:* wall-clock assertion inside the M1 test; dependency count (7) asserted in CI from lockfile; new runtime dep requires a written trigger justification (this document's §F pattern).

## F. Explicitly not building (with triggers)

- **Container registry** — image store is the registry on single node. *Trigger:* multi-node, or external consumers pulling platform images.
- **Multi-node scheduling / HA** — *Trigger:* a single host saturates; first answer considered will be "germinate a sibling," not "build a scheduler."
- **ACME/Let's Encrypt** — wildcard self-CA until *trigger:* first public-domain onboarding (M4; small HTTP-01 client, not a cert-manager).
- **Vault / escrow / HSM** — the non-decision carries over verbatim; SPOF-by-design is the price of sovereignty. *Trigger:* none anticipated; key *rotation* (value-preserving) ships M4 instead.
- **Actions-compatible CI dialect / runner fleet** — `op.yaml` checks only. *Trigger:* real users blocked by lack of matrix/workflow expressiveness.
- **Kubernetes anything, adapter interfaces, isomorphic-git, eve/BoxLite deps** — by decree or by immaturity. *Trigger for a microVM runtime:* hostile-multi-tenant requirement (untrusted strangers' code), where container isolation is insufficient.
- **Email/chat/video services (Mailpit/Zulip/Jitsi class), observability stack** — structured logs + `/statusz`. *Trigger:* operational blindness demonstrated by a real incident.
- **Git LFS, federation, PGlite-for-tenants.** *Triggers:* large-binary repos in practice; cross-platform identity demand; never (respectively — wire protocol is the standard).

### Critical Files for Implementation
- /Users/trevato/projects/mitosis/bin/germinate — the exact sovereignty/regen/verify sequence `op-mitosis` must reproduce in TS
- /Users/trevato/projects/mitosis/bin/lib.sh — fork_regen_secrets/fork_verify_all_sealed/protect_workflows semantics to port
- /Users/trevato/projects/mitosis/docs/security/secrets-threat-model.md — the invariant carried over verbatim into `op-secrets`
- /Users/trevato/projects/mitosis/scripts/coldstart-assert.sh — assertion catalog to distill into the M1 test
- /Users/trevato/projects/open-platform/apps/op-api — prior TS art for `op-mcp` tool surface and auth patterns


══════════ ? ══════════
# open-platform-ts — Design Document

Center of gravity: **germinate-in-seconds**. Every architectural choice below is judged by whether it keeps a full sovereign platform bootable from cold in low single-digit seconds, because that property is the product: instant YOUR PLATFORM card, seed-to-friend sovereignty, per-PR ephemeral platforms, platform-as-test-fixture, and a CI loop that proves all of it in under a minute.

## A. Process & package architecture

**One process.** `platd` — a single Bun daemon that IS the git host, identity provider, API/MCP server, ingress router, reconciler, CI runner, and policy gate. Apps run as containers beside it; a shared Postgres container and the AI crew's agent containers are the only other processes. This is the forest approach done right for TS: many small sharp packages, one runtime. It kills three pains by construction: no Flux races (reconciler and git host share a process — a push IS an event), no forwardAuth protocol (the SSO gate is router middleware), no admission bypass (every mutation flows through the daemon; policy is enforced or the mutation doesn't happen).

**State layout.** `~/.plat/<domain>/`: `key.age` (sovereign key), `repos/` (bare git), `db/` (PGlite), `blobs/`, `ca/`, `ORIGIN`. Desired state lives in git — a `plat/state` repo holding per-app records (image ref, env, hosts, db/bucket flags, age-sealed secrets) plus platform policy data. The reconciler watches HEAD of its own hosted repo and writes status back as commits. Control-plane metadata that isn't desired state (sessions, users, PATs, webhook deliveries, check runs) lives in embedded PGlite.

**Boot sequence** (target <2s to card): open PGlite (~150ms) → ensure sovereign key (typage mint if absent) → ensure CA + wildcard leaf → init system repos from embedded templates (first boot only) → start HTTPS listener + reconciler → async: ensure shared Postgres container → print YOUR PLATFORM card.

**Packages** (one monorepo, `packages/*`, composing into `platd` + `plat` CLI; better-result at every I/O boundary; ~25k LOC total):

| Package | Responsibility | LOC |
|---|---|---|
| plat-core | TaggedError types, config, ids, logging | 800 |
| plat-git | bare-repo store, smart-HTTP endpoint, hooks→events, isomorphic-git ops, bundles | 2,500 |
| plat-identity | users/orgs/teams, sessions, PATs, OIDC provider, permission resolution | 2,500 |
| plat-db | PGlite + drizzle schema/migrations | 800 |
| plat-state | desired-state schema (zod), state-repo read/write, status writeback | 1,200 |
| plat-reconcile | converge loop: diff desired vs live (containers, DBs, buckets, hosts) | 1,500 |
| plat-runtime | thin Docker Engine API client (build/run/logs/events over unix socket) | 1,500 |
| plat-router | HTTPS ingress, SNI, host table, SSO-gate middleware, cert minting (@peculiar/x509) | 1,500 |
| plat-pg | shared Postgres container, per-app db/role, pg_dump→blobs backup | 800 |
| plat-blob | S3-subset server over fs (SigV4 verify, presign, ListObjectsV2) | 1,500 |
| plat-secrets | typage sealing, regenerate-on-fork, verify-all-sealed gate | 700 |
| plat-policy | admission checks, enforced at the service layer | 600 |
| plat-ci | build-as-check, checks API, branch protection gate | 800 |
| plat-api | REST + MCP surface, `authorize()` against git permissions | 2,500 |
| plat-crew | dispatcher, agents-as-directories, scoped-cred minting, browser validator | 2,000 |
| plat-mitosis | seed()/germinate()/lineage, ORIGIN | 1,000 |
| plat-console | web UI (M2) | 3,000 |
| plat-cli | `plat up/seed/germinate/status` | 600 |

**Browser-pure discipline** (not adapters — a layering rule): plat-core, plat-state, plat-secrets (typage is WebCrypto), plat-policy, plat-mitosis's manifest/verify logic, plat-identity's permission resolver, and plat-git's isomorphic-git ops layer must import only web-standard APIs (isomorphic-git's injected-fs design and PGlite's WASM build make this free). Node-only surface (`child_process`, unix sockets, `Bun.serve` TLS) is confined to plat-git's serve module, plat-runtime, plat-pg, plat-router. This keeps a demo mode (isomorphic-git client + PGlite WASM, mock runtime) reachable without a single interface indirection.

## B. Per-subsystem decisions

**Git server — hybrid, and firmly so.** Storage is plain bare repos (the git object format is the standard). The smart-HTTP endpoint authenticates/authorizes in TS, then spawns system `git upload-pack`/`git receive-pack` for the pack layer — exactly what Gitea/GitLab do, because pack negotiation is the highest-risk lowest-reward code in the stack and isomorphic-git's server story is explicitly WIP. All *programmatic* manipulation — template instantiation, platform commits, status writeback, seed bundles, PR merge-base/diff — uses isomorphic-git, keeping those paths pure TS and browser-portable. The seam is the git wire protocol itself, not a `GitHost` interface. The system git binary is a substrate tool like openssl, not a third party.

**Identity/OIDC.** better-auth for users/sessions/password + its OIDC-provider plugin so every hosted app gets "Sign in with your platform" (the app template already consumes better-auth as a client — symmetric). PATs and the org/team/repo permission model are own tables and own code (~small); permission resolution is THE authority that `authorize()`, the router SSO gate, and the crew's scoped tokens all consult. Risk: plugin deprecation churn → pin; fallback is panva oidc-provider behind the same service module.

**Platform DB — PGlite.** In-process, file-backed, real Postgres SQL, ~150ms open, runs in the browser. The control plane must boot before any container exists; PGlite makes the daemon self-sufficient. Its immaturity is acceptable because desired state is in git (recoverable) and PGlite holds only indexes/sessions/metadata, snapshotted nightly to blobs.

**Per-app Postgres — one shared real Postgres container, not PGlite.** Apps need arbitrary client libraries over the wire, multiple connections, and durability; PGlite is single-connection embedded by design. One `postgres:alpine` container per platform, one database + owner role per app, wire-standard DSN injected. The standard is the Postgres wire protocol — apps can't tell and don't care. `query_db` tooling connects as the app role, read-only txn. Backups: pg_dump per database → blob store, nightly.

**Build.** `plat-runtime` speaks the Docker Engine API directly over the local socket (Bun fetch over unix socket; the API is a de-facto standard served identically by Docker Desktop, OrbStack, Colima, and Podman's compat socket — one client, no dockerode). Build = BuildKit via the engine; images built locally are run locally, so **there is no registry in M1** — this deletes the in-cluster serial-build and registry-mirror pain entirely.

**Run — containers on the local Docker Engine, one answer.** Not k8s, not microVMs. The reconciler creates/replaces containers with resource limits, restart policy, healthcheck, and a labeled ownership scheme; containers survive daemon restarts. BoxLite is watched, not adopted (pre-1.0, no builder, KVM requirements complicate "stranger runs one command on a laptop").

**Routing/TLS.** The daemon is the ingress: one `Bun.serve` on 80/443, SNI cert map, host-header routing to container ports. Local CA + per-host leaves minted in TS via @peculiar/x509 (WebCrypto — browser-pure). SSO gate is middleware: session cookie → git permission on the app's repo → allow/302/403 + `X-Plat-User/Perm` header injection. ACME comes in M4.

**Blobs — build the S3 subset over fs.** ~1,500 LOC: SigV4 verification, PUT/GET/HEAD/DELETE, ListObjectsV2, presigned URLs, per-app bucket + scoped key. The S3 API is the standard; MinIO is a heavy AGPL container that dominates boot time and seed complexity; files-sdk is an adapter library whose fs backend is dev-only. Apps use any stock S3 SDK against it.

**Secrets — typage.** The sovereignty invariant carries over verbatim: every sealed value in the state repo is age-encrypted to exactly one recipient — the sovereign key minted at germination; no escrow, no second recipient, no parent copy; lose the key, lose the platform, by design. `sealAll`/`regenerateAll`/`verifyAllSealed` are TS functions; verify-all-sealed remains a hard germination gate. SOPS itself is not carried (clean room); the format is a trivial `{name: ageArmor}` map — the invariant, not the tool, is what survives.

**CI/checks.** No workflow DSL. M1: the Dockerfile build + healthcheck probe IS the check ("deployable" is the status). M2 adds `plat.yaml → checks: [cmd]` run inside the built image, results via a checks API consumed by branch protection. Trigger to revisit: users needing matrix/multi-job pipelines.

**Policy — enforced at the service layer.** Because there is no kubectl backdoor, admission is a function call: every mutation passes plat-policy (image provenance/source rules, resource limits, host-claim registration, secret-governance, workflow-file protection) and is **denied** on violation. Policy data lives in the state repo; evaluation is pure TS (browser-pure package). Kyverno's audit-only embarrassment is structurally impossible here.

**AI crew.** ai-sdk (direct provider, never AI Gateway) for model calls; eve-inspired **agents-as-directories** in a `plat/crew` repo (`instructions.md`, `tools/*.ts`, zod schemas) — versioned, forkable, seed-carried. Dispatcher subscribes to in-process git events (push/PR/issue-label `agent-work`); builder/reviewer/worker run as containers holding only **run-scoped ephemeral credentials**: a minted MCP token pinned to one (owner, repo) with a tool allowlist checked before any admin path, plus a per-run deploy key — the #16 boundary: admin credentials never enter an agent run. Validator drives the preview URL with Playwright before ship.

**Mitosis — TS functions, seconds not minutes.** `seed()`: bundle system repos (squash state/mitosis history to orphan), write `manifest.json` (createdFrom, refs, recipient) → one tarball, no key inside. `germinate(seed, domain)`: fresh statedir → typage-mint sovereign key → restore bundles → regenerate ALL secret values → rewrite identity → verifyAllSealed gate → append ORIGIN lineage (also committed into the daughter's state repo) → boot `platd`. The 790-line bash negotiation with the substrate becomes ~300 lines of TS calling the platform's own modules, because there's no cluster, no two-phase sqlite→postgres handoff (PGlite is ready instantly; the shared PG container is just another reconciled resource), and no image rebuilds (the daughter builds lazily, warm from the host layer cache — host-local cache, no sovereignty leak). Germination cost ≈ key mint + bundle restore + reseal ≈ 2–3s. **This unlocks**: ephemeral platform per CI run, per-PR platform previews, platform-as-test-fixture (`const p = await germinate(seed)` in a test), and casual seed-handoff.

## C. Milestone-1 CI test

One Bun test on ubuntu-latest, docker preinstalled; setup step (untimed) pre-pulls `oven/bun:alpine` + `postgres:alpine`. Timed sequence:

1. `plat up --domain a.localtest.me` → assert card printed — **~2s** (PGlite open, key, CA, repos, listener; PG container starting async).
2. API: create user + PAT — **0.3s**.
3. `create_app hello` from `_app-template` (single-file Bun server, zero npm deps, Dockerfile FROM the pre-pulled base) — **0.5s**.
4. Push a commit over smart HTTP — **1s**.
5. Reconciler builds (cold layers: **~15s**; the long pole) + runs container; router registers host — **2s**.
6. `curl -k https://hello-user.a.localtest.me` → 200 — **0.5s**.
7. App writes/reads a row via its injected DSN (PG container ready by now) — **0.5s**.
8. `seed()` → tarball — **1.5s**.
9. `germinate(seed, b.localtest.me)` on ephemeral ports → card — **3s**.
10. Daughter: same user/app/push/build (warm layer cache **~6s**)/URL/DB checks; assert daughter key ≠ parent key, parent-sealed values undecryptable by daughter, ORIGIN row present — **~10s**.

Total ≈ **40–45s**. What makes it achievable: no cluster, no registry, no image pulls in the timed path, zero-dependency template (no `bun install` in the build), PGlite-instant control plane, single-process event flow (push→reconcile has no polling gap). Threats: BuildKit cold-start variance (mitigate: budget assertions per phase, template kept dependency-free), CI runner disk I/O (mitigate: tmpfs statedir), PG container pull on cache miss (mitigate: fail setup, not the test).

## D. Milestones

- **M1 — Full loop, shallow.** Everything in §C. Exit: the CI test green <60s, three consecutive runs.
- **M2 — Product surface.** Console UI (card, use-this-template, app pages, ORIGIN tree stub), OIDC sign-in for apps, blob server + backups, checks API + branch protection, full MCP tool surface (mine op-api's 43-tool taxonomy), PR preview containers, enforced policy set. Exit: a human goes zero→shipped SSO+PG+S3 app entirely in the browser.
- **M3 — Crew + self-hosting.** Dispatcher/builder/reviewer/validator with scoped creds; `agent-work` issue → merged, browser-validated PR; the platform hosts its own monorepo and ships itself; its CI germinates an ephemeral platform per run (fixture pattern proven). Exit: one sentence in an issue becomes a shipped app; platform repo's own CI runs on the platform.
- **M4 — World-facing.** ACME/public domains, seed-handoff UX (`plat seed --give`), lineage explorer, browser demo mode (isomorphic-git + PGlite, mock runtime). Exit: stranger on a VPS gets public HTTPS with one command; friend's daughter sovereign in <60s; demo runs in a tab.

## E. Risk register

1. **Docker-socket dependency** — the one heavy external. Mitigation: Engine API is served compatibly by Docker/OrbStack/Colima/Podman; client kept thin (~1.5k LOC) so a future BoxLite pivot is contained; documented as the single prerequisite.
2. **Smart-HTTP correctness/auth edges** (shallow clones, big pushes, credential handling). Mitigation: system git does the pack layer; CI conformance matrix against real `git` clients from day one.
3. **<60s budget erosion** as features accrete. Mitigation: per-phase timing assertions in the M1 test kept as a permanent regression gate; template stays zero-dependency.
4. **better-auth OIDC plugin churn / young deps** (typage, PGlite, better-result). Mitigation: pin everything; each sits behind one owning package (module boundary, not adapter); named fallbacks: panva oidc-provider, age CLI spawn, neverthrow.
5. **Single-process blast radius.** Daemon crash ≠ app outage (containers persist), but git/routing die together. Mitigation: <2s stateless restart, reconciler resumes from git, `plat up` installs a systemd/launchd supervisor; revisit process split only if a real availability incident demands it.

## F. Explicitly not building (with triggers)

- **OCI registry** — no registry until multi-node or external image pulls exist. Trigger: second host, or users pushing images from outside.
- **Multi-node scheduling / k8s anything** — trigger: a single host saturates for a real deployment.
- **Vault/escrow** — the non-decision carries over verbatim; sovereignty pays with the SPOF. Trigger: none foreseen; rotation + custody docs instead.
- **CI workflow DSL** (Actions compatibility) — trigger: sustained user demand for matrix/multi-stage pipelines.
- **Adapter layers of any kind** — permanent.
- **Comms suite** (Mailpit/Zulip/Jitsi from prior art) — never core; they're just apps a platform can host.
- **Git LFS, web git UI beyond files/diff/PR essentials, ElectricSQL sync, deepsec-style agentic scanning** — triggers respectively: large-asset apps, UI demand, live browser-sync demo need, post-M3 security budget.

### Critical Files for Implementation
- /Users/trevato/projects/mitosis/bin/germinate — the semantics (phases, gates, sovereignty checks) being reimplemented as `plat-mitosis` TS functions
- /Users/trevato/projects/mitosis/docs/security/secrets-threat-model.md — the invariant carried verbatim into plat-secrets
- /Users/trevato/projects/mitosis/bin/seed — seed contents/manifest contract for `seed()`
- /Users/trevato/projects/open-platform/apps/op-api — the 43-tool MCP/REST taxonomy to mine for plat-api
- /Users/trevato/projects/mitosis/scripts/coldstart-assert.sh — assertion inventory to distill into the M1 CI test


══════════ ? ══════════
# open-platform-ts — Design Document

Center of gravity: day-2 production honesty. One process, one host, real client workloads, standards as the portability layer. All I/O boundaries return `Result` (better-result, boundary-only — it is 6 months old; pure logic stays plain).

## A. Process & package architecture

**One runtime process, `opd`**, compiled to a single binary (`bun build --compile`), supervising in-process subsystems plus containers it manages via the host's container engine. The CLI `op` talks to it over HTTP. "Forest approach" = one Bun monorepo of small sharp packages composing into that one binary — not microservices.

| package | responsibility | LOC |
|---|---|---|
| `core` | typed errors (TaggedError unions), config, structured log | 800 |
| `store` | bun:sqlite (WAL) schema + typed queries; migrations | 1,200 |
| `git` | bare-repo store, smart-HTTP endpoints, hook bridge, ref/tree reads | 2,000 |
| `forge` | users/orgs/teams, repos, PRs/issues, webhooks (HMAC), PATs, templates, branch protection | 3,000 |
| `identity` | OIDC provider (jose): discovery, code+PKCE, JWKS; sessions | 1,500 |
| `secrets` | typage (age) sealing; sovereign key custody; regen-on-fork | 600 |
| `engine` | Docker Engine API client (raw fetch over unix socket): build/create/start/inspect/logs | 1,000 |
| `builder` | Dockerfile→image orchestration, digest pinning, image GC | 600 |
| `pg` | shared Postgres container lifecycle; per-app DB/role provisioning; dumps | 700 |
| `blobs` | S3-subset server over fs (SigV4, presign, multipart, ListObjectsV2) | 1,200 |
| `gate` | reverse proxy, host resolution, SNI TLS, ACME (RFC 8555), SSO forward-auth middleware | 1,500 |
| `reconcile` | desired-state parse/diff/converge; status writeback to git notes | 1,500 |
| `policy` | synchronous admission at git-receive and deploy | 700 |
| `mcp` | mediated tool surface; git-permission authz; scoped ephemeral agent tokens | 1,500 |
| `crew` | dispatcher; agents-as-directories runner (ai-sdk); validator | 1,500 |
| `mitosis` | seed()/germinate()/lineage | 900 |
| `opd`/`op` | composition root, boot, supervision / CLI | 1,100 |

~21k LOC core (console UI later, +3k). Compare: today's mcp+agents alone are ~11.7k plus 1,700 lines of bash plus a cluster.

**State on disk** (`/var/lib/op/`): `platform.key` (age, 0600) · `db.sqlite` (identity, PRs, webhooks, tokens, blob metadata) · `repos/<owner>/<name>.git` · `blobs/` · `certs/` · `pg/` (volume) · `ORIGIN`. **Desired state lives in git**: system repo `sys/gitops` holds `apps/<owner>/<app>/{app.json, secrets.age.json}`; reconciler converges HEAD, writes status to `refs/notes/status`. The platform's own source repos (`sys/platform`, `sys/app-template`, `sys/crew`) live in its own git hosting — self-referential, as today.

**Boot sequence** (<5s): open SQLite → load/mint sovereign key → init git store (unpack embedded genesis bundles if empty) → start HTTP listener (proxy+git+API+OIDC+MCP on one port) → start shared Postgres container + blob server (parallel) → start reconciler + dispatcher + ACME/backup timers → ready. No two-phase handoff exists to kill: the platform's DB is a file, created at first boot. Post-receive hooks kick the reconciler event-driven (no Flux interval race).

**Crash honesty**: reconcile is level-based and idempotent — every pass computes full desired-vs-actual from git HEAD and engine labels; no journal to corrupt. Crash mid-reconcile → restart → next pass converges. App containers outlive `opd` (engine-managed), so a platform crash is a proxy blip, not an outage; supervisor (systemd) restarts in ~1s.

## B. Per-subsystem positions

**Git server — hybrid, and firmly so.** TS owns everything product-shaped: HTTP framing, auth, repos, PRs, webhooks, hooks, refs/tree reads (`git cat-file --batch` worker pool). The wire protocol (`upload-pack`/`receive-pack --stateless-rpc` spawned against bare repos) delegates to the system git binary. Rationale: the git binary *is* the standard's reference implementation; isomorphic-git's server story is explicitly WIP, and pure-TS packfile negotiation is a multi-month correctness/security project sitting on the critical path of a system carrying client SOWs. "Own git in TS" means git hosting is a first-class TS product module — not reimplementing zlib delta chains. Pre-receive hooks are a shim that calls back into `policy` over a unix socket: push rejection is a typed function return.

**Identity/OIDC — build it on `jose`.** Standard discovery + authorization-code + PKCE + JWKS, users/orgs/PATs in SQLite. better-auth's provider plugin is mid-deprecation churn; panva's oidc-provider is Node-middleware-shaped and heavier than the ~1.5k LOC we need. OIDC the *standard* is the portability layer: every hosted app does SSO against it exactly as apps did against Forgejo.

**Platform DB — bun:sqlite, WAL mode.** Single-writer is correct because the platform is one process. Durability: WAL + fsync, snapshot-before-migration, continuous WAL shipping to the blob store (litestream pattern, implemented in `store`, ~200 LOC). This deletes the sqlite→postgres handoff pain class entirely.

**Build — the Docker Engine's build endpoint** (`POST /build` over the socket). Images land in the local engine store; **no registry on the M1 path**, which structurally removes MANIFEST_UNKNOWN races, registry-mirror-at-cluster-creation, and serial in-cluster builds. Builds are parallel jobs with per-repo layer cache. Dockerfile is the universal app contract (the Vercel lesson).

**Run — containers on the Docker Engine API, one answer.** Raw fetch over `/var/run/docker.sock` (Bun supports unix sockets); no dockerode. **Tenant isolation, concretely**: per-app dedicated bridge network (engine isolates networks by default; only `gate` joins all of them), non-root UID, `cap-drop=ALL`, `no-new-privileges`, memory/CPU limits mandatory (policy-enforced), named volume per app, secrets injected as env from in-memory decryption at create time — never on disk, never in image. Honest limit: shared kernel; a container escape is a platform escape. That is the v1 trust boundary, documented; microVMs are a trigger-deferral (F).

**Routing/TLS — own gate in `Bun.serve`.** SNI cert selection, host→app resolution from SQLite, forward-auth as in-process middleware (session cookie → git-permission probe → inject `X-Plat-*`) — the SSO gate becomes a function call, enforced by default, not a default-off Traefik middleware. ACME implemented directly against RFC 8555 (~600 LOC on jose+fetch): HTTP-01 default, DNS-01 for wildcards when a provider token exists. Test/CI mode: self-signed or plain HTTP.

**Per-app Postgres — real Postgres, one shared server container per node; not PGlite, not per-app containers.** PGlite is single-connection/embedded — wrong for client workloads needing pools, extensions, pg_dump. Per-app CNPG-style clusters are why the old boot took 20 minutes and a VPS runs out of RAM. One `postgres:17` container, platform holds superuser, provisions `CREATE DATABASE/ROLE` per app, `REVOKE CONNECT` from public — isolation at the role/database layer, over the Postgres wire protocol (the standard: apps see a DSN, nothing else). Honest limit: a PG privilege-escalation bug crosses tenants; per-app instances are a trigger-deferral. Backup: nightly `pg_dump` per DB to blob store; PITR deferred.

**Blobs — build the S3 subset over fs.** ~1,200 LOC: SigV4 verification, GET/PUT/HEAD/DELETE, ListObjectsV2, presigned URLs, multipart; write-temp-fsync-rename; bucket = directory + scoped credential. MinIO rejected (a second daemon, heavy, exactly the dependency this rewrite exists to shed); files-sdk rejected twice over — it is adapter-shaped (violates the no-adapters decision) *and* its fs backend is documented dev-only. The S3 **API** is the standards seam: at multi-node scale, point the same clients at R2/S3 — no code seam needed because the wire protocol is the seam.

**Secrets — typage** (FiloSottile's official TS age). The sovereignty invariant carries verbatim: every ciphertext in `sys/gitops` sealed to exactly one recipient, minted at germination, no escrow, no second recipient; `verifyAllSealed()` empirically decrypts every file with the fork key and aborts germination on any failure. SPOF-by-design retained, with `fork_backup_key`-equivalent custody gate.

**CI/checks — the build is the check.** Push → policy admission → build image → optional `.platform/checks.json` commands run in the built image → status posted → branch protection gates merge. No Actions-compatible runner in v1 (F).

**Policy — enforced at two synchronous admission points**, because we *are* the API server: (1) pre-receive: protected branches, workflow/spec-file protection, unsealed-secret rejection, app.json schema validation; (2) deploy admission in `reconcile`: image digest must match a platform-built digest (provenance without cosign), limits present, host registered, no privileged flags. A failed check means the mutation never happened — structurally killing audit-only Kyverno.

**MCP — in-process tool surface** (port the 26-tool semantics), every mutation authorized against git permissions (fail-closed delegated probe, as today's `authorize()`). Agent runs get an ephemeral token scoped to `(owner, repo, toolset, TTL)` plus a per-run deploy credential; the dispatcher's admin token never enters an agent environment (#16 boundary preserved as a type: agent-context tokens are a distinct credential class that cannot mint or escalate).

**AI crew — ai-sdk (direct-to-provider, never AI Gateway) + eve-inspired agents-as-directories**: `sys/crew/agents/<builder|reviewer|worker>/{instructions.md,tools.ts}`, versioned in git, hot-reloaded. Dispatcher consumes webhooks + `agent-work` labels; runs execute in containers holding only the scoped token; validator drives the preview URL with playwright before promote. Eve itself: too young (3 weeks), Vercel-coupled — steal the directory convention, not the framework.

**Mitosis — two TS functions.** `seed()`: bundle system repos + manifest (createdFrom, sopsRecipient, refs); ciphertext rides along inert — no key in the seed, ever. `germinate(seed, domain)`: fresh keypair → restore bundles to a new data dir → **regenerate every secret value** (not re-seal — regenerate: passwords, HMACs, S3 creds, OAuth clients) → rewrite identity/domain → append ORIGIN lineage → boot daughter `opd` (own ports, own SQLite, own Postgres container, may share the host engine — resources are label-namespaced by platform id). 790 lines of bash negotiating with Forgejo/Flux/k3d becomes ~900 lines of `Result.gen` sequence with typed failures, because there is no substrate to negotiate with — germinate writes files and starts a process.

## C. Milestone-1 CI test (<60s)

One `bun test` on a stock ubuntu GitHub runner (docker + bun + git preinstalled; `postgres:17-alpine` + the template base image restored from CI cache — cache restore is inside the job but the assertion budget assumes warm cache; a cold-cache run may exceed 60s and is marked soft-fail).

Sequence with budget: **boot mother** `opd` (SQLite init + genesis unpack + listeners) ~1.5s, Postgres container to `pg_isready` ~2.5s in parallel → **create user + PAT + app repo from template** via API ~0.3s → **git push** a tiny Dockerfile app (prebuilt static binary in-repo, `FROM scratch`-adjacent → build is a COPY) ~0.5s → post-receive kicks reconciler → **build** ~2–4s → **admission + run + gate route** ~1s → **HTTP probe** via Host header, response includes a value round-tripped through its provisioned Postgres DB ~0.5s → **seed()** ~1s → **germinate()** daughter (fresh key, regen, own data dir/ports; shares host engine so image cache is warm) boot ~2s → **daughter runs the identical check suite** (user, push, build [cache hit ~1s], run, URL, PG) ~7s → teardown. Total ~25–35s; per-phase budget assertions so regressions name the phase.

What makes it achievable: no cluster, no registry, no Flux interval, event-driven reconcile, SQLite-not-bootstrap-DB, trivial genesis app, shared engine cache for the daughter. What threatens it: cold image pulls (cache + tiny bases), engine build variance (COPY-only genesis app), Postgres readiness (100ms poll), CI runner contention (soft threshold 60s, hard 90s).

## D. Milestones

- **M1 — full loop, shallow.** Everything in C. Exit: the CI test green <60s; `op up` on a laptop yields a working platform with a deployed app and a sovereign daughter.
- **M2 — identity + day-2 spine.** OIDC provider + enforced SSO gate; PRs/issues/webhooks/branch-protection complete; both policy admission points; ACME on a real domain; backups (WAL-ship + pg_dump + blob mirror to external S3) with a **restore-from-backup CI test**; MCP full surface. Exit: platform hosts its own source repos on a public HTTPS domain and passes a destroy-and-restore drill.
- **M3 — crew + self-upgrade + migration.** Dispatcher/builder/reviewer/validator shipping an app unattended; self-upgrade: reconciler sees a new platform release tag → builds new binary in a container → snapshot SQLite → systemd socket-activated re-exec (apps unaffected); minimal OCI distribution endpoint over `blobs` (needed for multi-node pull); migrate the production app off the k8s platform. Exit: agent ships end-to-end; platform upgrades itself from its own merged PR; prod app serving clients.
- **M4 — growth on standards.** Worker nodes = container engine exposing Docker Engine API over mTLS + local volume; scheduler places apps by label; gate routes cross-node; blobs optionally re-pointed at R2/S3 (same wire API); Postgres stays node-pinned (data gravity, honest). Exit: 2-node deployment carries real workloads; a daughter platform in production for a client.

## E. Risk register

1. **Own-git auth/enforcement bugs** (push auth bypass, hook gap) — highest severity. Mitigate: wire delegated to git binary; auth path property-tested + fail-closed; protected-branch/enforcement suite in CI from M1; no anonymous write path exists.
2. **Shared-kernel + shared-PG tenant isolation insufficient for a hostile tenant.** Mitigate: hardened container defaults, per-app networks, PG role lockdown; documented trust boundary ("tenants are trusted-but-separated"); triggers in F flip to microVMs/per-app PG.
3. **Data loss on single-disk host.** Mitigate: WAL shipping + nightly dumps + blob mirror off-host from M2, restore drill in CI, fsync discipline in `blobs`/`store`; sovereign-key custody gate (SEC-1 carried over).
4. **<60s test rots** into flaky ceremony. Mitigate: per-phase budgets, event-driven everything, genesis app frozen tiny, cold-cache soft-fail lane.
5. **Single-process blast radius** (gate dies with control plane) + young deps (better-result, typage churn). Mitigate: crash-only design, containers survive, systemd restart ~1s, deps pinned and boundary-isolated; trigger: split `gate` into its own process only if an uptime SLO demands it.

## F. Explicitly not building (trigger-gated, Vault-style non-decisions)

- **Vault/escrow/multi-recipient keys** — never; sovereignty SPOF is the design (verbatim carry-over).
- **Adapters of any kind** — never; the seams are git protocol, OCI, Postgres wire, S3 API, OIDC, ACME.
- **Kubernetes/Flux/Helm/YAML manifests** — never; specs are `app.json`.
- **Actions-compatible CI runner** — trigger: external contributors needing arbitrary workflows.
- **MicroVM isolation (BoxLite/Firecracker)** — trigger: untrusted third-party tenants on shared hosts.
- **Per-app Postgres instances / PITR** — trigger: a client contract requiring instance isolation or point-in-time recovery.
- **OCI registry before M3, browser/PGlite mode, federation, SAML, deepsec-style AI scanning** (async cost model incompatible with the fast gate) — trigger: demand, not architecture.

### Critical Files for Implementation
- /Users/trevato/projects/mitosis/bin/germinate — the fork sequence to reimplement as `mitosis.germinate()` (phases, custody gate, verify-all-sealed)
- /Users/trevato/projects/mitosis/bin/lib.sh — secret regeneration inventory, rekey/verify logic, #16 workflow protection to port
- /Users/trevato/projects/mitosis/docs/security/secrets-threat-model.md — sovereignty invariant carried verbatim into `secrets`
- /Users/trevato/projects/mitosis/scripts/coldstart-assert.sh — assertion inventory to distill into the M1 test suite
- /Users/trevato/projects/open-platform/apps/op-api — prior TS art: tool surface (~43 tools), drizzle schema, REST+MCP shapes to mine for `forge`/`mcp`


══════════ ? ══════════
# Adversarial Synthesis — open-platform-ts

## 1. Decision Matrix

**Settled (3/3 agree — adopt as-is):**
- **Git wire protocol**: spawn system `git upload-pack`/`receive-pack --stateless-rpc`; TS owns auth, HTTP framing, repos, PRs. Settled.
- **Registry**: none in M1 — the engine's image store is the registry on one node. Settled.
- **Per-app Postgres**: one shared real Postgres container, database+role per app; PGlite rejected for tenants (single-connection, no wire protocol). Settled.
- **Blobs**: hand-built S3 subset over fs; MinIO (second daemon) and files-sdk (adapter-shaped, fs backend documented dev-only) rejected. Settled.
- **Secrets**: typage; one-recipient sovereignty invariant verbatim; regenerate-all + verifyAllSealed as germination gate. Settled.
- **Runtime**: Docker Engine, one answer; no k8s, no BoxLite (pre-1.0, no builder). Settled.
- **Routing/TLS**: the daemon is the ingress (`Bun.serve`, SNI, self-CA), forward-auth as in-process middleware, **on by default**. Settled; take production's ACME-at-M2-if-public-domain over M4 deferral.
- **CI shape**: build-is-the-check plus declared commands run in the built image, gating branch protection; no Actions dialect. Settled.
- **Policy**: synchronous fail-closed admission at the only write path; audit mode structurally absent. Settled.
- **Crew**: ai-sdk direct-to-provider, eve-inspired agents-as-directories (not eve), scoped ephemeral tokens preserving the #16 boundary. Settled.
- **Seed format**: git bundles + manifest, no key inside, state history squashed, genesis excluded. Settled.

**Contested — verdicts:**
- **Programmatic git ops**: minimalist = git CLI only (`cat-file --batch`); production = CLI worker pool; mitosis-first = isomorphic-git for "pure" paths. **Verdict: CLI only** — two git implementations writing the same bare repos (isomorphic-git commits + system-git receive-pack) is a ref-locking/pack-interop corruption surface bought for a browser demo scheduled in M4.
- **Platform DB**: minimalist = sqlite as "rebuildable index, git canonical"; production = sqlite canonical, WAL-shipped; mitosis-first = PGlite. **Verdict: production's** — the "rebuildable from git" claim is false for users/PATs/PRs/sessions (they have no git home), so treat sqlite as canonical and ship WAL; PGlite's single in-process connection serializing every router-auth lookup in a daemon that is also the proxy is a bottleneck plus immaturity for zero server-side benefit.
- **OIDC**: minimalist/production = hand-roll ~1.5k LOC on `jose`; mitosis-first = better-auth provider plugin. **Verdict: hand-roll** — the research base itself (research-full.md, better-auth section) documents the provider plugin as mid-deprecation toward an OAuth 2.1 plugin; a frozen minimal subset you own beats plugin churn on your identity root.
- **Engine interface**: minimalist = spawn docker CLI; production/mitosis-first = Engine API over the unix socket. **Verdict: Engine API** — build progress, events, and logs need streaming endpoints anyway; parsing CLI output is the fragile part, not the socket.
- **Crew execution**: production/mitosis-first = agent runs in containers with only scoped creds; minimalist = in-process ToolLoopAgent. **Verdict: containers** — #16 is only a boundary if the agent cannot read the dispatcher's memory/env; an in-process agent makes the boundary a convention.
- **Isolation hardening**: only production specifies non-root, `cap-drop=ALL`, `no-new-privileges`, mandatory limits. **Verdict: adopt as policy-enforced defaults**; "per-app network" alone is not a hardening story.
- **Blobs multipart**: production only. **Verdict: include** — AWS SDK `lib-storage` auto-multiparts above ~5MB; a "conformance-tested against the official SDK" server that lacks multipart fails the conformance claim on the first real file.
- **Scope honesty**: 9.5k vs 21k vs 25k LOC. **Verdict: production's accounting is credible**; minimalist's 900-LOC identity (users, orgs, teams, PATs, sessions, *and* an OIDC provider) is the tell of systematic undercounting — plan to production's numbers.

## 2. Flaws

**Minimalist — the durability contradiction.** It declares "sqlite is never canonical, always rebuildable from git," then stores PRs, issues, users, PATs, sessions, and check statuses in sqlite with no git representation, no WAL shipping, and no platform backup in any milestone (`op-data` dumps tenant DBs only). Lose `db.sqlite` — one disk fault — and all identity and forge history is unrecoverable, while the design's own rhetoric says nothing was lost. The "no migration, nothing to migrate" victory is purchased by quietly making forge data non-durable.

**Production — the self-referential backup and the missing repos.** WAL shipping targets its own blob store on the same disk until M2's external mirror, so the litestream pattern protects against process crash but not the actual threat (single-disk host, its own risk #3). Worse, its backup inventory (WAL-ship + pg_dump + blob mirror) never lists `repos/` — the bare git repos that are the *canonical desired state*. The restore drill would restore an index and lose the source of truth.

**Mitosis-first — immaturity stacked on the critical path for a deferred deliverable.** PGlite control plane, isomorphic-git in write paths, and better-auth's deprecating OIDC plugin are all adopted to keep packages "browser-pure" — serving a demo mode scheduled in **M4**. Concretely breakable: status writeback commits via isomorphic-git racing `receive-pack` pushes on the same bare repo (packed-refs locking is where isomorphic-git's server story is explicitly WIP), and PGlite serializing session lookups behind every proxied request under concurrent load.

## 3. The <60s Test

**Achievable — ~40–50s — but every accounting depends on the untimed setup window.** All three pre-pull base images and warm caches outside the clock; minimalist additionally pre-warms *the layer cache of the app under test* ("warm hello-app layer cache → ~6s"), which is testing theater — a genuinely cold build of a Bun app with an install step is 15–30s, and mitosis-first is the only design that budgets that honestly (15s). The biggest timing risk is **BuildKit cold-start variance plus shared-runner contention**, the single largest line item in all three budgets, doubled because mother and daughter each build (the daughter's speed depends entirely on sharing the mother's host engine cache — true on one host, so legitimate). Honest mitigation, composited: freeze the genesis app at zero npm dependencies so the build is COPY-only (production's move — this removes build variance structurally rather than hoping); per-phase wall-clock assertions so a regression names its phase (all three); cold-cache soft-fail lane with a 90s hard ceiling (production). Minimalist's "assert the total budget" alone turns runner contention into red-build noise.

## 4. Isolation Truth

Without k8s, three enforcement planes separate app A from app B, and a client review should hear them stated exactly. **(1) Kernel namespaces**: apps run as separate containers — non-root, `cap-drop=ALL`, `no-new-privileges`, memory/CPU limits, no docker-socket mount, per-app named volumes — so A cannot read B's filesystem, env (where secrets are injected in-memory at create time), or process space unless it escapes the shared kernel; that escape is the documented v1 trust boundary ("tenants trusted-but-separated"), with microVMs trigger-deferred. **(2) Postgres authn/authz**: per-app role with a strong generated password owning only its database, `REVOKE CONNECT` from public, scoped `pg_hba` — A can *reach* the shared PG but cannot authenticate to B's database; this is Postgres's own enforcement, not platform code. **(3) Platform code**: SigV4-verified per-bucket credentials for blobs and the router's forward-auth for HTTP — the weakest plane, since a path-traversal or signature bug in ~1.2k hand-rolled LOC crosses tenants; the conformance suite and key-prefix sanitization are the compensating controls. **One pierce all three designs under-specify**: "per-app networks, only the gate joins all" is contradicted by the shared Postgres — if apps join a common `db` network to reach PG, they can reach *each other* on it. Fix: attach the PG container to every per-app network (multi-attach) or set `icc=false`; this must be explicit, plus per-role connection limits so A cannot starve B's pool.

## 5. Missing

1. **Same-host germination breaks sovereignty.** All three let daughters share the host Docker engine ("resources are label-namespaced by platform id"). Labels are namespacing, not security: a daughter with the host socket can `docker inspect` the mother's containers and read the mother's injected secrets from env. Either declare shared-engine daughters test-only (fine for the M1 fixture) or give production daughters their own rootless dockerd. No design says which.
2. **Seed/format versioning.** Lineage implies a fleet of daughters at mixed ages; nobody versions the seed manifest, state-repo schema, or sqlite schema. A v5 binary germinating a v3 seed is undefined behavior in all three. Only production has *self*-upgrade at all (M3); minimalist and mitosis-first have no platform-upgrade story.
3. **App-owner day-2 surface**: logs, restart, exec, resource usage for the app developer. The old op-api exposed this; "zero→shipped in the browser" (M2 exits) is not credible without at least logs.
4. **Scheduled/background work for apps.** KEDA is deleted and nothing replaces it; agents get schedules, apps don't. First real client app with a cron job or queue worker has no primitive.
5. **DNS ownership.** Every daughter needs a wildcard record; germination rewrites the domain but no design owns telling the operator, automating it, or gating the "sovereign in <60s" hand-off on it — the one substrate negotiation that didn't disappear with the cluster.

### Critical Files for Implementation
- /Users/trevato/projects/mitosis/bin/germinate
- /Users/trevato/projects/mitosis/bin/lib.sh
- /Users/trevato/projects/mitosis/docs/security/secrets-threat-model.md
- /Users/trevato/projects/mitosis/scripts/coldstart-assert.sh
- /Users/trevato/projects/open-platform/apps/op-api
