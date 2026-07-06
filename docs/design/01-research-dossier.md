

══════════ ? ══════════
Have enough data. Report follows.

**What it is / who builds it**: `better-result` (github.com/dmmulroy/better-result) is a single-maintainer TS library — Dillon Mulroy (Twitch/dev-tools personality, ex-Vercel). MIT license, 1567 stars, 35 forks, 11 contributors, active (last commit 2026-05-28, v2.9.2 released 2026-05-04, ~monthly release cadence since Jan 2026 creation). Docs at better-result.dev. Zero runtime dependencies, 7.7KB unpacked / 2.4KB gzip (bundlephobia). ESM-only (`type: module`, ships `.mjs`+`.d.mts`), built with `tsdown`, tested with `vitest --typecheck`, linted with `oxlint`/`oxfmt` (Rust toolchain, fast).

**Core API surface**:
```ts
import { Result } from "better-result";

const parsed = Result.try(() => JSON.parse(input));          // sync throw → Result
const fetched = await Result.tryPromise(() => fetch(url));    // async throw → Result
const value = parsed.match({ ok: v => v.name, err: e => "fallback" });
const chained = Result.gen(function* () {
  const a = yield* parseNumber(x);      // auto-unwrap/short-circuit
  const b = yield* Result.await(fetchUser(id));
  return Result.ok(a + b);
});                                     // Result<T, UnionOfAllYieldedErrors>
```
Method-chaining (`.map`, `.andThen`, `.mapError`, `.tryRecover`, `.tap`/`tapError`/`tapBoth`, all with async variants) plus standalone data-first/data-last functions. Distinguishing features vs. peers: generator-based `Result.gen`/`yield*` composition (avoids `.andThen` pyramids while preserving per-branch error-type inference), built-in retry (`times`/`backoff`/`shouldRetry`) on `tryPromise`, a `TaggedError` helper for discriminated-union error classes, an explicit `Panic` type for genuinely unexpected throws inside combinators (keeps "expected errors" separate from "bugs"), and Result serialization support. It also documents an "Agents & AI" section, suggesting the author is positioning it as LLM-agent-friendly (structured error surface an agent can reason over rather than opaque exceptions).

**Runtime requirements**: TypeScript 5+, any modern ESM-capable runtime (Bun, Node ESM, browser bundlers) — no polyfills, no runtime deps at all, so it's about as light as a Result library can be and trivially embeddable in a browser-run subset of Open Platform TS.

**Maturity signals**: young (created Jan 2026, so ~6 months old) but fast-moving and already at v2.9 with real usage signals (1.5k stars, 14 open issues actively triaged, 11 contributors). This is meaningfully less battle-tested than neverthrow (multi-year, thousands of downstream consumers) or Effect (backed by a company, huge ecosystem, but far heavier).

**How it could serve Open Platform TS**: fits as the error-handling primitive at API boundaries — control-plane operations against Forgejo/Flux/CNPG/MinIO equivalents, where "did this git op / gitops reconcile / DB migration / object write succeed" needs to propagate a typed cause (network vs. auth vs. conflict) up through orchestration code without try/catch pyramids. `Result.gen` is a good match for the mitosis "spawn daughter platform" flow — a multi-step sequence (create org → seed repo → provision DB → issue secrets) where you want the first failure's typed error surfaced up cleanly, and `TaggedError` gives you a clean discriminated union for the CLI/API layer to pattern-match into HTTP status codes or CI failure reasons. Its near-zero bundle weight and zero deps matter directly for the "boots and tests in CI in under a minute" / partial-browser-run goals — it won't move the needle on install size or supply-chain surface.

**Risks/pitfalls**: (1) single-maintainer bus-factor risk on a ~6-month-old project — no governance/foundation backing; (2) ESM-only could bite if any tooling in the stack still needs CJS interop; (3) ecosystem is small — no adapter libraries (e.g., no `zod`-Result or `fetch`-Result glue package yet) compared to neverthrow's larger ecosystem; (4) `Result.gen`'s generator magic is elegant but non-obvious to newcomers/agents unfamiliar with the pattern — onboarding cost; (5) API is still evolving fast (monthly minor bumps) — pinning and re-vetting on upgrade is needed.

**Adopting repo-wide vs. lighter touch**: given the immaturity (6 months old, single maintainer), a full repo-wide mandate is risky right now. Better path: adopt `Result`-typed returns only at true I/O/external-boundary functions (git ops, DB, object storage, network) rather than forcing it into pure internal logic — that's where errors-as-values earns its keep and where the generator composition shines for the mitosis orchestration flow. Revisit for wider adoption once it clears 1.0-year/stability signals, or fall back to neverthrow (near-identical `.map`/`.andThen` API, far more battle-tested, similar zero-dep footprint) as a safer, more boring default; Effect is the heavier alternative if the team later wants structured concurrency/dependency-injection/tracing built into the same primitive, at the cost of a much steeper learning curve and larger footprint — likely overkill for a "minimize dependencies" goal.


══════════ ? ══════════
No hard boot-latency numbers surfaced in text pulled so far (marketing copy says "boot time" is tracked as a metric but doesn't publish a number in the README). Reporting with that gap flagged.

## BoxLite — findings

**What/who**: BoxLite (boxlite-ai/boxlite, https://github.com/boxlite-ai/boxlite) is an embeddable micro-VM sandbox runtime, Rust core with native bindings (napi-rs for Node). Positioned as "compute substrate for AI agents" / "SQLite of sandboxing." Small startup (created Dec 2025), maintainer Dorian Zheng + org, backed by Discord community. Apache-2.0 license (confirmed via GitHub API and npm package metadata).

**Maturity**: 2,129 stars, 135 forks, 159 open issues, pushed today (2026-07-06) — active daily development. Releases roughly every 1-2 weeks (v0.9.2 → v0.9.7 May-July 2026), still pre-1.0. npm package `@boxlite-ai/boxlite` at 0.9.7, also ships PyPI `boxlite`, crates.io `boxlite`, Go module. Used as a sandbox backend by Databricks Omnigent, Alibaba AgentScope Runtime, ByteDance deer-flow — real adoption signal, though all in AI-agent-sandbox context, not platform-hosting context.

**Core API (Node/TS)**:
```javascript
import { SimpleBox } from '@boxlite-ai/boxlite';
const box = new SimpleBox({ image: 'python:slim' });
try {
  const result = await box.exec('python', '-c', "print('Hello from BoxLite!')");
  console.log(result.stdout);
} finally {
  await box.stop();
}
```
Also a lower-level Runtime/Box API, a CLI (`boxlite run`, `boxlite serve`), and a REST server mode (`boxlite serve` → `POST /v1/boxes`, WebSocket exec). Node 18+ required; installs precompiled native addons per-platform (`@boxlite-ai/boxlite-{darwin,linux}-{x64,arm64}`).

**OCI/Dockerfile support**: Runs any unmodified OCI image (`python:slim`, `node:alpine`, `alpine:latest`) — pulls and caches from any registry including private ones. No evidence it builds Dockerfiles itself (no `docker build` equivalent) — it's a runtime, not a builder; you'd still need a separate image-build step (buildkit/kaniko/Docker) upstream.

**Platforms**: macOS Apple Silicon (KVM-equivalent via Hypervisor.framework), Linux x86_64/ARM64 (KVM), Windows via WSL2. macOS Intel is "coming soon" — not yet supported. Requires `/dev/kvm` on Linux, macOS 12+ on Apple Silicon.

**Startup latency**: No published number found in README/docs/npm — marketing states boot time is tracked as a runtime metric ("per-box & runtime metrics — CPU, memory, network, boot time") but doesn't quantify it. Comparable Firecracker-class microVMs typically claim 100-200ms cold boot; BoxLite's own claim is architectural ("stronger than a container, lighter than a full VM") without a benchmark in what I fetched — needs deeper digging (blog/benchmark posts) to confirm.

**Isolation/resources**: Hardware-virtualized VM per box (own kernel) + OS-level sandboxing (seccomp on Linux, sandbox-exec on macOS) + cgroups/rlimits for CPU/memory limits. Persistent state via per-box QCOW2 copy-on-write disk; boxes can be stopped/resumed, cloned, exported/imported as `.boxlite` archives, and detached to outlive the parent process.

**Networking**: Outbound internet by default, TCP/UDP port forwarding, egress allow-list (`allow_net`) to restrict destinations, secret injection via placeholders (real secret values never enter the VM), network I/O metrics.

**Fit for Open Platform TS (workload runtime, replacing K8s pods)**: Plausible per-app sandbox layer — daemonless embed model maps well to "boots in CI under a minute" and to a browser-adjacent/laptop-first architecture (no cluster required). Integration sketch: the platform's build step produces an OCI image (as today via Flux/whatever builder); at deploy time, instead of a K8s Deployment+Pod, the control-plane process (Bun/Node) calls `new SimpleBox({image, allow_net, volumes})` per app instance, using detached boxes for long-running services and the REST server mode (`boxlite serve`) if isolation from the parent Node process is wanted for multi-tenancy. Egress allow-list gives a lightweight Kyverno-adjacent network policy primitive. Persistence (QCOW2 COW disks) could substitute for PV-backed volumes on single-node deployments.

**Risks/pitfalls**: (1) Pre-1.0, API churn is expected — 0.1.0 → 0.9.7 in ~7 months, breaking changes likely before stability. (2) Single-node/single-host model by default — the "multi-tenant cloud" story requires their separate AWS-specific control-plane app (`apps/infra`, npm+AWS+Cloudflare-domain dependency) which reintroduces cloud lock-in/complexity contrary to "minimize dependencies." (3) No native Kubernetes-style scheduling/orchestration (no multi-node bin-packing, no service mesh) — you'd have to build that layer yourself for a real multi-tenant SaaS. (4) No Dockerfile build capability — still need a builder in the pipeline. (5) macOS Intel unsupported; Windows requires WSL2 — CI runners (e.g., GitHub Actions ubuntu-latest with KVM) should work, but verify KVM is available in whatever CI target is chosen (GitHub-hosted Linux runners generally do support nested KVM as of 2024+, but confirm for the chosen CI). (6) No hard, sourced boot-latency benchmark found — the "under a minute" CI/boot claim for Open Platform TS should be validated empirically rather than assumed from BoxLite's marketing.

**Alternatives**: Firecracker directly (AWS's underlying microVM tech, lower-level, no OCI/Node SDK layer, more DIY); Microsandbox (`superradcompany/microsandbox`, "easy, fast, local-first microVM runtime," similar SQLite-of-sandboxing pitch, surfaced in the same search results — worth a comparative look); or plain gVisor/runsc as a lighter, more mature (Google-maintained) but "just a container runtime" alternative lacking BoxLite's persistence/clone/export niceties.

Sources: https://github.com/boxlite-ai/boxlite (README, API), https://github.com/boxlite-ai/boxlite (GitHub API stats/releases), https://registry.npmjs.org/@boxlite-ai/boxlite (npm metadata), https://boxlite.ai/, https://docs.boxlite.ai/ (unreachable via WebFetch in this sandbox — only indirectly summarized via search snippets, worth a direct human check), https://github.com/superradcompany/microsandbox (alternative, unverified beyond title).


══════════ ? ══════════
Have enough dense data now.

## files-sdk (haydenbleasel/files-sdk)

**What/who:** Unified TS storage SDK by Hayden Bleasel (solo indie dev, known for Tersa, next-forge, and other polished DX-focused OSS libs). Tagline: "one small, honest API, web-standards I/O." Not a company/foundation project — single-maintainer.

**API surface:** ~9-method flat interface per adapter: `upload, download, head, exists, delete, copy, move, list/listAll, url, signedUploadUrl`, plus `file(key)` returns a key-scoped handle for chained ops. I/O types are Web-standard: `Blob`, `File`, `ReadableStream`, `Uint8Array`, `ArrayBuffer`, string — no provider SDK types leak through call sites. Pattern is "Adapter Injection": you instantiate `Files` with one configured adapter (e.g. `files-sdk/s3`, `/r2`, `/gcs`, `/azure`, `/fs`), and business logic stays adapter-agnostic — swapping backend = swapping one import + config, same calling code. (Sources: [GitHub](https://github.com/haydenbleasel/files-sdk), [Files SDK adapters](https://files-sdk.dev/adapters), [Florian Narr repo review](https://www.codeline.co/thoughts/repo-review/2026/files-sdk-unified-storage-adapter))

**Backends:** 30+ adapters incl. S3, R2 (Cloudflare), GCS, Azure Blob, MinIO, Vercel Blob, Supabase Storage, Dropbox, Google Drive, DigitalOcean Spaces, Backblaze B2, Wasabi, and a local `fs` adapter. Any S3-compatible target (R2/MinIO/Spaces/B2/Wasabi) installs via the `files-sdk` core + AWS SDK v3 packages (`@aws-sdk/client-s3`, `s3-presigned-post`, `s3-request-presigner`) and just swaps adapter config — meaning MinIO is a first-class supported target today, not an afterthought.

**Streaming:** Yes — `ReadableStream` is a native I/O type across upload/download, so large blobs don't have to buffer fully in memory; fits Bun/Node's web-standard stream interop.

**fs adapter caveat (important):** the local filesystem adapter is explicitly documented as dev/test-only — "uses `node:fs/promises` with a sidecar `.meta.json` per file… not for production." That's a real gap for a self-hosted-first platform that might want local-disk as a legitimate production backend, not just a MinIO substitute.

**Runtime/license:** TypeScript, Node/web-standards runtime (should work on Bun given no Node-specific APIs beyond `node:fs` in the fs adapter). MIT licensed.

**Maturity:** v1.2.0, 571 GitHub stars, last npm publish May 10 2026, active commits, changesets in place for semver discipline. This reads as young (sub-1 year likely) but tidy and actively maintained — not battle-tested at scale yet, no visible adoption case studies found in this pass.

**Fit for Open Platform TS:** Strong candidate as the storage abstraction layer replacing direct MinIO SDK coupling. Integration sketch: wrap `files-sdk/s3` (pointed at the daughter platform's MinIO/S3-compatible endpoint) behind Open Platform's storage interface; daughters that mitosis into a bare-VPS or browser-adjacent context could swap to `files-sdk/fs` for zero-dependency bootstrapping, or to R2/Supabase for hosted-tier daughters — all without touching platform code, which directly matches the "minimize deps, boot fast, run in browser partially" goals. The built-in AI SDK subpaths (Vercel AI SDK, Claude Agent SDK) are a bonus if agent-driven daughter provisioning wants file browse/mutate tool-calling for free.

**Risks:** (1) single-maintainer bus factor — no org backing; (2) fs adapter unsuitable for production, so "minimize dependencies" ambition of dropping MinIO entirely for small self-hosted deploys isn't actually satisfied out of the box — would need to either accept MinIO as still-required for prod-grade local storage, or contribute/fork a production-grade fs adapter; (3) young project (v1.x, ~1yr), API could still shift; (4) unverified Bun compat — no explicit Bun testing/docs claim found, worth a spike; (5) 9-method surface is deliberately minimal — no listing pagination/versioning nuances confirmed, may need extension for platform-grade audit/versioning needs (Kyverno-style policy hooks, retention).

**Alternatives:** `unstorage` (unjs) — broader KV+blob abstraction with Node/Deno/browser drivers, larger unjs ecosystem backing, arguably more battle-tested; or roll a thin custom interface directly over `@aws-sdk/client-s3` + a hand-rolled fs driver, trading unification convenience for full control over the production-fs gap.

**Confidence:** Likely on API shape/backends/license (multiple consistent sources: GitHub, files-sdk.dev, npmx, third-party review, author's own X post). Possible on Bun compatibility and production-readiness at scale (no direct evidence found either way).

Sources: [github.com/haydenbleasel/files-sdk](https://github.com/haydenbleasel/files-sdk), [files-sdk.dev/adapters](https://files-sdk.dev/adapters), [files-sdk.dev/overview](https://files-sdk.dev/overview), [npmx.dev/package/files-sdk](https://npmx.dev/package/files-sdk), [Florian Narr repo review](https://www.codeline.co/thoughts/repo-review/2026/files-sdk-unified-storage-adapter), [Hayden Bleasel's announcement on X](https://x.com/haydenbleasel/status/2053883406459740532)


══════════ ? ══════════
# BOOTSTRAP & REPLICATION MAP — /Users/trevato/projects/mitosis

## (1) Repo structure (every top-level entry)
- `bin/mitosis` (47L): dispatcher → `up|seed|germinate` (mitosis:40-47).
- `bin/up` (148L): `nix run .#up` entrypoint. Creates registry-ready k3d/k3s cluster (recipe baked at creation), locates seed, hands to germinate. Bare-server 2-step printed when no k3d.
- `bin/germinate` (789L): the core replication engine (detailed §2).
- `bin/seed` (130L): exports a seed from a running platform (§5).
- `bin/lib.sh` (899L): fork/rotate/verify helper library — `fork_rekey_sops`, `fork_regen_secrets`, `fork_verify_all_sealed`, `fork_set_identity_secrets`, `fork_postforgejo_secrets`, `fork_register_oauth`, `fork_seal_ca`, `fork_backup_key`(SEC-1), `rotate_age_key`(SEC-1 key rotation, value-preserving), `trim_gitops_lean`, `rewrite_identity_domain`, `build_and_verify`/`verify_oci_tag` (fail-loud CI bridge), `protect_workflows`(#16 credential boundary), `ensure_kube_system_traefik_alias`.
- `scripts/coldstart-assert.sh` (550L): THE acceptance gate — A1–A7 + E2E E1–E8 (component inventory source, §3).
- `scripts/reseed-run.sh`, `reseed-verify.sh` (§5), `sanity-test.sh` (sops sovereignty round-trip test).
- `.forgejo/workflows/coldstart.yml` (CI germination gate on vxrail host runner), `reseed.yml` (automated seed rebuild → PR).
- `recipe/registries.yaml.tmpl` (19L): k3s `registries.yaml` mirror → `git.__DOMAIN__` → `http://127.0.0.1:31100`.
- `genesis/seed.tar.gz`: committed genesis seed = 7 bundles (`gitops, mcp, agents, _app-template, ci-builder, mitosis, hello`) + `manifest.yaml`.
- `flake.nix`/`flake.lock`: packages 4 entrypoints, bundles runtime tools (kubectl, helm, fluxcd-from-unstable≥2.6 for OCIRepository v1, age, sops, git, curl, jq, python3, k3d); genesis rides along via `MITOSIS_GENESIS`.
- `ORIGIN`: plaintext lineage ledger. `README.md`. `docs/` (deploy/hetzner-vps, design/forgejo-identity-to-postgres-rbac, ops/age-key-rotation, ops/coldstart-ci, proposals/policy-governance-kyverno, security/secrets-threat-model).
- Untracked local artifacts (operator machine, not platform state): `fork-*.local.age` (4 sovereign keys), `claude-token`, `dg-token`, `tunnel-token`, `.ruff_cache/`, `.claude/`.

## (2) Germination flow (fork mode = the only mode; germinate:70-790)
Extract seed → mint FRESH age key `fork-$DOMAIN.age` (never uses parent key; §sovereignty) → SEC-1 custody gate (`FORK_KEY_ACK`/backup) → clone 7 bundles → `trim_gitops_lean` (derive lean profile from tree: strip observability+parent apps, split keda, keep kyverno/letsencrypt/cosign) → **forge sovereign gitops**: `fork_rekey_sops` (.sops.yaml→fork pubkey), `fork_regen_secrets` (regenerate ALL secrets fresh: minio root/kms, cnpg-backup S3, forgejo-admin pw, runner shared-secret, plat-agents-secrets [BYO claude cred sealed here], plat-mcp-secrets, registry-pull, webhook HMAC), rewrite identity (cleartext domain + encrypted `sops set` fields), `fork_verify_all_sealed` GATE (every secret decrypts w/ fork key + recipient listed) → set agents `appsDomain`/`forgejoSsh`, rewrite coredns `*.$DOMAIN→traefik`.
**Two-phase Forgejo handoff**: [1/2] throwaway sqlite Forgejo (helm) hosts gitops repo → install Flux, point at gitops (GitRepository+Kustomization), inject `flux-git-auth`+`sops-age` secrets → [2/2] wait forgejo-pg (CNPG postgres) Ready, wait until running Forgejo is postgres-backed (not bootstrap sqlite) → mint daughter PAT (admin+repo+pkg scopes) → `fork_postforgejo_secrets` (PAT/registry/agents PLAT_TOKEN), `fork_register_oauth` (daughter's own plat-mcp OAuth app), **mitosis fork** (#70, 3-tier: tier-1 seed `createdFrom` migrate, tier-2 `MITOSIS_FORK_ROOT`, tier-3 bundle push) → append ORIGIN lineage line → re-push all repos into real Forgejo + `protect_workflows` each + REGISTRY_TOKEN + `_app-template` template-flag → register CI runner token → **serial fail-loud CI builds** (`build_and_verify`: ci-builder image [tags derived from workflows], then mcp chart, then agents chart; polls OCI registry until served, 4 attempts) → seal daughter CA (`plat-local-ca-tls`→plat-mcp-secrets, re-push) → optional tunnel cutover alias → flux reconcile, roll mcp (re-read sealed CA), block until deploy/mcp+deploy/agents Available → print YOUR PLATFORM card (domain, admin pw, fork key, /etc/hosts, CA trust).
**Copied from mother**: git repo *contents/history* (bundles), repo metadata. **Freshly generated (sovereign)**: age key, every secret value, admin/QA passwords, PAT, OAuth client, CA, identity/domain. Seed's sealed secrets are inert ciphertext (parent key never present).

## (3) Component inventory (installed on every platform; namespaces + weight)
- **Forgejo** (ns forgejo): control plane — git/SSO(OAuth)/Actions/releases/OCI registry. Heavy.
- **CNPG** `forgejo-pg` (ns forgejo): Postgres for Forgejo. Heavy; slow cold-start.
- **Flux** (ns flux-system): gitops reconciler + OCIRepository/HelmRelease/Kustomization. Medium.
- **Traefik** (ns traefik): ingress, TLS terminate, redirect-to-https middleware. Medium.
- **cert-manager** (ns cert-manager/plat-system): PKI, mints `plat-local-ca`. Medium.
- **Kyverno + kyverno-policies** (ns kyverno): ≥12 ClusterPolicies, tenant governance (ResourceQuota/NetworkPolicy/app labels). Medium.
- **KEDA** (ns keda): ScaledJob for Forgejo Actions runner (must precede forgejo). Light-medium; own wait Kustomization.
- **MinIO** (ns plat-storage): S3 + KMS auto-encryption; CNPG backup target. Medium.
- **registry-node-config** DaemonSet: socat mirror on node `127.0.0.1:31100`. Light.
- **coredns-custom**: in-cluster `*.$DOMAIN→traefik` DNS. Light.
- **mcp** `deploy/mcp` (ns mcp): platform MCP server, OAuth login. Medium.
- **agents** `deploy/agents` (ns agents): autonomous AI build dispatcher (builder→reviewer→promote). Medium.
- **letsencrypt** (optional, cloudflare DNS-01), **cosign-signing** (POL-3 image signing). Stripped in lean: monitoring/grafana/pgadmin.
Gate expects ≥10 Flux Kustomizations Ready, ≥12 ClusterPolicies.

## (4) Boot sequence & timing (README §42-57)
Cluster create ~2m → bootstrap Forgejo ~2m → Flux reconcile + CNPG cold-start **10–20m** (cert-manager→traefik→keda→platform→cnpg chain) → **serial CI builds 15–25m** (ci-builder→mcp→agents; cold registry-mirror makes first builds slow/flaky, retries warm cache). Total 30–60m. Time sinks: CNPG cold-start, in-dind image builds. One-shot; failure → `k3d cluster delete plat` + re-run (no resume).

## (5) Self-replication logic location
- **Export**: `bin/seed` — inputs `PLAT_PAT`, `FORGEJO_URL`, `PROFILE` (lean|full), `GITOPS_REF`; outputs `seed*.tar.gz` (gitops+mitosis squashed to orphan commit, code repos full history+tags, `manifest.yaml` with `createdFrom`/`domain`/`sopsRecipient`/per-repo refs). Filters `genesis/`+`.claude/` (prevents seed nesting).
- **Grow**: `bin/germinate`+`bin/lib.sh` — inputs `SEED`,`DOMAIN`,`FORK_KEY`, optional claude cred; outputs sovereign running platform + fork key + card.
- **Orchestrate**: `bin/up` (cluster+germinate).
- **Automated reseed**: `.forgejo/workflows/reseed.yml`→`scripts/reseed-run.sh`→`reseed-verify.sh` (V1–V5) → opens PR bumping `genesis/seed.tar.gz`; coldstart gate germinates from it before merge (see git log: recurrent `genesis: reseed rNN`).


══════════ ? ══════════
## deepsec (vercel-labs/deepsec)

**What it is / who builds it.** An "agent-powered vulnerability scanner" from Vercel Labs (org, not a single named team), Apache-2.0, TypeScript, Node ≥22, pnpm monorepo. Repo created 2026-04-30, actively pushed as of 2026-07-06 (same day as this research). 5,115 stars, 304 forks, 38 open issues, no tagged releases yet (main-branch only, v0.1.0 internal). Announced via Vercel's own blog ("Introducing deepsec: find and fix vulnerabilities in your codebase"). Young (~2 months old) but high adoption velocity for its age — treat as beta, not GA.

**What it scans.** Whole-repo AI vulnerability review, not a linter. Two-phase pipeline: `scan` runs fast regex "matchers" (project-specific + built-in, extensible via a docs/writing-matchers.md workflow where you point a coding agent at your codebase to grow the matcher set) to find candidate sites; `process` sends flagged files (plus files with zero matcher hits, for holistic coverage) to an LLM agent for actual investigation, producing findings + fix recommendations. Also has `triage` (cheap P0/P1/P2 classification), `revalidate` (recheck existing findings against git history for fixes), `enrich` (git blame/ownership), `report`/`export`/`metrics` for output, and a dedicated **PR-diff mode**.

**How it runs — CLI + CI + agent loop, not a static scanner.**
```bash
npx deepsec init                       # bootstrap .deepsec/ project dir
pnpm deepsec scan && pnpm deepsec process
pnpm deepsec process --diff origin/main   # CI/PR mode: only changed files
pnpm deepsec export --format md-dir --out ./findings
```
It literally *is* a coding agent with shell access on your checkout — docs explicitly say "treat deepsec like a coding agent with full shell access." For large repos it fans out across worker machines, and optionally across **Vercel Sandbox** microVMs (`deepsec sandbox process --sandboxes 10 --concurrency 4`) for isolation + parallelism; sandboxed workers get egress locked to coding-agent hosts only, and API keys are injected outside the sandbox so they can't be exfiltrated by prompt-injected code.

**Model/API dependencies — this is the big constraint.** Requires an LLM backend: either a local Claude Code/Codex subscription login (explicitly called out as insufficient for real scans — "generally don't have enough headroom for full repo scans") or, for real use, a **Vercel AI Gateway** key (`AI_GATEWAY_API_KEY=vck_...`) fronting Claude/Codex, or direct `ANTHROPIC_AUTH_TOKEN`/OpenAI creds. Cost is explicitly framed as "thousands or even tens-of-thousands of dollars for large codebases" per full scan — this is not a free/local static-analysis tool, it's a paid-inference product wearing OSS clothing.

**Fit as Open Platform TS's security-gating subsystem (replacing Kyverno+cosign, or sitting alongside it).** It doesn't overlap with Kyverno (admission-policy enforcement) or cosign (artifact signing) — it's upstream of both, a source/PR-level vuln finder, not a runtime policy engine or supply-chain attestation tool. Integration sketch: run `deepsec process --diff origin/main --comment-out findings.md` as a CI job on PRs against the platform's Forgejo-hosted app repos, gate the merge/deploy on a documented non-zero exit code for P0/P1 findings, and post `findings.md` as a PR comment (there's a first-class flag for this). It would sit as one more required-status-check step before the existing Flux/Kyverno/cosign deploy pipeline runs — it does not replace signing or admission control, only adds a pre-merge "did the agent find a real vuln" gate. The docs even discuss a two-job GitHub Actions split (checkout/install in one job, secret-bearing `analyze` in a separate job gated on `author_association`) specifically to avoid leaking the AI Gateway key to PR-controlled code — a pattern that would need re-derivation for Forgejo Actions.

**Risks/pitfalls for this use case:**
- Cost model is fundamentally incompatible with "boots and tests in CI in under a minute" — this is a slow, expensive, asynchronous review step, not a sub-minute check. Fine as an async/nightly or pre-merge-optional gate, wrong as a blocking fast-CI gate.
- Hard dependency on a paid, hosted inference provider (Vercel AI Gateway or direct Anthropic/OpenAI) — directly conflicts with "minimizes dependencies" and self-hostability; there is no offline/local-model mode documented.
- Zero tagged releases / semver — API surface (CLI flags, config schema) could break without warning; no stability guarantee.
- Security model of the tool itself is "trust it like a coding agent with shell access" — running it on untrusted/community-PR code (a real scenario for a public daughter-platform marketplace) needs the sandbox mode plus the branch-protection dance described above, adding real operational complexity.
- No native Bun support confirmed — engines pin Node ≥22, uses tsx/pnpm; would need testing under Bun runtime target.

**Alternatives:** (1) **Semgrep** (OSS, Apache-2.0, mature, no LLM dependency, sub-second/minute scans) for the actual sub-minute CI gate, with deepsec-style agentic review reserved for periodic deep audits. (2) **CodeQL** (GitHub's engine, free for public repos) as a self-hostable static analysis alternative with far lower per-run cost, sacrificing deepsec's "finds logic bugs a regex can't" agentic depth.


══════════ ? ══════════
# OPERATIONS, TESTING & PAIN — mitosis recon

Note: no `open-platform.sh` exists. Entrypoints are `bin/*` (bash) packaged by `flake.nix` as `nix run .#{up,seed,germinate,mitosis}`. No TODO/FIXME/HACK markers anywhere (grep clean); `.claude/` is empty (seed drops it, `bin/seed:103`). No unit-test framework — one throwaway `scripts/sanity-test.sh` + assertion gate.

## (1) Operational scripts & verbs
- `bin/mitosis` (47L): dispatcher → `up|seed|germinate|help` (`bin/mitosis:41`).
- `bin/up` (148L): create registry-ready k3d cluster (registry recipe + port maps baked at CREATION, `bin/up:96`), then exec `germinate`. Handles Docker-not-running, k3d-missing (prints bare-VPS two-step), cluster-reuse. Env: DOMAIN/CLUSTER/K3S_IMAGE(`rancher/k3s:v1.31.5-k3s1`)/HTTP_PORT/HTTPS_PORT/PORTS=none/SEED/FORK_KEY.
- `bin/seed` (130L): mirror-clone 7 system repos (`plat/gitops mcp agents _app-template ci-builder mitosis hello`, `bin/seed:19`), squash gitops+mitosis to single orphan commit (`seed_squash_main`, drops genesis/+.claude to prevent seed nesting `:99-108`), bundle, write manifest (createdFrom/domain/sopsRecipient/repos+metadata). PROFILE=lean|full; GITOPS_REF override for pre-merge RC seeds.
- `bin/germinate` (789L): the monolith. FORK mode only. Phases (tracked by `STEP` for trap ERR): mint age key → SEC-1 custody gate → restore bundles → forge sovereign gitops (rekey sops, regen secrets, rewrite identity, `fork_verify_all_sealed` gate `:149`) → two-phase Forgejo handoff (sqlite bootstrap → postgres/CNPG, `:296-384`) → mint daughter PAT (admin scopes) → wire secrets/OAuth → mitosis 3-tier fork-migrate (`:437`) → ORIGIN lineage → re-push repos + `protect_workflows` → register runner → **serial fail-loud CI builds** (ci-builder→mcp→agents) → seal CA → reconcile → block on mcp+agents Available → print YOUR PLATFORM card.
- `bin/lib.sh` (899L): fork helpers (`fork_rekey_sops`, `fork_regen_secrets`, `fork_verify_all_sealed`, `build_and_verify`+`verify_oci_tag` OCI-registry poller), `trim_gitops_lean`/`_ensure_flux_kust` (drift-repair), `rewrite_identity_domain` (dot-escape CA gotcha `:42-60`), SEC-1 lifecycle (`fork_backup_key`, `rotate_age_key` two-stage live rotation `:837`), `protect_workflows` (#16 credential boundary), `ensure_kube_system_traefik_alias`.

## (2) CI (Forgejo Actions)
Two workflows, run on self-hosted `vxrail-coldstart` HOST-mode runner (capacity 2), no `actions/checkout` (manual git clone).
- **`coldstart.yml`** (213L): triggers on PR paths (bin/genesis/recipe/flake/gate/self), nightly cron `17 4 * * *`, dispatch (gitops_ref RC-seed, e2e). Per-ref concurrency, cancel-in-progress. Steps: orphan-sweep (`^k3d-ci[0-9]+-` >150min) → clone → optional RC seed → `timeout 55m nix run .#up` → `timeout 20m coldstart-assert.sh` → optional `timeout 35m --e2e` → always-teardown that FAILS on leaked containers. Job cap 110m.
- **Gate `scripts/coldstart-assert.sh`** (550L): A1 (≥10 Flux Kustomizations Ready + ≥12 Kyverno policies) A2 (exactly 1 webhook, probed by ID 1..8 because LIST returns [] — #67) A3 (webhook idempotency across restart, version-gated ≥0.7.6) A4 (https redirect matrix, tolerates pre-#64) A5 (registry mirror :31100 + crictl pull) A6 (agents+mcp Available) A7 (fork genealogy tier). E1-E8 = nightly unattended app ship (canary→prime PR→auto-merge→prod 200 in-cluster→governance).
- **`reseed.yml`**(42L)+`reseed-run.sh`+`reseed-verify.sh`: #14 auto-rebuild genesis seed as PR (no-op guard on unchanged refs `reseed-run.sh:23`); V1-V5 verify (createdFrom durability #76, bundle integrity, ref==origin-head, content markers). PR touching genesis/** re-triggers coldstart → end-to-end validated pre-merge.

**Germination-timeout saga** (from git log + comments): 40m→55m bump because capacity-2 parallel germinations contend and in-dind chart builds stretch — "run 30 Terminated at 40m with agents build still running" (`coldstart.yml:150-153`, commit 6a657dd). Per-run `FJ_PORT=$((30000+run%10000))` added (9cc2ef6) because shared :3000 cross-talks → "admin auth failing after handoff" (run 11). Reseed had 3 broken dispatches: YAML block-scalar escape (368300f), `set -e` empty-ref kill (8969618), logic moved to script as "thin shim" (7cdfc10). A4 detection moved CR→HelmRelease (#73). Logs host-persisted because "job-log API 404s on this Forgejo" (d6bbf07).

## (3) Where ~20min goes (README:48-54 + code)
Cluster create ~2m; bootstrap Forgejo sqlite ~2m (`helm --timeout 10m` `:302`); **GitOps reconcile + CNPG Postgres cold start 10-20m** (cert-manager→traefik→keda→platform→cnpg chain, waits `seq 1 120`×10s then `wait --timeout 10m` for forgejo-pg Ready `:353-359`); **build platform images 15-25m** — the serial CI builds dominate: `BUILD_TIMEOUT=35m`×4 attempts each for ci-builder(possibly 2 tags 0.1.0+0.2.0)→mcp→agents (`:587-621`). First builds slow: cold registry-mirror cache, empirically mcp needed 3 tries (`lib.sh:520-527`). Extra fixed waits: postgres-backed handoff poll (`seq 1 90`×10s `:367`), CA seal (`seq 1 60`×5s), finalize `sleep 10`+rollout waits 5m each.

## (4) Bloat / fragility / fighting-the-substrate
Dense evidence of substrate-fighting, all in comments:
- **Two-phase sqlite→postgres Forgejo handoff** with a "CRITICAL handoff gate" that execs into the pod to read `DB_TYPE` from app.ini because `rollout status` returns on the bootstrap pod (`:361-374`).
- **MTU shim** — dind docker0 1500 vs flannel 1450 silently drops npm pulls (`:102-108`).
- **`ALLOW_LOCALNETWORKS` python-patch** so repo-migrate works for LAN parents (`:119-130`).
- **Registry recipe must be applied at cluster-creation** (containerd config_path only settable then) — the entire reason `up` wraps `germinate` (`bin/up:4-11`, `recipe/registries.yaml.tmpl`).
- **Flux race workarounds** — annotate ocirepository/helmrelease reconcile + `rollout restart deploy/mcp` because it caches MANIFEST_UNKNOWN and holds stale empty-CA env (`:667-687`).
- **`build_and_verify` 4-retry fail-loud loop** exists because prior "plat2/plat3/platgold" daughters reported success with missing charts (`lib.sh:474-480`).
- Pervasive `|| true` / `2>/dev/null` guards against `set -e`+pipefail killing retry loops (explicitly annotated `:566-568`, `:389`, `:636`). Webhook probed by ID because LIST returns [] (#67). `pod_probe` reads pod logs not `kubectl run -i` attach ("loses early output" `:161-164`). Dot-escape CA-name gotcha from "2026-06-08 VxRail migration" (`lib.sh:40`). Many `sed_in_place` helmrelease VALUE overrides because charts build from release TAG so source edits don't reach artifacts (`:154-223`).

## (5) Design principles (verbatim)
- Sovereignty invariant (`docs/security/secrets-threat-model.md:41`): "**Every** encrypted secret under `clusters/**` in a platform's gitops repo is sealed to exactly **one** age recipient — the platform's _sovereign_ (fork) key, minted at germination and never shared with the parent or any sibling. There is no escrow, no second recipient, no parent copy." SPOF-by-design (`:68`): "Lose the sovereign key... That SPOF is the deliberate cost of sovereignty."
- One-shot, no-resume (`bin/germinate:18`): "This is a ONE-SHOT script: it forges fresh identity/keys/passwords and there is no resume machinery." README:56: "Setup is one-shot by design — there are no half-finished states to untangle."
- Single gate source of truth (`coldstart-assert.sh:5`): "If you add an acceptance assertion, add it HERE — not in the workflow, not in a runbook."
- Deliberately no Vault (`secrets-threat-model.md:246`): germination "forks a platform in ~18 minutes"; Vault "a large regression." "we pay with 'lose the key...'" (`:276`).
- Reproduction/lineage: README:98-110 ("Your platform reproduces... records its lineage"); `ORIGIN` file is the plain-text family tree. No "forest approach" phrase found in-repo; closest is the reproduction/lineage/sovereignty framing above and `flake.nix:2` "self-replication (seed + germinate)".

Bloat candidates for TS rewrite: 789L germinate monolith + 899L lib.sh are almost entirely imperative shell orchestration of curl/kubectl/sops/git against Forgejo's API quirks; the sqlite→postgres bootstrap handoff, serial in-cluster CI image builds, and registry-mirror-at-creation are the three heaviest substrate fights.


══════════ ? ══════════
## eve.dev (Vercel Eve) — Research Findings

**What it is / who builds it:** Eve is Vercel's open-source, TypeScript-native framework for building and running AI agents, publicly launched at Vercel Ship London on 2026-06-17. Tagline: "filesystem-first framework for durable AI agents." Built and maintained by Vercel (github.com/vercel/eve). NOT the old witheve.com Eve language — confirmed distinct.

**License:** Apache-2.0.

**Maturity signals (as of 2026-07-06 via GitHub API):**
- 3,259 stars, 263 forks, 179 open issues, 9 subscribers
- Created 2026-06-16, actively pushed to same-day as this query (2026-07-06 18:17 UTC) — very active, ~3 weeks old
- Language: TypeScript. npm package `eve`, versioned (`eve@latest`)
- Explicitly in **beta**, subject to Vercel's public-beta-agreement — API/behavior may change before GA
- Backed by Vercel's own production fleet: 100+ internal agents run on it, including a data analyst handling 30,000 questions/month (per The New Stack / MarkTechPost coverage)

**Core API surface (filesystem-as-config):**
```
my-agent/
└── agent/
    ├── agent.ts          # model/runtime config
    ├── instructions.md   # system prompt (required)
    ├── tools/*.ts         # typed fn tools (zod schemas via defineTool)
    ├── skills/*.md        # on-demand procedures
    ├── channels/*.ts      # Slack/Discord/HTTP delivery
    └── schedules/*.ts     # cron jobs
```
CLI: `npx eve@latest init my-agent`, `npm run dev` (interactive TUI), `eve build` (compiles inspectable artifacts to `.eve/`), `eve eval` (test suites). Because an eve project is an ordinary Vercel project, `vercel deploy` ships it unchanged. Code sample:
```ts
export default defineTool({
  description: "Return mock weather data for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }) { return { city, condition: "Sunny", temperatureF: 72 }; },
});
```

**Built-in capabilities:** durable execution (workflows checkpoint every step, survive crashes/restarts, park while waiting and resume on next message), sandboxed compute (isolated VMs spun up on demand, full FS/bash/code isolation), multi-channel delivery (one codebase → web chat, Slack, API, cron, CLI).

**Requirements:** Node/npm-based (Bun compatibility unconfirmed from sources); designed to run as/within a Vercel project (though framework itself is open-source and could plausibly run elsewhere — deployment story is Vercel-first, not verified as fully portable/self-hostable).

**Relevance to Open Platform TS:** This is squarely an **agent-runtime subsystem** candidate, not a git/gitops/policy substitute. Plausible integration points:
1. **Agent execution layer for platform automations** — daughter-platform bootstrap agents, PR-triage bots, or the "operator queue" workflows currently done by ad hoc Claude Code sessions could become eve agents (directory-defined, versioned in git, durable across restarts) — a good fit given Mitosis's existing pattern of git-as-control-plane.
2. Durable execution/checkpointing model is conceptually adjacent to what Open Platform TS wants generically (survivable workflows) — worth studying eve's checkpoint mechanism as a design reference even if not adopted wholesale.
3. Sandboxed compute model competes/overlaps with whatever sandbox story Open Platform TS picks for running daughter platforms or executing untrusted app code.

**Risks/pitfalls:**
- Beta, 3 weeks old, breaking-change risk high; APIs/docs explicitly unstable pre-GA.
- Deployment narrative is heavily Vercel-coupled (`vercel deploy` ships it) — self-hosting outside Vercel's platform is unconfirmed/unclear from available sources; conflicts with "minimize dependencies / self-hostable" goal unless the OSS core decouples cleanly.
- Apache-2.0 open-source but production hardening/adoption outside Vercel itself is unverified (no third-party production case studies found beyond Vercel's own).
- 179 open issues on a 3-week-old repo suggests active churn / rough edges.
- No confirmed browser-runnable story (target vision wants partial browser execution) — sandboxes are described as isolated VMs, i.e., server-side.

**Alternatives:** Temporal (mature durable-execution engine, TS SDK, self-hostable, much longer track record) for the durable-execution piece; LangGraph or Mastra (TS-native agent frameworks with more explicit self-host stories) if Vercel-coupling in eve proves too tight.

Sources: [github.com/vercel/eve](https://github.com/vercel/eve), [vercel.com/blog/introducing-eve](https://vercel.com/blog/introducing-eve), [The New Stack](https://thenewstack.io/vercel-launches-eve-an-open-source-framework-that-treats-agents-as-directories/), [MarkTechPost](https://www.marktechpost.com/2026/06/17/vercel-releases-eve/), GitHub API metadata for vercel/eve.


══════════ ? ══════════
Reconnaissance complete. Raw inventory below.

## Canonical repo topology (Forgejo origin `git.open-platform.sh`, org `plat`)
Authoritative list from seed manifest (`mitosis/genesis/seed.tar.gz`→`manifest.yaml`) + `bin/germinate`:
- **plat/mitosis** — THIS repo (replication/germination driver). Public. `bin/{up,germinate,seed,mitosis,lib.sh}`, `flake.nix` (`nix run .#up/.#germinate/.#seed`), `recipe/registries.yaml.tmpl`, `genesis/seed.tar.gz`, `.forgejo/workflows/{coldstart.yml(11k),reseed.yml}`. ~5 shell scripts + nix. Small.
- **plat/gitops** — Flux GitOps repo, the only path to cluster. Private, topic `flux-managed`, SOPS-encrypted (`.sops.yaml`). `clusters/local/{platform/*,apps/*,domains.yaml,flux-kustomizations.yaml}`. Platform components dir: `cnpg-operator, plat-storage(MinIO), cert-manager, agents, mcp, keda, coredns, forgejo, plat-system, traefik, pki, registry-node-config, registry-pull-secret`. YAML-only.
- **plat/mcp** (`plat-mcp`) — TS/Bun MCP server, **~7,488 LOC**. 26 tools wrapping Forgejo(git/PR/issue/CI)+K8s(status/logs/exec/query_db)+app lifecycle(create/release/delete/rotate_oauth). Streamable-HTTP at `mcp.<domain>/mcp`. `src/{server.ts,overlay.ts,domains.ts,token.ts,preview-cli.ts,tools/{ci,data,context,forgejo-collab}.ts}`, `charts/`, `docs/agent-tools.md`. Private. tags→v0.26.0.
- **plat/agents** (`plat-agents`) — TS/Bun in-cluster autonomous build dispatcher, **~4,210 LOC**. Poll-based reconciler (issues/previews/teardown/releases). `src/{dispatcher.ts,runner.ts,forgejo.ts,state.ts,mcp.ts,log.ts}`, `prompts/`, `hooks/`, `charts/agents`. Drives `claude` via MCP. Private. tags→v0.7.6.
- **plat/_app-template** — "Use this template" app scaffold, TS/Bun, **~721 LOC**. `Dockerfile,charts/,src/,dist/`. Must carry Forgejo template flag (`germinate:285`). Public.
- **plat/ci-builder** — CI builder image referenced by `container: …/plat/ci-builder:<tag>` in EVERY workflow; MUST be public or all CI pulls 401 (`germinate:256-266`). tags v0.1.0/v0.2.0.
- **plat/workflows** — DBOS platform-automation service (MCP `list_workflows/run_workflow/get_workflow_status/tail_workflow_logs/cancel_workflow`). Source in `open-platform-clauding/plat-src/workflows`.
- **plat/hello** — smoke/sample app bundled in seed.
- Per-user app forks `<owner>/<app>` created by MCP `create_app`.

Germination public/private policy (`germinate:266`): public={mitosis,ci-builder,_app-template}; private={gitops,mcp,agents}.

## Mitosis coupling / replication mechanism
`seed.tar.gz` = git bundles of all `plat/*` repos + `manifest.yaml` (per-repo ref/tags/topics/sopsRecipient/domain). `germinate` restores bundles→forks→**reseals SOPS with a fresh age key**→pushes to new Forgejo→Flux reconciles. `coldstart.yml` proves fresh germination nightly + optional app-E2E (needs `E2E_CLAUDE_TOKEN`). Depends on: ci-builder image, _app-template flag, mcp+agents charts (delivered via gitops), Forgejo **SSH deploy-key** credential boundary (plat/mitosis#16). `ORIGIN` file tracks germination lineage.

## Live working-copy estate (checkouts of canonical repos)
- **open-platform-clauding/** (~1.5GB, main dev workspace, Jun 9–10 2026 = seed epoch). `repos/{agents,gitops,mcp,app-template,toolkit}` are the canonical current source; `toolkit` README == mitosis README (early mitosis, called "mitosis-toolkit"). Also `plat-src/{_app-template,gitops,mcp,workflows}`, `commons/`(103M), **`foundry/`(407M)** = earlier TS monorepo orchestrator (`DESIGN.md,packages/,k8s/,.forgejo/`, bun), plus many branch-worktree scratch dirs (`_agents-*,_appt*,_mcp-work,mitosis/,vxrail-migration-backup`). Mine for history, not authoritative.
- **mitosis-work/** — live feature-dev multi-worktree of ALL canonical repos on branches: `_app-template@feat/rbac-3-forward-auth-headers`, `agents@feat/rbac-4-run-acts-as-user`, `gitops@feat/pol-4-secrets-domains-validate`, `mcp@feat/rbac-4-agent-ctx-token`, `mitosis@feat/observability-grafana`, `mitosis-ci@feat/ci-1-coldstart-gate`. Shows active workstreams: RBAC/forward-auth, policy(secrets/domains validate), coldstart-gate CI, grafana observability.
- **mitosis-wt-gatecap/** — worktree of plat/mitosis (gate/probe-from-pod-logs, Jul 2).
- **open-platform-ts/** — EMPTY, created today (Jul 6) = the TS reimplementation target.

## Legacy / parallel lineages (predecessors to subsume)
- **open-platform/** (github `Trevato/open-platform`, Apr 2026) — most complete prior **full TS/Bun implementation**. Differs from current stack: **Woodpecker CI** (not Forgejo Actions), **oauth2-proxy** (not Traefik forwardAuth), **op-api** (REST+MCP, **~43 tools/10 categories**), **console** control panel, drizzle-zod schema. `platform/{apps,identity,infrastructure}`, `charts/,install.sh,op-cli(nix),templates/app`. CLAUDE.md documents full arch incl. Mailpit/Jitsi/Zulip/MinIO/CNPG. Primary TS precedent for reimplementation.
- **agentic-platform/** (forgejo `platform/platform`, Jun 10) — alt architecture: `services/{orchestrator,agent-runner,host-bridge}` + **host-bridge daemon running `claude -p` on host**, ingress-nginx, poll reconciler, `gitops/`, `templates/bun-web-app`, `ARCHITECTURE.md`. Design ancestor of agents dispatcher.
- **platform-mcp/** — early MCP/CLI exploration: flux-operator-mcp(nix) + op-api + cli + app-template + charts + seed.
- **plat/** — minimal `bootstrap.sh`+flake, sops-age seed experiment (May).
- **fluxing/** — validation/bringup lab (op-api, flux, `platform-bringup`, `prod-bringup`, many FINDINGS/AUDIT/PROD-CUTOVER md). Host `forgejo.fluxing.test`.
- **programmer/** — app deployed on a DIFFERENT platform instance: origin `http://10.0.0.47:3000/product-garden/pathfinder`; `PLATFORM.md`: "product-garden self-hosted platform (k3s on VXRail)", Woodpecker `.woodpecker/`, ships to `<name>.product-garden.com`. Evidence of a separate prod platform lineage **product-garden** on LAN Forgejo `10.0.0.47:3000`.
- Peripheral built-apps/experiments: `openplatform/`(app-template only), `op-workspace/`(job-board demo app), `test-op/`(nested open-platform), `inception/`, `full-boxed/`(github, Next+Supabase spawn-agent app), `fleetops/`(github Next dashboard).

## Full multi-origin map
Origins observed across estate: `git.open-platform.sh` (org `plat`, canonical) · `github.com/Trevato/open-platform` (legacy TS) · forgejo `platform/platform` (agentic-platform) · `10.0.0.47:3000/product-garden/*` (VXRail prod) · `forgejo.fluxing.test` (test) · `forgejo.127.0.0.1.sslip.io/platform` (local agentic).

A TS reimplementation must subsume: mitosis(replication+seed/SOPS), gitops(Flux manifests), mcp(26-tool surface), agents(dispatcher+prompts), _app-template, ci-builder, workflows(DBOS) — and can mine open-platform (op-api/console, ~43-tool REST+MCP) and agentic-platform (host-bridge model) as prior TS art.


══════════ ? ══════════
## Vercel AI SDK — research findings

**What it is / who builds it**: `vercel/ai` ("AI SDK") — open-source TypeScript toolkit for building LLM apps/agents, built by Vercel (creators of Next.js). 25.4k GitHub stars, extremely active (daily releases across ~15 sub-packages as of 2026-07-06). License: **Apache-2.0** (GitHub UI shows NOASSERTION but `packages/ai/package.json` explicitly states `"license": "Apache-2.0"`).

**Current version**: core `ai` package is at **7.0.16** (published 2026-07-06). Note this is post-v6; the major-version history is v3→v4→v5 (Jul 2025, big architectural rewrite)→v6→v7. Docs at ai-sdk.dev are versioned (`/v7/docs/...`). Monorepo ships many independently-versioned provider packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/xai`, etc.) plus framework bindings (`@ai-sdk/vue`, react, svelte) and a newer **`@ai-sdk/workflow`** package (1.0.16) for durable agents.
Source: [github.com/vercel/ai](https://github.com/vercel/ai), [AI SDK 5 blog](https://vercel.com/blog/ai-sdk-5), [AI SDK 6 blog](https://vercel.com/blog/ai-sdk-6).

**Core API pillars**:
- `generateText` / `streamText` — the two fundamental calls; same params (model, messages/prompt, optional `tools`, config), differ in sync-vs-streamed return. Streaming is native SSE (v5 dropped a custom protocol).
- Tools: as of v5, defined with `inputSchema`/`outputSchema` (zod) instead of the old `parameters`/`result`. A single call is one step by default; `stopWhen` turns it into a multi-step tool-calling loop.
- `Agent` / `ToolLoopAgent` class — OO wrapper around `generateText`'s loop; doesn't add new capability, purely ergonomic. Runs **in-memory**, so progress is lost on crash/timeout.
- `WorkflowAgent` (`@ai-sdk/workflow`, needs peer `workflow` pkg + `ai` + `zod`) — runs the agent loop inside Vercel's Workflow DevKit: each tool call marked `'use step'` becomes a durable, retryable, persisted step; supports `needsApproval: true` for human-in-the-loop that suspends across process restarts/days; full observability per step. Guidance: start with `ToolLoopAgent`, graduate to `WorkflowAgent` when tool calls outlive a request or need durable approval/retry.
Sources: [ai-sdk.dev/v7/docs/agents/workflow-agent](https://ai-sdk.dev/v7/docs/agents/workflow-agent), [github.com/vercel/workflow](https://github.com/vercel/workflow), [Vercel durable-execution blog](https://vercel.com/blog/a-new-programming-model-for-durable-execution).

**Provider abstraction**: unified `LanguageModelV2` spec (v5 rewrite) covers OpenAI, Anthropic, Google, Mistral, Cohere, Bedrock, Azure OpenAI, Fireworks, Groq, Perplexity, Together, xAI, and more — swap providers via one interface plus provider-specific `providerOptions`/metadata escape hatches. A "global provider" mode lets you reference a model by plain string ID, defaulting to Vercel's own AI Gateway (a hosted routing/billing layer — adds a soft dependency on a Vercel-hosted service if used, though direct-to-provider mode avoids it entirely).

**Runtime requirements**: pure ESM (`"type": "module"`), ships types + dist, tested against both Node and edge runtimes (`test:node` / `test:edge` scripts) — no framework lock-in despite Vercel authorship; works standalone in any Node/Bun/edge JS runtime. No native deps observed in package.json; zod is the schema dependency used throughout tools/workflow.

**Fit for Open Platform TS**: This maps directly onto the "AI layer" subsystem sitting behind the platform's existing agent-as-user identity + platform MCP tooling.
- Use `generateText`/`streamText` + tool-calling as the low-level model-agnostic layer platform agents call, with platform MCP tools registered as AI SDK `tools` (input/output schemas already zod-based, same ecosystem MCP tends to use).
- Use `ToolLoopAgent` for short-lived agent tasks (e.g., CI-triggered reseed/gate decisions) that must run inside a minute-scale CI job — fits the "boots/tests in under a minute" target since it's in-process, no extra infra.
- Use `WorkflowAgent`/`@ai-sdk/workflow` for longer-running platform operations that need durability across restarts and human approval gates (e.g., approving a daughter-platform spawn, a destructive migration) — conceptually parallel to Flux reconciliation loops the platform already has, but for agent steps instead of git state.
- Provider abstraction lets each hosted app or platform tenant bring its own model/key without SDK lock-in, satisfying self-hosting/ownership goals; must default to direct-provider mode (not Vercel AI Gateway) to avoid reintroducing a hosted dependency mitosis is trying to avoid.
- Browser: core AI SDK primitives (generateText/streamText, UI hooks) are lightweight and edge-tested, plausible for the "partially runs in the browser" goal for chat/agent UI; `@ai-sdk/workflow`'s durable-step model is server-side (needs the `workflow` runtime) and not a browser fit.

**Risks/pitfalls**: (1) fast-moving major-version churn (v5→v6→v7 within a year) — breaking API changes likely to continue, needs pinning + migration discipline; (2) Workflow DevKit is new/Vercel-hosted-adjacent — check how self-hostable its durable-execution runtime is outside Vercel's platform before depending on it for critical approval flows; (3) Apache-2.0 is compatible but confirm no incidental Vercel-hosted-service coupling (AI Gateway defaults) leaks into required paths; (4) heavy zod dependency — fine but adds a schema-validation opinion across the whole tool surface.

**Alternatives if it falls through**: **LangChain.js/LangGraph** (more mature agent-graph/durability story but heavier, more opinionated, slower cold start — conflicts with under-a-minute goal) or a **thin custom wrapper directly on provider SDKs** (OpenAI/Anthropic TS SDKs) — more control/minimal deps, but loses AI SDK's ready-made streaming UI hooks and multi-provider tool-call normalization, meaning platform would reinvent that layer.


══════════ ? ══════════
## Part 1: Missing input

The prompt references "the project below" as a candidate building block to research (with instructions to report on API surface, license, maturity, etc.), but no project name, link, or description was actually included before the "Article:" section — it appears to have been cut off. I did not fabricate a candidate; only the Vercel article was researchable. Flag this back to the user/parent for the missing project reference.

## Part 2: "Run any Dockerfile on Vercel" — findings

**What Vercel shipped**: Vercel now lets you deploy any Dockerfile (or Containerfile) directly to Vercel Functions as a first-class deployment unit, not a legacy/limited path. Drop a `Dockerfile.vercel` (or `Containerfile.vercel`) at project root; Vercel auto-detects it, builds the image, and wires a rewrite routing all traffic to it. No vercel.json config needed for the basic case — "everything around your Dockerfile is zero configuration."

**Mechanics**:
- Build happens on Vercel's own build image (Amazon Linux 2023 based), producing an OCI-compliant image.
- Image is pushed to **VCR (Vercel Container Registry)**, a new first-party registry Vercel introduced alongside this feature.
- The image is stored as an "optimized boot image" — a compressed disk snapshot tuned for fast cold start — then served as a **Vercel Function** running on **Fluid compute**.
- Fluid compute keeps warm instances alive and multiplexes many requests onto one running container instead of cold-starting per request, giving "responsiveness of a warm server, billing of one that sleeps when idle" (Active CPU pricing — you pay for CPU actually used, not wall-clock idle time).
- Runtime contract: the container must expose an HTTP server (default port 80, overridable via `PORT` env var). Functions are expected to be **stateless** — nothing persisted between calls — which is what allows horizontal instance add/remove and scale-to-zero.
- Scale-to-zero: no traffic for 5 min (prod) / 30s (preview) → scale down; on shutdown, container gets SIGTERM with a 30s grace period before force-kill.
- Because it rides on Vercel Functions, it inherits standard function limits (size, memory, execution duration) and gets preview deployments, instant rollbacks, logs/observability, and autoscaling "for free" — same platform primitives as a normal serverless function, just backed by an arbitrary container instead of a Vercel-native runtime.

**Design cues worth stealing for Open Platform TS**:
1. **Dockerfile as universal app contract** — instead of inventing a bespoke build spec per language, accept an OCI image/Dockerfile as the lowest-common-denominator interface. Any stack that can produce a container can onboard without custom buildpacks. This maps directly onto Open Platform TS's app-lifecycle subsystem: keep Dockerfile (or Containerfile) as the default app contract, with framework-specific fast paths (like Vercel's native Next.js builder) layered on top rather than required.
2. **Zero-config detection + convention-based file** (`Dockerfile.vercel`) — sniff for the file, no manifest needed to opt in. Lower the ceremony for "just deploy this repo."
3. **Registry as an internal platform primitive** — VCR (their own OCI registry) is the seam between build and run. For Open Platform TS this is a natural fit for an internal registry (or reuse of a lightweight OCI registry like zot/distribution) sitting between the CI build step and the Bun/Node runtime scheduler — mirrors the existing Forgejo/Flux/MinIO seam already in the platform.
4. **Stateless-by-contract + fast cold boot via a "boot image" snapshot** — rather than full container cold start, precompute a bootable snapshot. Relevant for a "boots in under a minute" goal: pre-warmed/snapshotted images could be key to hitting that target in CI.
5. **Uniform ops regardless of app shape** — preview URLs, rollbacks, logs, autoscaling all apply identically whether the app is native or a raw container. That decouples the "how do I build/run this app" question from the "how do I operate deployed instances" question — a good architectural boundary to replicate (build/package plugin vs. universal runtime/ops layer).
6. **Grace-period SIGTERM contract** — codify a shutdown contract (signal + timeout) as part of the platform's app contract from day one, since it affects both container apps and native ones uniformly.

**Risks/pitfalls to note**: exact image size/build-minute caps weren't disclosed in available sources (only "inherits standard function limits," unspecified numbers) — worth checking Vercel's `/docs/functions/limitations` and `/docs/functions/container-images` directly if precise numbers matter. Also: this is a proprietary Vercel feature (VCR, Fluid compute, boot-image snapshotting are Vercel-internal — not open source), so it's inspiration for design, not a reusable dependency.

Sources:
- [Run any Dockerfile on Vercel](https://vercel.com/blog/dockerfile-on-vercel)
- [Bring your Dockerfile to Vercel Functions (changelog)](https://vercel.com/changelog/bring-your-dockerfile-to-vercel-functions)
- [Container Images docs](https://vercel.com/docs/functions/container-images)
- [Introducing VCR: Vercel Container Registry](https://vercel.com/changelog/introducing-vcr-vercel-container-registry)
- [Does Vercel support Docker deployments? (KB)](https://vercel.com/kb/guide/does-vercel-support-docker-deployments)
- [Vercel Now Lets You Deploy Any Dockerfile Straight to Production — Cloud Native Now](https://cloudnativenow.com/features/vercel-now-lets-you-deploy-any-dockerfile-straight-to-production/)

Note: WebFetch was blocked in this sandbox for vercel.com/cloudnativenow.com domains ("unable to verify domain safety"); all findings above are reconstructed from WebSearch result snippets, not direct page fetches — treat exact limit numbers and phrasing as likely-but-not-verbatim-confirmed.


══════════ ? ══════════
# Landscape Survey: TS-Native Subsystems for Open Platform TS

## 1. Git hosting in TS
**isomorphic-git** (github.com/isomorphic-git/isomorphic-git) — pure JS git implementation, no native deps, runs in Node and browser. Mature: ~7k+ stars, active npm releases, used in production tools (VS Code web, StackBlitz-adjacent projects). Handles clone/fetch/push, packfiles, refs — full plumbing/porcelain, not just read.
**isomorphic-git/server** — a smart-HTTP git server built on isomorphic-git. Explicitly marked WIP on its README; thin, not a Forgejo replacement today. This is the biggest gap in the landscape: no mature TS smart-HTTP server exists. Realistic path is embedding isomorphic-git as the git *engine* and hand-rolling the smart-HTTP protocol handler (upload-pack/receive-pack over Express/Hono), rather than finding a drop-in server.
Fit: replace Forgejo's git-storage layer only; auth/permissions/UI would still need building. Confidence: likely (isomorphic-git itself proven; server layer unproven).

## 2. Embedded/instant Postgres
**PGlite** (electric-sql/pglite, pglite.dev) — Postgres compiled to WASM, packaged as a TS client, runs in Node/Bun/Deno/browser with zero external deps, 3MB gzipped, supports pgvector/PostGIS extensions. This is the standout candidate for "boots in CI under a minute."
Production readiness: mixed signal. Actively developed by ElectricSQL, has real adoption (Supabase-adjacent tooling, several dev-tool startups use it for local-first Postgres), but there are live platform-specific bugs — e.g. a reported crash on macOS 26 Tahoe/Apple Silicon at WASM engine init (garrytan/gbrain#1670) — indicating it's still maturing rather than battle-hardened for always-on server workloads. Best framed as ideal for CI, ephemeral daughter platforms, and browser-side demo mode; not yet a confident swap for CNPG in a durable multi-tenant prod deployment (no clear multi-connection/replication story — it's single-process/embedded by design).
**ElectricSQL** (sync engine, separate from PGlite) — pairs with PGlite for reactive sync; relevant if "partially run in the browser" needs live data sync between daughter platforms.
Fit: CI test fixtures, local dev, browser preview mode, and possibly the actual daughter-platform DB for lightweight instances. Confidence: likely for CI/dev use, possible for production.

## 3. S3-compatible storage embeddable in TS
No dominant embedded-S3-in-process solution found (unlike PGlite for Postgres). Options are thin abstraction layers, not embedded servers:
**flystorage** (duna-oss/flystorage) and **@tweedegolf/storage-abstraction** — adapter-pattern libraries giving one API over local fs, S3, GCS, etc. Good for making the platform storage-backend-agnostic (fs locally/in CI, real S3/MinIO in prod) but they don't provide an S3 *server*.
**Stratoscale/S3** — an actual Node.js server implementing the S3 protocol (older project, lower activity signal, worth checking staleness before relying on it).
Realistic approach: fs-based storage abstraction for CI/browser mode, MinIO (already used) or Cloudflare R2/S3 for prod — this subsystem has the weakest TS-native "embed and go" story of the seven. Confidence: possible only; needs deeper investigation before committing.

## 4. Auth/OIDC — becoming an SSO provider
**better-auth** (better-auth.com) — comprehensive TS auth framework, actively developed, has an **OIDC Provider plugin** (turn your app into a full OIDC/OAuth2 IdP — client registration, authorization code flow, JWKS endpoint) explicitly enabling "GitHub/Forgejo-as-SSO-provider" style use. Note: their docs say the OIDC provider plugin will be deprecated in favor of a newer **OAuth 2.1 Provider** plugin — check which is current before building on it. Also ships an SSO *client* plugin (OIDC/OAuth2/SAML2 consumption) for the inverse direction.
**oidc-provider** (panva) — long-standing, spec-rigorous, certified OIDC provider library; more mature/stable than better-auth's provider plugin but lower-level (no bundled user/session model).
**openauth** (sst) — newer, self-hostable auth server from the SST team, TS-native, designed to be the identity layer for infra-as-code-adjacent stacks — worth a closer look given SST's infra-tooling pedigree overlaps this project's audience.
Fit: this is the clearest strong-fit subsystem — better-auth or oidc-provider can directly replace Forgejo's role as SSO/identity provider for daughter platforms. Confidence: likely.

## 5. Running containers/processes from TS
**dockerode** — thin Node wrapper over Docker Remote API; stable, long-lived (@types/dockerode widely depended on), assumes a Docker daemon (or Podman socket) present.
**testcontainers-node** — higher-level, TS-native, actively maintained, explicitly supports Podman (daemonless-adjacent) alongside Docker; designed for ephemeral throwaway containers, which maps well to "spin up a daughter platform's build/test containers in CI."
No fully daemonless (no-Docker-at-all) TS runtime found — both options assume *some* OCI runtime is reachable. This is a real dependency-minimization tension against the "minimize dependencies" goal. Confidence: confirmed these are the standard picks; daemonless gap is real.

## 6/7. TS CI runners and gitops reconcilers
No mature TS-native CI job runner or GitOps reconciler-loop library surfaced — existing self-hosted-runner ecosystem (GitHub Actions runners, GitLab Runner, CircleCI runner) is Go/Ruby-based; reconciler-loop prior art (controller-runtime, reconcilerio/runtime) is exclusively Go/Kubernetes-API-shaped. **This is the biggest greenfield area**: Open Platform TS would likely need to author its own minimal reconciler loop (poll git state → diff → apply, using isomorphic-git + a simple job queue) and its own lightweight job runner (spawn via testcontainers/dockerode) rather than adopting existing prior art. Confidence: unknown/needs deeper investigation — may be worth a targeted search for niche projects (e.g., "kubernetes-client-node informers in TS" or Flux-adjacent JS ports) before concluding nothing exists.

**Overall gaps most worth flagging to the parent task:** (1) no TS smart-HTTP git server exists — build cost, not integration cost; (2) S3 embedding has no strong candidate; (3) CI runner + reconciler subsystems have essentially no TS prior art and are custom-build territory.


══════════ ? ══════════
Reconnaissance complete. Findings below (all paths under `/Users/trevato/projects/mitosis`; MCP/agents/gitops source extracted from `genesis/seed.tar.gz` git bundles).

## Repo shape
Thin bash+Nix wrapper: `bin/{up,germinate,seed,mitosis,lib.sh}`, `recipe/registries.yaml.tmpl`, `flake.nix`, `genesis/seed.tar.gz` (git bundles of 7 system repos + `manifest.yaml`). The actual platform is those repos: **gitops** (Flux desired state), **mcp** (control-plane API/TS), **agents** (autonomous build dispatcher/TS), **_app-template** (app scaffold+CI), **ci-builder** (CI toolchain image), **mitosis** (self-replication), **hello** (demo).

## 1. App create → deploy (end to end)
- Entry: Forgejo "Use this template" on `plat/_app-template`, or MCP `create_app` (`r-mcp/src/server.ts:1241`). Repo generated via `POST /repos/plat/_app-template/generate` under the **caller's Forgejo auth** (Forgejo enforces owner/org create-repo). App = Fastify5+TS(Node22), better-auth Forgejo SSO, CNPG-ready (`r-_app-template/src/{server,auth,migrate}.ts`).
- create_app then: sets `REGISTRY_TOKEN` actions secret, cuts `v0.1.0`, waits CI, find-or-creates Forgejo OAuth app (caller identity), renders gitops overlay (dormant until v1 ship).
- Build crew: `agents/src/dispatcher.ts` watches Forgejo **system webhook (HMAC-verified, RBAC-5) + sweep loop**; spawns claude subprocesses — **builder** (branch `prime`/PR), **reviewer** (browser QA sign-in w/ `QA_FORGEJO_USER`), **worker** (`agent-work` issue label). Reviewer pass → dispatcher auto-merges + `release_app`.
- CI: KEDA `ScaledJob` runner (`platform/forgejo/runner-scaledjob.yaml`, min0/max6, privileged dind sidecar, 2400s deadline) running `container: forgejo-http…:3000/plat/ci-builder:0.2.0` (**public image, pulled credential-less** — the reason ci-builder must stay public, `lib.sh:417`). Workflows: `check.yml` (lint/tsc/build/smoke on sidecar PG, all branches), `release.yml` (tag `v*`→docker build+push, `cosign sign` by digest, `helm push` chart to `oci://…/<owner>/charts/<app>`), `preview.yml` (PR open/sync→build+`preview-cli create`; close→teardown), `sync-env.yml`.
- Registry: in-cluster Forgejo OCI registry (`forgejo-http…:3000`), node-local mirror `127.0.0.1:31100` (`platform/registry-node-config`).
- Overlay (writer `overlayManifests()` `server.ts:2569`) writes `clusters/local/apps/<owner>/<name>/<env>/`: `manifests.yaml` (Namespace `<owner>--<name>--<env>`, Certificate, **OCIRepository+HelmRelease** pulling chart w/ `forgejo-registry` secret, Ingress, DB/bucket blocks) + sops-sealed `{app-auth,pull,plat-ca,app-s3,app-user-env}-secret.yaml` + `kustomization.yaml`; registered in `apps/kustomization.yaml`. Flux `GitRepository flux-system`→Kustomizations `platform` (sops-decrypt) + `apps`, interval 1m. Prod stays **dormant** until `release_app`→`promoteProdTag` registers prod + pins tag (fresh DB, never template schema; `server.ts:1474`).

## 2. Domains / TLS / ingress / forwardAuth
- Host: `resolveAppHost` — repo.website → org.website → default `<name>-<owner>.<APPS_DOMAIN>` (`APPS_DOMAIN`=`FORGEJO_BASE_PUBLIC` minus `git.`). BYOD registry `clusters/local/domains.yaml` (`add_domain` TXT challenge → `verify_domain` DNS → `set_app_domain`/`set_org_domain`).
- TLS: per-app cert-manager `Certificate` dnsName=host; issuer `plat-local-ca-issuer` (platform hosts) or `letsencrypt-dns01` (BYOD, Cloudflare DNS-01, inert without token). Traefik `ingressClassName`, entrypoints web/websecure; `coredns-custom` rewrites `*.$DOMAIN→traefik`.
- forwardAuth (RBAC-2, **default-off** `PLAT_FORWARD_AUTH=1`): middlewares `plat-strip` (clears client `X-Plat-*`) + `plat-access` (forwardAuth→`plat-auth.mcp.svc/forward?owner&repo`). `plat-auth` (`r-mcp/src/auth-service.ts`) reads sealed session cookie, runs Forgejo repo-permission probe, `decideAccess` 4-tier (anon+public→200 / else 302; logged-in none+private→403; read+→allow; write+→manage), injects `X-Plat-User/Perm/Manage`.

## 3. Per-app Postgres / MinIO
- CNPG (`database:true`): `Cluster <name>-pg` (1 inst, 1Gi local-path, PG18, initdb db/owner=`<name>`) + allow-ingress/egress-postgres netpols. CNPG auto-generates `<name>-pg-app` secret; chart `envFrom`s it. `query_db` (`r-mcp/src/tools/data.ts`) execs into primary as **non-superuser app role**, read-only txn guard.
- MinIO (`bucket:true`): `provisionBucket` (`server.ts:3142`) uses `mc` as root: `mb app--<owner>--<name>--<env>`, scoped policy (`s3:*` that bucket only) on user `app--<owner>--<name>`; sealed `<name>-s3` secret; `allow-egress-bucket` netpol→`plat-storage:9000`. CNPG nightly dumps to MinIO `cnpg-backups` via scoped `cnpg-backup` user (`plat-storage/cnpg-backup-setup-job.yaml`).

## 4. Secrets model
sops+age; `.sops.yaml` encrypts `^(data|stringData)$` on `clusters/**.yaml` to one age recipient. Flux `sops-age` secret decrypts. MCP holds only the **public** key → seals new overlay secrets in place, preserves already-committed ones verbatim. User secrets: `sync-env.yml`→`secrets-cli` reads write-only Forgejo Actions secrets, seals `<app>-user-env` (prod runtime); `PLAT_DEV` variable names dev-shared keys → separate dev store injected into agent env, kept out of prod (`prod vs dev` split).

## 5. RBAC / multitenancy
Forgejo orgs/teams = tenancy root. MCP `authorize()` (`server.ts:982`): owner-scoped tools require caller==owner/org-member; repo tools use delegated Forgejo permission probe (fail-closed); admin bypass. **Agent scoped identity**: dispatcher (admin PAT) mints run-scoped MCP token (`mint_agent_token`, `token.ts`) pinned to one `(owner,name)`, `AGENT_TOOLS` whitelist, checked before admin bypass, forbids workflow-file edits; per-run **SSH deploy key** for clone/push (admin PAT never enters a run, #16); `protect_workflows` branch-protection glob blocks non-admin workflow writes; RBAC-4 per-app `agent-ctx` SA (namespaced read-only Role, no secrets) via TokenRequest.

## 6. Policy (Kyverno, all Audit-first, failurePolicy Ignore)
POL-1 `restrict-image-registries` (`git.*/*|127.0.0.1:31100/*`), `disallow-privileged-hostpath`, `require-resource-limits`. POL-2 **generate** policies (`plat-ns-{network,resource,dos}-governance`, `synchronize:true`) self-heal default-deny NetworkPolicies+ResourceQuota+LimitRange onto `plat.sh/app` namespaces. POL-3 `verify-image-provenance` cosign `verifyImages` vs platform pubkey (keyed, no Rekor; `cosign-signing-key.yaml` placeholder). POL-4 `disallow-unmanaged-secrets`, `require-registered-ingress-host`. POL-5 `require-forwardauth-on-app-ingress`, `no-admin-clusterrole-binding`, `agent-runs-use-scoped-role`.

## 7. Decommission
`delete_app` (`server.ts:4125`): delete Forgejo OAuth apps → remove overlay dir + kustomization entries (commit/push) → **directly delete app namespace** (Flux prune OFF → cascades to Deployment/Service/CNPG+PVC/Ingress/Secrets) for prod+dev; Forgejo repo kept unless `force_repo`. Preview: `preview-cli delete` on PR close.

## Minimal primitives a reimplementation must preserve
1. **Git+identity control plane**: orgs/teams RBAC, OAuth apps, PATs, CI Actions, OCI image+chart registry, webhooks, template repos, branch protection.
2. **Desired-state store + reconciler**: per-app overlay (ns + HelmRelease/OCIRepository + Ingress + Certificate + sealed secrets) registered in a kustomization; 1-min reconcile; dormant-until-release promotion.
3. **Sovereign-key secret sealing** (encrypt-at-rest, regenerate-on-fork, reconciler-decrypt).
4. **Tenant namespace model** `<owner>--<name>--<env>` + default-deny netpols + PSA restricted + quota.
5. **Per-app data provisioning**: CNPG cluster+auto-secret; object-store bucket+scoped user; nightly backup.
6. **Host resolution + per-host TLS + ingress + forwardAuth SSO** (git-permission→header injection).
7. **Mediating API (MCP)**: every mutation authorized against git permissions; ephemeral **scoped** agent credentials (MCP token + SSH deploy key + K8s TokenRequest).
8. **Policy engine** (admission + generate) for registry/provenance/isolation/secret governance.
9. **Autonomous dispatcher** (webhook+label driven builder/reviewer/worker; auto-merge/release).

**Identified bloat / not-load-bearing**: forwardAuth, FQDN egress, agent-ctx RBAC all **default-off**; every Kyverno policy is Audit-only (never enforced); cosign key is placeholder (provenance inert); `workflows` service partly stubbed (`cancel_workflow` is a stub, `server.ts:5495`); germinate carries MTU/`ALLOW_LOCALNETWORKS` shims and 3-tier mitosis-fork fallback; letsencrypt issuer inert without token.
