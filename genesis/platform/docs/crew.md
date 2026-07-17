---
title: The crew
description: Caged Claude agents that turn a filed work item into shipped, reviewed code — the container is the security boundary.
---

The crew is the platform's AI workforce: Claude agents that pick up a queued
[work item](/docs/work-items), write the change, attack the live preview, and
ship on a passing verdict — no human in the loop for normal apps. You care
about this page when you want to give the crew its credential, tune how it
behaves, or understand exactly what an agent can and cannot touch.

## The roles

| Role           | Job                                                                |
| -------------- | ------------------------------------------------------------------ |
| `composer`     | turns a one-line idea into a structured issue draft you edit       |
| `builder`      | implements the spec in a sandboxed checkout, commits locally       |
| `reviewer`     | adversarially tests the live `pr-N` preview over HTTP              |
| `importer`     | adapts a cloned external repo to the deploy contract               |
| `platform-dev` | edits the platform's own config or source — proposed, never merged |

Each role is a directory in your `plat/platform` config repo:
`crew/<role>/instructions.md` is the system prompt, and any
`crew/<role>/skills/*.md` files are appended to it. The platform reads the
role fresh from git on every job (`packages/opd/src/platform-config.ts:184`),
so merging a prompt edit changes the very next build — no restart. Changes by
the crew to its own prompts are allowed but always
[proposed to a human](/docs/gitops); a caged agent editing `plat/platform`
may only touch `crew/**/*.md` and `platform.json`
(`packages/opd/src/crew/builder.ts:255`).

## The container cage

Builder and reviewer runs execute `claude --dangerously-skip-permissions` —
the agent runs wild, and the container, not a tool allowlist, is the boundary
(`packages/opd/src/crew/container-runner.ts:128`,
`packages/opd/src/crew/reviewer.ts:182`). The cage is exact:

- **Non-root**: uid `1000:1000`
  (`packages/opd/src/crew/container-runner.ts:97`); the image itself drops to
  the `node` user (`genesis/agent/Dockerfile:22`).
- **Capabilities dropped**: `CapDrop: ["ALL"]`, `no-new-privileges`,
  read-only rootfs, pids and memory limits, no restart
  (`packages/engine/src/index.ts:522-530`).
- **No host access**: an isolated `op-agents` bridge network, no Docker
  socket, only the checkout bind-mounted at `/work`, and a tmpfs `/tmp`.
- **No platform credentials**: the container env is only `HOME`,
  `CLAUDE_CONFIG_DIR`, the inference token, and a git identity
  (`packages/opd/src/crew/container-runner.ts:102`) — never the daemon's
  environment. The checkout's `origin` is a local path with no network
  credential; the trusted driver, outside the box, does the push.

The sandbox image `op/agent:latest` builds once from
`genesis/agent/Dockerfile` and is cached; delete it to pick up a newer
`claude`. See the [security model](/docs/security) for the full boundary map.

## The credential

The crew drives the `claude` CLI and needs a Claude Code OAuth token
(`packages/opd/src/platform.ts:302`):

```sh title="Terminal"
claude setup-token          # prints sk-ant-oat01-…
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-… op up
```

Without it the platform degrades gracefully: everything else works, queued
items wait with a one-time "set `CLAUDE_CODE_OAUTH_TOKEN`" note
(`packages/opd/src/crew/dispatcher.ts:133`), and the composer answers
`503 composer_offline` (`packages/opd/src/api.ts:793`). Work builds the
moment a credential appears.

## Model, rework, and cost

Crew tunables live in `platform.json` in `plat/platform` and hot-reload on
push — defaults are `maxRework: 2`, `sweepMs: 30000`, `model:
"claude-sonnet-5"` (`packages/opd/src/platform-config.ts:44`). The model is
passed into every builder and reviewer run
(`packages/opd/src/crew/dispatcher.ts:444`); the composer uses a fast model
(`claude-haiku-4-5`) independently.

On a failing verdict the builder reworks the same branch, up to
`crew.maxRework` times; exhaustion parks the item for you
(`packages/opd/src/crew/dispatcher.ts:352`). Every attempt posts its real
inference cost as a comment on the work item
(`packages/opd/src/crew/dispatcher.ts:228`), so a work item's feed doubles
as its bill.

> [!tip]
> `crew.maxRework: 0` disables rework entirely — every failed review parks
> for a human. Cheap, and a good default while you calibrate trust. See
> [Operate the platform](/docs/operate) for the other knobs.
