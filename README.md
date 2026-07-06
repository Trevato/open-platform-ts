# Open Platform

One Bun process that is a complete software platform: your own git hosting,
identity (OIDC), CI, app deployment, data, and an AI build crew — and the
platform can reproduce. `op seed` exports a genome; `op germinate` grows a
**sovereign** daughter platform (fresh keys, fresh secrets, its own identity)
in seconds. Lineage is recorded; parents can never read children.

The whole loop — boot → create user → push a Dockerfile app → build → run →
serve → snapshot data → seed → germinate a daughter → daughter does it all
again — is proven by one CI test in **under a minute**.

## Substrate

`bun` + `git` + a Docker-Engine-API socket. Nothing else.

## Principles

- **Standards, not adapters.** One implementation per subsystem; portability
  comes from git's wire protocol, OCI/Dockerfile, the SQLite file format, the
  S3 API, OIDC, HTTP/TLS/ACME — never from interface indirection.
- **Desired state lives in git**, inside the system that reconciles it.
  A push _is_ an event; there is no polling gap to race.
- **Policy is enforced or the mutation never happened.** No audit mode exists.
- **One sovereign key seals everything.** Minted at germination, never shared,
  no escrow. Lose the key, lose the platform — that SPOF is the price of
  sovereignty, by design.
- **Data is a directory.** Each app gets `app.db` (SQLite) + `files/` (served
  over the S3 API), snapshotted, branched, and restored as files.

See `docs/plan.md` for the build plan and `docs/design/` for the research and
architecture dossiers behind every decision.
