# Build-crew seed content + the issue-composer

Raw material for filling a platform with live crew activity, and the design for
turning "file an issue" into "approve a compiled spec." Every issue below is
shaped for the caged builder (single-file `server.ts`, `bun:sqlite`, `PORT`,
OIDC) and phrased so the adversary reviewer has something concrete to attack —
the safety line in each spec is the reviewer's checklist.

File any of these from an app's **Issues** box with the `agent-work` label and
watch the crew build → review → ship it.

## Curated issue ideas

### guestbook

- **Add a signed guestbook entry form** — Persist `{name, message, at}` to
  sqlite and render newest-first. Gate the POST behind the session check, bind
  every value as a `?` parameter, and `escapeHtml` the message.
- **Show an entry count and relative timestamps** _(5-min)_ — A `COUNT(*)`
  header and an "N minutes ago" render. Read-only; no unescaped output.
- **Let a signed-in user delete only their own entries** _(meaty)_ — A delete
  button that `DELETE … WHERE id = ? AND owner = ?` keyed on the session user.
  Cross-user deletes must 403 — the IDOR the reviewer will probe.

### todo

- **Add a per-user todo list** — Rows scoped to the signed-in user; every read
  and write filters on the session identity with bound params.
- **Toggle a todo complete with an optimistic checkbox** _(5-min)_ — POST a
  status flip, update the row idempotently, validate the id is an owned integer.
- **Filter by active / completed / all via `?state=`** _(5-min)_ — Validate
  `state` against a fixed enum; reject anything else with a clean 400.

### bookmarks

- **Save a URL bookmark with a title** — Reject any scheme that isn't `http(s)`
  with a 4xx, `escapeHtml` the title, auth-gate the save, bind the URL.
- **Tag chips + filter bookmarks by tag** _(meaty)_ — Tags rendered as chips,
  filtered with a bound `WHERE tag = ?`. Escape tag text — the reviewer submits
  `"><img src=x onerror=alert(1)>` as a tag.
- **Export my bookmarks as JSON** _(5-min)_ — Honor `Accept: application/json`,
  return only the caller's own rows, keep the HTML view unchanged.

### notes

- **Full-text search over my notes** _(meaty)_ — sqlite FTS5 (or `LIKE ?` with
  a bound parameter), scoped to the signed-in user, results escaped on render.
- **Autosave a note draft** — Debounced upsert on `INSERT … ON CONFLICT` keyed
  on `(owner, note_id)`; idempotent migration (preview runs on cloned prod data).
- **Render note bodies as safe Markdown** _(meaty — flagship XSS demo)_ — A
  minimal subset (bold/italic/code/links) rendered server-side, but `escapeHtml`
  first so raw `<script>`/`onerror` can never survive. The best "watch the
  reviewer try to break it" showcase.

### the platform itself

- **Live "crew status" pill in the header** — Poll a cheap count endpoint and
  show `● 2 agents working` / `● crew idle`; server-rendered, inline JS, no deps.
- **Keyboard-operable "copy clone URL" control** — A real `<button>` with an
  `aria-live` toast; no external assets.

## PR one-liners (small, self-contained)

- `console: escape the title attribute on truncated timeline messages`
- `console: pause dashboard polling while document.hidden`
- `console: add aria-live="polite" to the toast for screen readers`
- `console: make the clone-URL copy affordance a real <button>`
- `console: color PR diff lines (+/−) with .diff-add/.diff-del, zero deps`
- `console: replace the 600ms post-create redirect with a poll until ready`

## The "curating not building" issue-composer

An under-the-hood fast agent that turns a rough one-liner into a well-formed
issue. The human edits a **draft of the real object**, not a chat reply.

**API.** A sibling to the issues route, same `forge.authenticate` gate:

```
POST /api/v1/repos/:o/:r/issues/draft   { idea: string }
  → 200 { title, body, labels, acceptanceChecks }   // composes, never writes
  → 503 { error: "composer_offline" }                // degrade signal
```

The console then files via the **existing** `POST …/issues`.

**Model.** `claude-haiku-4-5`, run through the same `claude` CLI the crew uses
(the OAuth token only works via the CLI, never the raw Messages API) with no
tools — a pure text→JSON transform, no sandbox needed. Sub-2s; a skeleton
covers it.

**Prompt.** _"You are the platform's issue composer. Turn a rough one-line idea
into a crisp issue for a caged AI builder that implements it in a single-file
Bun + bun:sqlite app. Emit an imperative title (≤60 chars); a 2–4 sentence body;
labels from the allowed set; 3–6 acceptance checks the adversary reviewer can
verify over HTTP. ALWAYS fold in the safety contract: parameterized SQL only,
escape user text, auth-gate every data path, keep OIDC + the JSON/HTML contract
working, idempotent migrations on cloned prod data."_

**UX.** Rough box labeled **"What do you need?"** → on submit the textarea
disables and a 3-line skeleton ("structuring this…") occupies the exact slot →
the draft returns as an **editable structured card**: title input, spec textarea
prefilled with acceptance bullets, inferred label chips. Primary flips to **File
issue**; secondary **Rewrite** returns the rough text. On file → existing issues
route with `agent-work` → optimistic row + crew-pill increments.

**Degrade.** On any error / >4s deadline / no key → `503`, and the console
silently falls back to the plain box with the idea prefilled, toasting _"composer
offline — filing as-is."_ Filing is never blocked on the agent.
