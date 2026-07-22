---
title: HTTP API
description: Every /api/v1 route — method, path, auth, and purpose — verified against the source.
---

The platform serves a JSON API under `/api/v1` on the platform host — the
same surface the console uses, so anything you can click you can script. One
handler answers it, ahead of OIDC and the console in the router chain
(`packages/opd/src/platform.ts:425-427`). Requests that match no route fall through;
errors come back as `{"error": "..."}` with a conventional status code.

## Authentication

Every request passes through one resolver
(`packages/forge/src/forge.ts:117`). Three credentials work:

- **Basic auth** — `username:password`, or a personal access token in the
  password slot.
- **Bearer token** — a personal access token in the `Authorization` header.
- **Session cookie** — the console's `op_session` cookie; the API and the
  console share sessions.

```sh title="Terminal"
curl -sk -u plat:<password> https://plat.localtest.me/api/v1/apps
```

The **auth** column below uses four values: `public` (no credential),
`user` (any signed-in user; the forge may check more), `read` / `write`
(that permission on the named repo or app), and `write (owner)` (membership
in the owning user or org).

## Health and discovery

| Method | Path                             | Auth   | Purpose                                                        |
| ------ | -------------------------------- | ------ | -------------------------------------------------------------- |
| GET    | `/healthz`                       | public | Liveness: `{ok, domain}`                                       |
| GET    | `/api/v1/integration-map?owner=` | public | The derived app graph — see [Connect apps](/docs/connect-apps) |

`/healthz` is answered by the API router even though it sits outside
`/api/v1` (`packages/opd/src/api.ts:213`). The integration map is
deliberately public: running apps poll it as runtime discovery
(`packages/opd/src/api.ts:217`).

## Apps

Creation routes (`packages/opd/src/api.ts:231`):

| Method | Path                  | Auth          | Purpose                                                                                         |
| ------ | --------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/apps`        | write (owner) | Create `{name, owner?}` from the template; 201 with `cloneUrl`                                  |
| POST   | `/api/v1/onramp`      | write (owner) | `{description, owner?, name?}` → named app + first queued build (`packages/opd/src/api.ts:304`) |
| POST   | `/api/v1/apps/import` | write (owner) | `{url, owner?, name?}` — clone an external repo as an app (`packages/opd/src/api.ts:394`)       |

Read routes (`packages/opd/src/api.ts:1112`):

| Method | Path                                 | Auth   | Purpose                                           |
| ------ | ------------------------------------ | ------ | ------------------------------------------------- |
| GET    | `/api/v1/apps`                       | user   | All apps: desired state overlaid with observed    |
| GET    | `/api/v1/apps/:owner/:app`           | public | One app's status row and host                     |
| GET    | `/api/v1/apps/:owner/:app/events`    | read   | Deploy timeline, newest first                     |
| GET    | `/api/v1/apps/:owner/:app/buildlog`  | read   | Last build's output, `text/plain`                 |
| GET    | `/api/v1/apps/:owner/:app/logs`      | read   | Tail (200 lines) of the running container         |
| POST   | `/api/v1/apps/:owner/:app/snapshots` | write  | Checkpoint, clone, verify; 201 `{id}`             |
| GET    | `/api/v1/apps/:owner/:app/snapshots` | write  | List snapshots — see [Snapshots](/docs/snapshots) |

> [!note]
> Listing snapshots requires `write`, not `read` — one authorization check
> covers both verbs (`packages/opd/src/api.ts:1210`). The single-app status
> route is the one per-app read with no credential at all
> (`packages/opd/src/api.ts:1194`).

## Orgs

See [Orgs](/docs/orgs). Verified at `packages/opd/src/api.ts:490`:

| Method | Path                        | Auth | Purpose                                             |
| ------ | --------------------------- | ---- | --------------------------------------------------- |
| POST   | `/api/v1/orgs`              | user | Create `{name, displayName?}`; 409 on conflict      |
| POST   | `/api/v1/orgs/:org/members` | user | Add `{username}`; the forge checks org-owner rights |

## Work

One noun for issues and pull requests — see [Work items](/docs/work-items).
Repo-scoped routes start at `packages/opd/src/api.ts:581`:

| Method | Path                                           | Auth | Purpose                                                                              |
| ------ | ---------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| GET    | `/api/v1/work?phase=`                          | user | Platform-wide queue; defaults to non-terminal phases (`packages/opd/src/api.ts:634`) |
| GET    | `/api/v1/crew`                                 | user | Crew queue by phase, parked first (`packages/opd/src/api.ts:1079`)                   |
| GET    | `/api/v1/repos/:o/:r/work?state=&phase=`       | read | List a repo's work items                                                             |
| POST   | `/api/v1/repos/:o/:r/work`                     | user | File `{title, body?, labels?, head?, base?}`; forge checks write                     |
| GET    | `/api/v1/repos/:o/:r/work/:n`                  | read | Full item: intent, change, attempts, blockers, comments                              |
| POST   | `/api/v1/repos/:o/:r/work/:n/queue`            | user | Queue for the crew                                                                   |
| POST   | `/api/v1/repos/:o/:r/work/:n/comments`         | user | Comment `{body}`                                                                     |
| POST   | `/api/v1/repos/:o/:r/work/:n/close`            | user | Close; prunes any preview                                                            |
| POST   | `/api/v1/repos/:o/:r/work/:n/merge`            | user | Merge and ship; may unblock dependents                                               |
| POST   | `/api/v1/repos/:o/:r/work/:n/deps`             | user | Declare `{on: "owner/repo#n"}` blocked-by                                            |
| DELETE | `/api/v1/repos/:o/:r/work/:n/deps/:do/:dr/:dn` | user | Remove a dependency (`packages/opd/src/api.ts:747`)                                  |

The verb routes share one match at `packages/opd/src/api.ts:688`; per-verb
authorization happens in the forge.

## Issues and pulls (compat)

Thin reads over the same work rows, kept for one release. Issues share work
item numbers (`packages/opd/src/api.ts:911`); `/pulls/:num` resolves via the
frozen `pull_requests` table — no new PR numbers are ever minted
(`packages/opd/src/api.ts:777`).

| Method | Path                                     | Auth | Purpose                                                                                           |
| ------ | ---------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/repos/:o/:r/issues?state=`      | read | List, shaped as issue JSON                                                                        |
| POST   | `/api/v1/repos/:o/:r/issues`             | user | Create; delegates to work, so birth-phase semantics apply                                         |
| GET    | `/api/v1/repos/:o/:r/issues/:num`        | read | One issue with comments and blockers                                                              |
| POST   | `/api/v1/repos/:o/:r/issues/:num/labels` | user | Replace labels; adding `agent-work` to an `intent` item queues it (`packages/opd/src/api.ts:1008`) |
| GET    | `/api/v1/repos/:o/:r/pulls`              | read | Open changes as PR JSON (`packages/opd/src/api.ts:779`)                                           |
| GET    | `/api/v1/repos/:o/:r/pulls/:num`         | read | One historic PR by frozen number                                                                  |

## Streaming routes

Both need a crew credential — without `CLAUDE_CODE_OAUTH_TOKEN` they return
503 (see [The crew](/docs/crew)):

| Method | Path                               | Auth  | Purpose                                                                                      |
| ------ | ---------------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/repos/:o/:r/issues/draft` | write | Compose `{idea}` into a structured draft; does not create it (`packages/opd/src/api.ts:834`) |
| POST   | `/api/v1/guide`                    | user  | The docs guide agent; conversation travels in the body (`packages/opd/src/api.ts:1017`)       |

The draft route streams Server-Sent Events when `Accept` includes
`text/event-stream` and falls back to one JSON response otherwise
(`packages/opd/src/api.ts:865`); the guide always streams.
