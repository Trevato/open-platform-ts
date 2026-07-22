---
title: Ingress
description: One gate for HTTPS and raw TCP — containers never touch the network edge directly.
---

Every byte that enters your platform passes through one gate. It terminates
TLS with a certificate the platform minted itself, routes by hostname, decides
who the caller is, and proxies to containers that are bound to loopback only.
A sibling relay does the same for raw TCP. You care about this page when you
wonder why your app has HTTPS with zero configuration, how `x-plat-user`
can be trusted, or how a game server gets a public port.

## The host grammar

Hostnames are the routing table. Every production deploy derives its host
from one function (`packages/opd/src/policy.ts:84`); previews prefix it with
`pr-<n>-`:

| Host                            | Serves                                      |
| ------------------------------- | ------------------------------------------- |
| `<domain>`                      | the platform: console, API, git, OIDC       |
| `<app>-<owner>.<domain>`        | the app in production                       |
| `pr-<n>-<app>-<owner>.<domain>` | a preview deploy of that app's pull request |

The preview prefix is why app names starting with `pr-<digit>` are
reserved — such a name would collide with a preview host. On deploy the
reconciler writes the host into a routing table the gate consults per
request, so routing changes are live with no reload; an unknown host is a
`404` before any auth work.

## One certificate, one CA

At boot the platform mints a root CA and a wildcard leaf covering `<domain>`
and `*.<domain>` (`packages/gate/src/ca.ts:105`) — one certificate serves the
console and every app subdomain, which is what makes host-based routing work
without per-app certs. Trust the `ca.crt` printed on your boot card for clean
HTTPS everywhere. Plain HTTP gets a `301` to HTTPS; nothing is served in the
clear.

## Identity at the edge

`X-Plat-*` headers are the platform's identity channel to apps, so on every
app-host request the gate first deletes anything a client sent under that
prefix — it can only be a forgery attempt (`packages/gate/src/gate.ts:119`).
Then it resolves who is calling (`packages/opd/src/platform.ts:448`): an
app-to-app bearer token verified against the target host's audience, or your
ordinary session. App tokens die here — the gate verifies them and translates
the caller into a plain header; a token minted for one app verifies as
nothing at any other because its audience is the target's origin
(`packages/opd/src/oidc.ts:196`). See [Identity](/docs/identity) for the
token model and [Connect apps](/docs/connect-apps) for the calling side.

What survives to your app is three headers the gate sets itself:
`x-plat-user` (only when authenticated — `app:owner/app` for app callers),
`x-forwarded-proto`, and `x-forwarded-host`
(`packages/gate/src/gate.ts:168`). Your app can trust them unconditionally:
the only process that can reach it is the gate.

## Loopback-only containers

Containers never bind a public interface. The gate proxies to
`http://127.0.0.1:<port>` (`packages/gate/src/gate.ts:172`), and the TCP
relay dials the same loopback binding — the two gates are the entire public
surface. Access is fail-closed: unknown app, no route; anonymous and denied,
a redirect to login; authenticated and denied, `403`.

> [!warning]
> WebSocket upgrades on app hosts are rejected with `501`
> (`packages/gate/src/gate.ts:143`). An app that needs a persistent
> connection should declare a raw TCP port instead.

## The TCP gate

HTTP is not the only protocol. Declare `tcpPorts` in your
[app manifest](/docs/app-manifest) (`packages/opd/src/manifest.ts:122`) and
production deploys get one public port per entry, relayed at L4 straight to
the container — no HTTP, no headers, just bytes. Players paste
`<domain>:<port>` into their client.

Public ports are sticky: allocation reuses the existing port for
`(owner, app, containerPort)` and is released only when the app is removed,
never on redeploy (`packages/store/src/index.ts:484`) — the address your
players saved keeps working. Previews never bind public ports; they are
reviewed over HTTPS.

> [!note]
> The TCP relay carries no SSO — a declared port is open to the internet, and
> your app's own protocol must authenticate its peers. See
> [Run game servers](/docs/game-servers) for a worked example.
