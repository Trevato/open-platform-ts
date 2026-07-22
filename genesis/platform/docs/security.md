---
title: Security model
description: The hard boundaries — the agent cage, the single gate, one sovereign key — and what M1 does not yet enforce.
---

The platform's security model is a small set of structural boundaries, not a
pile of settings. Each one is enforced in code on every request, every build,
and every boot — there is no permissive mode to forget to turn off. Read this
page before exposing a platform to a network you don't control.

| Boundary | Rule                                                           |
| -------- | -------------------------------------------------------------- |
| Agents   | run caged in a capability-dropped container; no platform creds |
| Network  | the gate is the only ingress; containers bind loopback only    |
| Identity | app tokens are audience-bound and die at the gate              |
| Secrets  | sealed to one sovereign key; no escrow, no second recipient    |
| Policy   | admission is fail-closed; there is no audit mode               |
| Console  | strict CSP; zero external fetches                              |

## The agent cage

Crew agents run wild inside a container, and the container — not a tool
allowlist — is the boundary. Every agent run gets `CapDrop: ALL`,
`no-new-privileges`, a read-only root filesystem, tmpfs `/tmp`, memory, CPU
and pid limits, and no restart (`packages/engine/src/index.ts:522-530`). The
agent runs as non-root uid 1000 on an isolated network, and its environment
is an allowlist: `HOME`, a config dir, its inference token, and a git
identity — never the platform's own credentials, and never the Docker socket
(`packages/opd/src/crew/container-runner.ts:97-111`). The checkout's origin
is a local path with no network credential; the trusted driver, not the
agent, pushes the result. See [The crew](/docs/crew).

## One network edge

App containers bind loopback only; the gate is the sole public surface, and
it always dials `127.0.0.1` (`packages/gate/src/gate.ts:172`). Before any
other work on an app host, the gate deletes every client-supplied `x-plat-*`
header — the platform's identity channel cannot be forged
(`packages/gate/src/gate.ts:117-120`). App-to-app bearer tokens die at the
gate: each is verified against the target host's origin as audience, so a
token minted for one app verifies as nothing at any other
(`packages/opd/src/platform.ts:446-460`). Details in
[Ingress](/docs/ingress) and [Identity](/docs/identity).

## One sovereign key

Every platform secret is sealed to exactly one age recipient, and on every
boot the sovereignty gate proves it: each value must decrypt with your key
and name exactly one recipient stanza, or the platform refuses to start
(`packages/opd/src/platform.ts:288`). There is no escrow and no recovery
path — the key file is the one deliberate single point of failure, and that
is the price of [sovereignty](/docs/sovereignty): no vendor, parent platform,
or third party can ever read your secrets either.

> [!warning]
> Lose `key.age` and the sealed secrets are gone for good. Back it up
> offline. Minting a key requires explicit custody acknowledgment
> (`FORK_KEY_ACK=1` or an interactive terminal).

## Policy fails closed

Admission is the only path to a deploy and it has no audit mode: a spec that
doesn't parse cleanly never reaches the reconciler
(`packages/opd/src/policy.ts:19-21`), and only images the platform built
itself — tagged `op/<owner>-<app>:` — may run
(`packages/opd/src/policy.ts:94`). A policy that isn't enforced never
happened.

## The console's CSP

Every console page ships `default-src 'none'` with `connect-src 'self'` —
no external scripts, styles, fonts, or fetches, ever
(`packages/opd/src/console/layout.ts:18-19`). The console renders
identically on an air-gapped machine.

## Adversarial review

Nothing the crew builds ships on the builder's word. A separate reviewer
agent attacks the live preview — unauthenticated access first, then
injection and bad input — and its role prompt opens with "You are the
reviewer — an adversary" (`genesis/platform/crew/reviewer/instructions.md:1`).
Changes to the platform's own repos are never auto-merged; a human reviews
and merges. See [how a request becomes software](/docs/how-it-builds).

## What M1 does not enforce

In M1, repos are public-read, and therefore so are the apps deployed from
them: the gate's authorization check is exactly "the repo exists"
(`packages/opd/src/platform.ts:478-479`). Any user signed in to your
platform — and any caller of a public route — can reach any app. Do not host
tenant-confidential apps on a shared M1 platform; per-app access policy is a
later milestone. Raw TCP ports have no SSO at all — the app behind the port
must authenticate its own protocol.
