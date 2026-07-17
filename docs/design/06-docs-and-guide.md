# 06 — Docs & the Guide

The platform documents itself: a manual served by the console, written as
markdown in the platform's own config repo, verified against the source it
describes, and fronted by an in-app agent that reads the docs _and_ the
user's live platform.

## Where docs live

`genesis/platform/docs/**.md` + `docs.json` (the nav manifest). Genesis seeds
them into `plat/platform` beside the crew prompts, so:

- **Served from git at `main`** — the console reads pages the same way
  `PlatformConfig.loadAgent` reads crew prompts, falling back to the genesis
  dir on disk when the repo read fails (fail-open to last-good, the
  PlatformConfig convention).
- **Hot-editable in-platform** — a merged change to `plat/platform` updates
  the docs with no restart. Self-repo changes are proposed to a human, never
  auto-merged, so live doc edits pass a human gate.
- **Inherited by daughters** — `plat/platform` ships in the seed, so a
  germinated platform is born documented.

A `DocsSource` caches the parsed tree keyed on the repo's `main` sha: one
`rev-parse` per request, full re-read only on change.

## Truthful by construction

Docs reference code as plain inline code — `` `packages/opd/src/api.ts:159` ``
— no link ceremony. Two mechanisms keep every reference honest:

1. **The renderer auto-links** any inline code matching the repo-path grammar
   to the platform's own hosted source (`/apps/plat/opd/blob/main/<path>#L<n>`)
   when `plat/opd` exists; otherwise it renders as plain code. Docs never
   point at GitHub — the platform holds its own truth.
2. **A checker test** (`test/docs.test.ts`) extracts every code reference from
   every doc page and fails CI if the path doesn't exist, the line number
   exceeds the file, or a `path:line` reference names a line whose
   neighborhood no longer contains the identifier the doc claims. Docs that
   drift fail the build — they are code.

A minimal **blob viewer** (`/apps/:owner/:app/blob/:ref/*path`) renders any
readable repo file with line numbers and `#L<n>` anchors — the console's
missing source browser, and the docs' link target.

## The reading surface

`/docs` and `/docs/:slug` in the console router, public-read (product docs
carry no secrets; the header shows "Sign in" to anonymous readers). Layout is
the three-pane docs idiom on the existing token system: groups sidebar (left),
~72ch prose column, "On this page" scroll-spied TOC (right); the sidebar
becomes a drawer and the TOC folds away on small screens. Client-side search
over a server-built index (title + headings + first lines), opened with ⌘K.
Prev/next at the foot of every page. No new dependencies, strict CSP intact.

## The Guide

A chat agent that has read the manual and can see the user's platform.

- **Endpoint** `POST /api/v1/guide` — SSE, same streaming shape as the
  composer's draft endpoint (`thinking` → text deltas → done), plus `tool`
  events the UI renders as the crew feed renders tool calls.
- **Brain** — the Agent SDK `query()` in-process (the OAuth token works only
  via SDK/CLI), model from `crew.model`, `OP_GUIDE_MODEL` override.
- **Instructions** — `crew/guide/instructions.md` in `plat/platform`,
  hot-editable like every crew role, loaded via `loadAgent("guide")`.
- **Hands** — an in-process MCP server (`createSdkMcpServer`) of **read-only**
  tools closed over the authenticated user, authorization enforced per call
  through the forge exactly as the API routes enforce it: docs search/read,
  apps + statuses, work items, deploy events, build/runtime logs,
  integration map, and platform source reads. The guide sees exactly what the
  asking user could see — nothing more.
- **Citations** — instructed to cite `/docs/<slug>` pages it drew from; the
  UI renders them as links.
- **Surface** — a dock button in the console header; a panel that is a
  right-hand sheet on desktop and a bottom sheet on phones. History lives in
  `sessionStorage`; nothing persists server-side.

## Non-goals

- No WYSIWYG editing; docs are md in git, edited like code.
- No server-side chat persistence; a conversation is a browser session.
- No write tools on the guide — it explains and diagnoses; the crew builds.
