# Open Platform

One Bun process that is a complete software platform: your own git hosting,
identity (OIDC), CI, app deployment, data, and an AI build crew — and the
platform can reproduce. `op seed` exports a genome; `op germinate` grows a
**sovereign** daughter platform (fresh keys, fresh secrets, its own identity)
in seconds. Lineage is recorded; parents can never read children.

The whole loop — boot → create user → push a Dockerfile app → build → run →
serve → snapshot data → seed → germinate a daughter → daughter does it all
again — is proven by one CI test in **under a minute**.

## Quickstart

```sh
op up                 # boot a platform on *.localtest.me, print your card
```

The card prints an admin password and a first-app `curl`. Open the console at
the platform URL, name an app, and it ships in seconds. Then describe a feature
and the build crew grows it.

To hand a whole platform to someone else:

```sh
op seed my-platform.tar.gz     # export a genome
op germinate my-platform.tar.gz other.example.com   # they grow a sovereign copy
```

## The build crew — describe it, and it ships

File an issue on an app with the `agent-work` label (or just type a feature into
the console — a fast model drafts a well-formed spec you edit and confirm). Then,
with no further input:

1. A **builder** agent runs inside a throwaway, locked-down container — non-root,
   cap-dropped, read-only rootfs, no host access, no platform credentials — and
   writes the feature (parameterized SQL, escaped output, auth-gated, idempotent
   migrations), opens a PR, and a **preview** comes up on a copy-on-write clone
   of production data.
2. A **reviewer** agent adversarially tests that live preview — unauthenticated
   access, SQL injection, XSS, IDOR, bad input — and emits one verdict line.
3. On a pass it **auto-merges** and ships to production; on a fail it leaves the
   PR for a human. You watch the whole thing stream in the console.

The container is the security boundary, so the agent runs with full autonomy
inside it while reaching nothing outside. See `docs/build-crew-ideas.md` for
ready-to-file issue ideas.

## Console

A server-rendered, dependency-free console (zero UI frameworks, strict CSP,
inlined everything) with three themes, breadcrumbs everywhere, a live crew-status
pill, and an ai-elements-style activity feed that renders each agent's tool calls,
narration, and verdict as it works. Responsive from phone to ultrawide.

## Substrate

`bun` + `git` + a Docker-Engine-API socket. Nothing else. (The build crew also
needs the `claude` CLI and a `CLAUDE_CODE_OAUTH_TOKEN`; without it the platform
runs fine and the crew simply stays idle.)

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

## License

MIT — see [LICENSE](LICENSE).
