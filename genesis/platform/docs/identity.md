---
title: Identity
description: One OIDC provider for humans and apps — login minted at deploy, app-to-app tokens that die at the gate.
---

The platform is its own identity provider. One OIDC issuer serves discovery,
JWKS, authorize, token, and userinfo, and every hosted app is a first-party
client of it (`packages/opd/src/oidc.ts:113`) — no consent screen, no external
IdP, no signup flow to build. You care about this page when you want "Sign in
with your platform" in an app, or one app calling another with a verified
identity.

## Two grants, three tokens

| Token             | Grant                | Audience              | Lifetime   |
| ----------------- | -------------------- | --------------------- | ---------- |
| `id_token`        | `authorization_code` | the app's `client_id` | 1 hour     |
| user access token | `authorization_code` | `<issuer>/userinfo`   | 1 hour     |
| app-to-app token  | `client_credentials` | target app's origin   | 10 minutes |

All three are RS256 JWTs. Authorization codes live 60 seconds and are single
use; PKCE S256 is mandatory on every code. There are no refresh tokens —
clients re-run their grant.

## Users and sessions

Platform users are rows in the forge: `plat` (the admin) and `qa` are created
at first boot from sealed secrets; admins create everyone else — there is no
open registration. A request authenticates three ways, checked in order:
`Basic` (PAT tried first, then password — so `git push` takes either), a
`Bearer` PAT, or the `op_session` cookie, a server-side session row with a
7-day TTL (`packages/forge/src/forge.ts:117`).

## Login for hosted apps

Every deploy target — production and each preview — gets its own OIDC client:
a stable `client_id` like `app-<owner>-<app>`, exactly one redirect URI at
`<origin>/auth/callback`, and a fresh secret
(`packages/opd/src/oidc-clients.ts:32`). The same converge injects
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI`
into the container's environment (`packages/opd/src/reconcile.ts:440`), so the
app template's `/login` route works on first deploy with zero configuration
(`genesis/app-template/server.ts:168`). See [Environment](/docs/env) for the
full injected set.

> [!warning]
> The client secret rotates on **every** deploy — store and container move in
> lockstep. Never copy `OIDC_CLIENT_SECRET` out of the running container; any
> saved copy silently goes stale on the next push.

## App-to-app tokens

An app calls a peer by trading its own client credentials for a short token:
`grant_type=client_credentials` plus a `resource` parameter naming the target
app's origin (`packages/opd/src/oidc.ts:170`). The token's audience **is**
that origin, its subject is `app:<owner>/<app>` (previews append `@pr-N`), and
it lives 10 minutes (`packages/opd/src/oidc.ts:189`).

The caller sends it as a `Bearer` header. It dies at the
[gate](/docs/ingress): the platform verifies it against the Host actually
being requested (`packages/opd/src/platform.ts:394`) and the container
receives no token at all — just the verified identity as an
`x-plat-user: app:owner/app` header. A token minted for one app verifies as
nothing at any other host, and never as a user, because the audiences are
disjoint. The `app:` prefix is unforgeable — usernames cannot contain `:`. The
template's `peerFetch` wraps the whole dance; see
[Connect apps](/docs/connect-apps) for peer wiring.

## The qa user

The [crew](/docs/crew)'s reviewer browses previews as `qa` — a normal
signed-in user with no special rights, created at boot
(`packages/opd/src/platform.ts:261`). It walks the real login flow —
authorize, login, callback, session cookie — exactly as a human would, so a
review pass proves your auth actually works for the least-privileged account.

## Signing keys

All tokens are signed by one RS256 key persisted as a private JWK at
`<root>/oidc.key.json`, mode `0600`, beside the sovereign `key.age`
(`packages/opd/src/oidc-clients.ts:10`) — same custody, same backup. It is
minted once per platform; a germinated daughter starts with a fresh state
directory and mints her own. The sovereign key that seals platform secrets is
a separate, unrelated key — see [Sovereignty](/docs/sovereignty).
