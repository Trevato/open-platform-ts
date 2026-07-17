---
title: What is Open Platform
description: One Bun process that is a complete software platform — and can reproduce.
---

Open Platform is a single process that gives you what a team of platform
engineers normally assembles from a dozen services: git hosting, identity,
CI, app deployment, per-app data, TLS ingress, and an AI build crew that
turns plain-English requests into shipped software. You describe a task; a
few minutes later a working, reviewed tool is live at its own URL.

It runs on `bun`, `git`, and a Docker socket. Nothing else. And it can
reproduce: `op seed` exports a genome anyone can grow into a **sovereign**
platform of their own — fresh keys, fresh secrets, its own identity, with
lineage recorded in both family trees.

## Start here

- **[Quickstart](/docs/quickstart)**: boot a platform and ship your first app
  in a few minutes.
- **[How a request becomes software](/docs/how-it-builds)**: what happens
  after you type an idea into the console.

## Understand it

- **[Architecture](/docs/architecture)**: every subsystem, and the exact path
  a request takes through the one process.
- **[GitOps](/docs/gitops)**: desired state lives in git; a push _is_ the
  event. No polling gap to race.
- **[Work items](/docs/work-items)**: issues and pull requests collapsed into
  one unit with a legal-edge phase machine.
- **[The crew](/docs/crew)**: caged builder and reviewer agents — the
  container is the security boundary.
- **[Data](/docs/data)**: each app owns a directory — SQLite plus files —
  snapshotted, cloned, and restored as files.
- **[Ingress](/docs/ingress)**: one gate for HTTPS and raw TCP; containers
  never touch the network edge directly.
- **[Identity](/docs/identity)**: one OIDC provider for humans and apps;
  app-to-app tokens die at the gate.
- **[Sovereignty](/docs/sovereignty)**: one key seals everything. Parents can
  never read children.

## Do things

- **[Deploy an app](/docs/deploy-an-app)** — the Dockerfile contract.
- **[The app manifest](/docs/app-manifest)** — declare memory, TCP ports,
  assets, and peers in `op.json`.
- **[Connect apps](/docs/connect-apps)** — peer wiring and the derived
  integration map.
- **[Run game servers](/docs/game-servers)** — a Minecraft network,
  end to end.
- **[Operate the platform](/docs/operate)** — policy knobs that hot-reload
  from git.

## Look things up

- **[CLI](/docs/cli)** · **[HTTP API](/docs/api)** ·
  **[Manifest schema](/docs/manifest-schema)** · **[Environment](/docs/env)**
  · **[Security model](/docs/security)**

> [!tip]
> These docs are part of the platform. Press `⌘K` to search, ask the
> guide anything, or read [how the docs work](/docs/docs) — including how
> every code reference is verified against the source it names.
