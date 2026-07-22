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

You need [Bun](https://bun.sh) and a reachable Docker socket. Then, zero install:

```sh
bunx open-platform-ts up      # boot a platform on *.localtest.me, print your card
```

That serves on ports **80/443** by default. If those are taken (a dev proxy, an
ssh tunnel), pick your own — the card prints the URL it actually bound:

```sh
HTTP_PORT=8080 HTTPS_PORT=8443 bunx open-platform-ts up
# → console at https://plat.localtest.me:8443, public docs at /docs
```

The card prints an admin password and a first-app `curl`. Open the console at
the platform URL, name an app, and it ships in seconds. Then describe a feature
and the build crew grows it. (`bunx open-platform-ts <cmd>` runs any command;
`bun add -g open-platform-ts` installs it as `op` if you'd rather type `op up`.)

Everything a platform is lives in one directory — `~/.op/<domain>` by default.
A second platform is just a second domain (`DOMAIN=lab.localtest.me` plus its
own ports); a fresh start is `rm -rf ~/.op/plat.localtest.me` and `up` again.

To hand a whole platform to someone else:

```sh
bunx open-platform-ts seed my-platform.tar.gz     # export a genome
# they grow a sovereign copy:
SEED=my-platform.tar.gz DOMAIN=other.example.com bunx open-platform-ts germinate
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

## Docs — a manual that can't lie, and an agent that reads it

The platform documents itself. `/docs` is a three-pane reading surface (grouped
nav, scroll-spy TOC, ⌘K search) rendered from markdown that lives in
`plat/platform` — so a merged commit updates the manual live, and a germinated
daughter is born documented. Every code reference in the docs (like
`packages/opd/src/api.ts:205`) links into the platform's own hosted source, and
a CI checker (`test/docs.test.ts`) fails the build if any reference names a file
or line that no longer exists — documentation that drifts can't merge. Pages are
also served raw at `/docs/<page>.md`, `/docs/llms.txt`, and `/docs/search.json`
for agents.

One of those agents is built in: **✦ Ask** opens a guide that has read the manual
and can see your running platform — read-only, and only what you could see
(every tool authorizes through the same forge checks as the API). It searches
the docs, inspects your apps, logs, work items, and the platform's own source,
and cites the pages it used. Needs a `CLAUDE_CODE_OAUTH_TOKEN`; without one the
docs still read fine and the button simply isn't there.

## Apps declare what they need — `op.json`

Beside its Dockerfile, an app may carry an `op.json` manifest: memory/cpu,
raw TCP ports (a Minecraft server's 25565 gets a sticky public port relayed
by the gate), assets the platform fetches into `/data` before start
(sha256-pinned, host-allowlisted), and `provides`/`consumes` peer
declarations. Peers wire by derivation — `OP_PEER_<APP>_URL` env plus
`peerFetch` in the template, with app-to-app tokens whose audience dies at
the gate (`x-plat-user: app:owner/app` upstream). The platform derives an
**integration map** from repo heads (`/api/v1/integration-map`, console →
Integrations); nothing is registered, so nothing goes stale. Everything is
bounded by operator policy in `plat/platform`'s `platform.json` and admitted
fail-closed.

## The platform edits itself

Every boot publishes the platform's own source into a repo it hosts,
`plat/opd` — from a checkout via `git archive`, from an npm install via a
source tarball shipped in the package. The console's **Platform** page shows
three cards — Source (`plat/opd`), Config (`plat/platform`), and Template
(`plat/app-template`) — and filing an issue on any of them runs the same crew
loop, pointed at the platform: the composer drafts against the right contract
(daemon monorepo, config repo, or app template — not a single-file app), a
`platform-dev` agent writes the change, and the branch **parks for a human
merge** — the platform's own repos never auto-merge. A config merge
hot-reloads live; a source merge re-execs the daemon under a supervised boot
(`OP_SRC=<clone> op up`), with automatic rollback if the new daemon dies. An
agent handed mis-scoped work declines with an explanation instead of
guessing. See `/docs/self-source` on your platform.

## Work items — the development process

Issues and pull requests collapsed into one unit: a **work item** is intent +
at most one change + an append-only attempts ledger. One lifecycle (intent →
queued → building → reviewing ⇄ reworking → shipped | parked), enforced as a
legal-edge phase machine in the store — an illegal transition never happened.
The crew's rework survives restarts, reviewers remember prior verdicts, and a
human-pushed branch enters the same adversarial review machinery as crew code.
`docs/design/04-work-items.md` holds the full design.

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
- **Data is a directory.** Each app gets `app.db` (SQLite) + `files/` for
  blobs, snapshotted, branched, and restored as files. (An S3-subset API over
  `files/` is planned — see `docs/plan.md`.)

See `docs/plan.md` for the build plan and `docs/design/` for the research and
architecture dossiers behind every decision.

## License

MIT — see [LICENSE](LICENSE).
