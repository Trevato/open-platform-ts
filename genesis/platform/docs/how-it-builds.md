---
title: How a request becomes software
description: The pipeline from a plain-English idea to a reviewed, shipped change — and where you step in.
---

You describe what you need; the platform files it as a work item, a caged
builder writes the change, an adversarial reviewer attacks a live preview,
and a passing verdict ships it to production. This page walks that pipeline
end to end — it is the thing you watch on a work item's page right after the
[Quickstart](/docs/quickstart).

## From idea to work item

There are two on-ramps. The dashboard's text box is the one-motion start:
`POST /api/v1/onramp` names an app for you, deploys it, and files the first
build in a single call (`packages/opd/src/api.ts:255`). On an app that
already exists, the composer turns a rough one-liner into an editable draft —
title, spec, labels, acceptance checks — that you review and file yourself
(`packages/opd/src/api.ts:788`).

Either way the result is a [work item](/docs/work-items) carrying the
`agent-work` label, which means it is born at phase `queued`
(`packages/forge/src/forge.ts:435-439`) — and a queued birth wakes the crew.

## The build

The dispatcher sweeps queued items and claims one with a compare-and-swap, so
two sweeps can never build the same item
(`packages/store/src/index.ts:1014`). It clones the repo, cuts the branch
`agent/issue-N` (`packages/opd/src/crew/builder.ts:162`), and runs the
builder agent inside a locked-down container that holds nothing but its
inference token — no platform credentials, no way to push. The agent writes
code and commits locally; the trusted driver outside the cage pushes the
branch and attaches the change. See [The crew](/docs/crew) for the cage.

## The preview

Attaching a change births a preview: the platform builds the branch and runs
it at `https://pr-<n>-<app>-<owner>.<your-domain>` with a copy-on-write clone
of production's data (`packages/opd/src/reconcile.ts:146-147`). The reviewer
tests against realistic data, and nothing it does can touch prod. See
[Data](/docs/data).

## The review

The reviewer signs in to the preview as a low-privilege QA user and attacks
it over HTTP: unauthenticated access first, then the happy path from the
spec's acceptance checks, then injection, XSS, and bad-input probes. Its
final message ends in exactly one verdict line
(`packages/opd/src/crew/reviewer.ts:29`):

| Verdict           | Meaning                   | What happens        |
| ----------------- | ------------------------- | ------------------- |
| `✅`              | works, no blockers        | auto-merge and ship |
| `⚠️`              | works, concerns noted     | auto-merge and ship |
| `❌ … untestable` | could not be exercised    | parked for you      |
| `❌`              | concrete blockers, listed | rework              |

## Ship or rework

On a pass, the platform merges the change into `main` as the system actor
(`packages/opd/src/crew/dispatcher.ts:313`); the merge redeploys production
and tears down the preview. On a fail, the builder reworks the same branch
with the verdict line as its spec, waits for a fresh preview, and the
reviewer goes again — up to `crew.maxRework` times, default 2
(`packages/opd/src/platform-config.ts:44`).

## When you step in

Anything the pipeline cannot finish is **parked** with a reason — build
failed, preview never came up, untestable, rework exhausted — and waits on
the `/crew` page. The work item's controls follow the legal phase edges
(`packages/opd/src/console/index.ts:991-1007`): **Re-queue** sends it back to
the crew, **Merge** ships it anyway on your judgment, **Close** ends it.

> [!note]
> Changes to the platform's own repos (`plat/platform`, `plat/opd`) always
> park as proposals. The crew never auto-merges the thing it runs on — you
> read the diff and press Merge. See [Self-source](/docs/self-source).

## Watching it happen

The work item's page is a live feed: phase steps, the agent's narration and
tool calls (sampled — at most one line every 18 seconds,
`packages/opd/src/crew/heartbeat.ts:55`), verdict lines, and the pipeline
stepper. Below it, **Attempts** lists one row per build-and-review round with
the verdict and the model cost of each half in dollars
(`packages/opd/src/console/index.ts:1016-1021`). Attempts are how the rework
budget is counted; costs are what that item actually spent.
