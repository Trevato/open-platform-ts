---
title: How the docs work
description: The manual is part of the platform — versioned in git, verified against the code, readable by agents.
---

These pages are markdown files in your platform's own config repo,
`plat/platform`, under `docs/`. The console renders them straight from git at
`main` (`packages/opd/src/console/docs.ts:84`), the same way it reads crew
prompts — so merging a change to that repo updates the manual instantly, with
no restart, and a seeded daughter platform is born carrying the same docs.

If the config repo has no docs tree (say, a platform grown from an old seed),
the console falls back to the copy in the platform's source checkout
(`packages/opd/src/console/docs.ts:92`). You always have a manual.

## Truthful by construction

Docs rot when nothing holds them to the code. Two mechanisms hold these:

- **Code references are links.** Inline code that names a repo path — like
  `packages/opd/src/platform.ts:339` — is recognized by one shared grammar
  (`packages/opd/src/console/md.ts:55`) and linked into the platform's own
  hosted source with the exact lines highlighted. Docs never point at an
  external mirror; they point at the code your platform is running from.
- **CI rejects drift.** A checker test walks every page, extracts every code
  reference, and fails the build if the file doesn't exist or the named line
  is out of range (`test/docs.test.ts`). Internal links must resolve to real
  pages, and every page must carry a title and description. Documentation
  that lies cannot merge.

## Editing the docs

Docs are code. Edit them like code:

```sh title="Terminal"
git clone https://<your-domain>/plat/platform.git
# edit docs/<page>.md, or add a page and list it in docs/docs.json
git commit -am "docs: explain the thing" && git push
```

Changes to `plat/platform` are proposed to a human — the crew never
auto-merges the platform's own repos. You can also file an issue on the
**Platform** page and let the crew draft the edit for you.

Each page starts with two frontmatter lines the build enforces:

```md title="docs/my-page.md"
---
title: My page
description: One sentence that earns the click.
---
```

## Docs for machines

Every surface a human reads here is also served raw, for agents — including
the platform's own guide:

| URL                 | What you get                             |
| ------------------- | ---------------------------------------- |
| `/docs/<page>.md`   | one page as raw markdown                 |
| `/docs/llms.txt`    | an index of every page with descriptions |
| `/docs/search.json` | the search index the `⌘K` palette uses   |

The **Copy page** button on every page copies the raw markdown — paste a page
into any model and it carries its own title, description, and code
references.

## Ask the guide

The **✦ Ask** button in the header opens the guide: an agent that has read
this manual and can see your platform — read-only, and only what _you_ can
see. Every tool it holds authorizes through the same forge checks as the API
routes (`packages/opd/src/crew/guide.ts:102`), so it can inspect your apps,
deploy events, logs, work items, the integration map, and the platform's own
source, but it can never act and never show you another user's data.

Ask it anything from "why is my app red?" to "how do previews get their
data?" — it searches these pages first, checks your live state when the
question is about your platform, reads the source when you ask how something
is implemented, and cites what it used as links under the answer.

The guide streams over `POST /api/v1/guide` (`packages/opd/src/api.ts:1020`);
the conversation lives in your browser session and nothing persists
server-side. Its instructions are a crew role like any other —
`crew/guide/instructions.md` in `plat/platform`, hot-editable
(`packages/opd/src/crew/guide.ts:94`) — and it runs on the crew's model and
credential, so it needs the same `CLAUDE_CODE_OAUTH_TOKEN` as the
[crew](/docs/crew). Without one, the button simply isn't there.
