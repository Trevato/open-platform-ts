---
title: Work items
description: Issues and pull requests collapsed into one unit, governed by a legal-edge phase machine.
---

A work item is the issue and the pull request collapsed into one noun: an
intent, at most one attached change (a head/base branch pair), and an
append-only ledger of build attempts. Everything on the platform — your
requests, the crew's builds, your own pushed branches — moves through work
items, so one page shows a task's whole life from idea to shipped code.

## The phase machine

| Phase       | Means                                    | Legal sources                        |
| ----------- | ---------------------------------------- | ------------------------------------ |
| `intent`    | filed, nobody acting                     | birth only                           |
| `queued`    | waiting for the crew                     | `intent`, `parked`                   |
| `building`  | a builder holds the claim                | `queued`                             |
| `reviewing` | change attached, reviewer attacking it   | `building`, `reworking`, or birth    |
| `reworking` | review failed; fixing on the same branch | `reviewing`                          |
| `shipped`   | merged — terminal                        | `reviewing`, `reworking`, `parked`   |
| `parked`    | needs a human                            | `building`, `reviewing`, `reworking` |
| `closed`    | abandoned — terminal                     | any non-terminal phase               |

The edges live in one table in the store (`packages/store/src/index.ts:140`),
and every transition executes as a compare-and-swap `UPDATE … AND phase IN
(from…)` — an illegal or late transition throws and the row is untouched
(`packages/store/src/index.ts:977`). Concurrent movers lose cleanly: the crew
dispatcher claims work with a dedicated `queued → building` CAS that returns
`false` to the loser instead of throwing (`packages/store/src/index.ts:1014`).

Birth phase is a creation fact, not a transition. A plain item is born at
`intent`; filed with the `agent-work` label, at `queued`; filed with a `head`
branch, directly at `reviewing` (`packages/forge/src/forge.ts:435`) — so a
branch you push by hand enters the same review machinery as a crew branch.
Nothing ever moves back to `intent`, and `shipped` and `closed` have no
outgoing edges.

## Labels and the enqueue verb

Labels are taxonomy; phase is the process truth. Exactly one label is a verb:
`agent-work` means "queue this for the crew". Adding it to an item at
`intent` or `parked` transitions it to `queued`
(`packages/forge/src/forge.ts:851`); it can never move an item that is
building, reviewing, or shipped. The `queue` action is the same verb from the
other side — it stamps the phase and back-fills the label so the two agree
(`packages/forge/src/forge.ts:447`).

## One change, many attempts

A work item carries at most one change, ever: rework recommits to the same
branch, and attaching is idempotent per item
(`packages/store/src/index.ts:1026`). Each build-review pass appends a row to
the `work_attempts` ledger (`packages/store/src/schema.ts:191`) — attempt
numbers dense from 1, builder cost and head SHA on one half, reviewer verdict
and cost on the other (`packages/store/src/index.ts:1068`). The dispatcher
counts ledger rows for its retry budget, so a restart mid-loop never loses
count. [How a request becomes software](/docs/how-it-builds) walks the loop.

## Blockers

Declare "blocked by" edges with full coordinates — `{on: "owner/repo#3"}`.
Edges may cross repos but not owners, and self-edges and cycles are rejected
at add time, so the graph is always a DAG
(`packages/forge/src/forge.ts:613`). The dispatcher skips a queued item while
any blocker is in a non-terminal phase
(`packages/opd/src/crew/dispatcher.ts:145`); when the blocker ships, the next
tick picks it up.

## Parked reasons

The crew parks an item when it needs you, stamping a machine-readable reason
(`packages/opd/src/crew/dispatcher.ts:461`):

| Reason                  | What happened                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `build-failed`          | the builder errored out                                                                         |
| `declined`              | the builder declined mis-scoped work — its explanation of where the work belongs is in the feed |
| `preview-never-up`      | the change's preview never answered                                                             |
| `untestable`            | the reviewer couldn't exercise the preview                                                      |
| `rework-exhausted`      | blockers remain after the attempt budget                                                        |
| `merge-failed`          | the git merge failed after a passing review                                                     |
| `self-repo-human-merge` | the change edits the platform's own repos — you merge                                           |
| `template-human-merge`  | the change edits an app template — you merge                                                    |
| `daemon-restarted`      | the platform restarted and the item couldn't resume                                             |
| `migrated`              | carried over from the pre-phase label system                                                    |

> [!note]
> Parking never discards work: the change branch stays attached. Merge it,
> re-queue it, or close it — parked is a waiting room, not a graveyard.

## Human controls

Everything the crew does, you can do — from the item's console page or over
HTTP (`packages/opd/src/api.ts:537`):

| Action                          | Effect                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /api/v1/repos/:o/:r/work` | file a work item (`head` attaches a change)                                                   |
| `POST …/work/:n/queue`          | queue it for the crew (re-queues parked items)                                                |
| `POST …/work/:n/merge`          | merge the open change and ship (`packages/forge/src/forge.ts:530`)                            |
| `POST …/work/:n/close`          | close from any non-terminal phase; the preview tears down (`packages/forge/src/forge.ts:579`) |
| `POST …/work/:n/deps`           | declare a blocker                                                                             |
| `POST …/work/:n/comments`       | comment                                                                                       |

## Historic PR numbers

The `pull_requests` table is frozen read-only history — no new PR numbers are
ever minted (`packages/store/src/schema.ts:178`). An old `/pulls/N` URL
resolves through that table to its linked work item via the `agent/issue-N`
branch convention and redirects there; a historic PR with no linked item gets
a tombstone page explaining the move
(`packages/opd/src/console/index.ts:928`).
