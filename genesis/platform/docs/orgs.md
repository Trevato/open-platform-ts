---
title: Orgs
description: A shared namespace for a business — its apps, repos, and members under one name.
---

An org is a shared namespace: repos and apps owned by a business name instead
of a personal username. Every member can write to everything under that name,
and everything under it derives from the same owner string — clone URLs, app
hostnames, API paths. You care the moment two people work on the same
software.

## Create an org

```sh title="Terminal"
curl -sk -u plat:<password> -X POST https://<domain>/api/v1/orgs \
  -H 'content-type: application/json' \
  -d '{"name":"acme","displayName":"Acme Inc"}'
```

Org names live in the same flat owner space as usernames, collision-checked
in both directions — an org may not shadow a reserved name, an existing
username, or an existing org — so any owner string resolves to exactly one
principal (`packages/forge/src/forge.ts:186`). The creator is enrolled as the
first member in the same transaction, so an org can never exist with nobody
able to write to it (`packages/store/src/index.ts:369`).

## Membership

Membership is flat: any member may add any existing user
(`packages/forge/src/forge.ts:221`), over
`POST /api/v1/orgs/:org/members` with `{"username": "jo"}`.
There is no removal or role-change route yet.

Member rows carry a role — the creator is `owner`, invitees are `member` —
but roles gate nothing today; the only role rule is that a re-invite never
demotes an owner (`packages/store/src/index.ts:397`). All write authorization
is one check — admin, your own username, or membership in the org named as
owner (`packages/forge/src/forge.ts:176`) — and every write path funnels
through it: pushes, repo creation, imports, and work-item verbs alike.

## One owner string everywhere

An org owns things exactly the way a user does — it fills the owner slot in
every coordinate:

| Surface   | Shape                              |
| --------- | ---------------------------------- |
| App URL   | `https://<app>-acme.<domain>`      |
| Clone URL | `https://<domain>/acme/<repo>.git` |
| API paths | `/api/v1/repos/acme/<repo>/...`    |
| Console   | `/apps/acme/<app>` · `/orgs/acme`  |

The host rule is one line — `<app>-<owner>.<domain>`
(`packages/opd/src/policy.ts:85`). To put an app under an org, pass `owner`
when creating it; the API defaults to your username and rejects any owner you
can't write as `not a member` (`packages/opd/src/api.ts:251-253`). The
one-motion on-ramp and [repo import](/docs/import-an-app) take the same
`owner` field, and [work items](/docs/work-items) filed on org repos run
through the same crew pipeline as personal ones.

## Members and everyone else

Reads are public. Every existing repo — org-owned included — is
world-readable, even anonymously (`packages/forge/src/forge.ts:168`). Writes
require membership. A signed-in non-member gets the org page read-only, with
the create-app and add-member forms hidden
(`packages/opd/src/console/index.ts:490`).

> [!note]
> "Org-private" repos don't exist yet — don't put secrets in an org repo.
> Secrets belong in sealed app config; see [Security](/docs/security).

## In the console

**Orgs** in the nav lists the orgs you belong to, with a create form
(`packages/opd/src/console/index.ts:381`). Each org's page is the business's
software in one place: members, every app with live status, and repos that
have no app spec — surfaced so nothing is invisible.
