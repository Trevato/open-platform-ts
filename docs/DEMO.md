# Demo: invent a business, build it, sell it

The whole July-2026 story in one runnable walkthrough. It uses a made-up
business — **Loom**, a tiny "shared reading list" SaaS — to show orgs, the
Sonnet-5 crew, GitHub import, and app-level migration. Every step here is also
proven non-interactively by a test (named inline).

Prereqs: `op up` works, Docker is running. For the crew steps, set
`CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token`); without it the platform
still stands the repo up and files the crew's work — it just waits to build.

## 1. Boot your platform

```sh
op up
```

Open the console at the printed URL, sign in with the admin password on the card.

## 2. Create the business as an org

Console → **Orgs → Create org** → `loom` (display name "Loom"). The org page is
where you _visualize the software of the business_: every app and repo it owns,
its members, in one place. Right now it's empty.

_Proven by:_ `bun test test/console.e2e.test.ts` (creates an org, an org-owned
app, and renders the org overview).

## 3. Stand up software — build it, or import it

**Build from scratch:** on the org page, **Create app in loom** → `readlist`.
It ships in seconds from the template. Then describe a feature in the app's
composer ("a shared reading list where members add book URLs and mark them
read") and the **Sonnet-5 crew** drafts → builds → adversarially reviews →
ships it.

**Or import an existing repo:** Apps page → **Import from GitHub** → paste a repo
URL. The platform clones it into its own git host and the `importer` crew role
(also Sonnet 5) tunes it to platform conventions — a Dockerfile serving `$PORT`,
data under `$DATA_DIR` — then the normal preview → review → merge pipeline ships
it.

_Proven by:_ crew model wiring — `bun test packages/opd/test/platform-config.test.ts`;
import clone path — `bun test packages/git/test/githost.test.ts`.

## 4. Break work into dependent issues (optional)

File "add cart" and "ship checkout"; on checkout, set **blocked by** the cart
issue. The crew won't start checkout until cart ships — the console shows a
`blocked by #N` pill and the dispatcher honors the DAG (cycles are rejected).

_Proven by:_ `bun test packages/forge/test/issue-deps.test.ts`.

## 5. Sell it: export the app, the client ingests it themselves

You built `loom/readlist` and a client wants to run it on **their own**
sovereign platform. Hand them a single artifact:

```sh
op app export loom/readlist readlist.tar.gz
```

The artifact carries the repo (full history), a verified data snapshot, and the
app.json — **no keys, no platform secrets** (the OIDC client and app secret are
re-minted on the client at deploy). Send them the file. On _their_ platform:

```sh
op app import readlist.tar.gz            # keep the name, or remap:
op app import readlist.tar.gz acme/readlist
op up                                    # they serve it, with your data intact
```

_Proven by:_ `bun test test/migration.e2e.test.ts` — a seller platform ships an
app, accumulates real data, exports it; a **separate** platform (different
sovereign key) imports it and serves it with the data continuing, not reset.

## What this proves

One Bun process is a business-in-a-box: create the org, let a small fast model
(Sonnet 5) build the software, and move a finished app between sovereign
platforms as a file. No shared control plane, no vendor in the middle —
git bundles + a verified data snapshot + a JSON spec.
