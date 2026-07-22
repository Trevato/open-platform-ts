---
title: Import an app
description: Bring an existing repo onto the platform and let the crew tune it to the container contract.
---

Importing turns a repo that lives somewhere else — GitHub, any git remote —
into a platform app: the platform clones it, registers it under an owner, and
files a work item asking the crew to adapt it to the
[deploy contract](/docs/deploy-an-app). You care when the software you want
already exists and you would rather not repackage it by hand.

## Start an import

Paste a clone URL into the dashboard's import form, or call the API — the
form posts the same body (`packages/opd/src/console/index.ts:356`):

```sh title="Terminal"
curl -sk -u plat:<password> -X POST https://plat.localtest.me/api/v1/apps/import \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/someone/pastebin.git"}'
```

`POST /api/v1/apps/import` takes `{url, owner?, name?}`
(`packages/opd/src/api.ts:394`). The name defaults to the URL's last path
segment minus `.git` (`packages/opd/src/api.ts:142`). The platform clones the
remote into a repo it hosts — a failed clone rolls the registration back, so
there is no phantom repo to clean up (`packages/forge/src/forge.ts:322`) —
commits an app spec to gitops, and answers `201` with the app's host, its
platform `cloneUrl`, and the number of the conversion work item.

> [!note]
> `op app import <seed.tar.gz>` is a different verb: it moves an app that
> already runs on one platform to another, data included
> (`packages/opd/src/cli.ts:193`). See [Sovereignty](/docs/sovereignty).

## The conversion work item

The import files one [work item](/docs/work-items), born queued, labeled
`agent-import` and `agent-work` (`packages/opd/src/api.ts:470`). Its body is
the conversion spec (`packages/opd/src/api.ts:458`): a root `Dockerfile` that
builds and starts the server on `PORT`, persistent state only under
`DATA_DIR`, a non-root container user, and the app's existing behavior kept
intact. The acceptance criteria are explicit
(`packages/opd/src/api.ts:468`): the preview builds, serves HTTP 200 on `/`
(or a documented health path), and survives a restart with its data intact.

## The importer role

The dispatcher routes `agent-import` items to the `importer` crew role
instead of the builder (`packages/opd/src/crew/dispatcher.ts:469`). Its
instructions are the inverse of a feature build: adapt someone else's
project — any language, any framework — with the smallest possible diff, and
never rewrite (`genesis/platform/crew/importer/instructions.md:5`). The
hardest rule is one container per app: a `docker-compose.yml` must collapse
to a single service, typically by dropping the database container and
pointing the app's storage at `DATA_DIR`
(`genesis/platform/crew/importer/instructions.md:19`) — see
[Data](/docs/data) for what that directory gives you.

From there it is the same pipeline as any build: the change deploys to a
live preview, an adversarial reviewer attacks it over HTTP, and a passing
verdict auto-merges and ships
([How a request becomes software](/docs/how-it-builds)).

## When it parks

The importer is told that an honest blocker beats a broken deploy: a repo
that genuinely needs multiple services, a managed database, secrets, or root
is left as clearly stated partial progress rather than a faked deploy
(`genesis/platform/crew/importer/instructions.md:37`). The item then parks —
as it also does for a failed build, a preview that never comes up, or an
exhausted rework budget — and waits for a human
(`packages/opd/src/crew/dispatcher.ts:439`).

Parked items head the crew queue at `GET /api/v1/crew` and the `/crew` page
(`packages/opd/src/api.ts:1079`). The change branch is left in place, so you
can:

- Read the crew's last comment and commit message — the blocker is stated
  there.
- **Merge** the partial progress and iterate with normal work items.
- Fix the blocker yourself (push to the app repo) and **Re-queue** the item
  from the console.

Once the conversion ships, the app is an ordinary platform app: push to
deploy, add an `op.json` [manifest](/docs/app-manifest), file more work for
[the crew](/docs/crew).
