---
title: Deploy an app
description: The container contract, the push-to-running pipeline, and where to watch it happen.
---

A deploy is a git push. Every app is a repo on your platform with a
`Dockerfile` at its root; when you push, the platform builds the image, starts
the container, and routes `https://<app>-<owner>.<domain>` to it. There is no
CI to configure, no registry, and no deploy command — if you can `git push`,
you can ship. Start from the [quickstart](/docs/quickstart) if you haven't
created an app yet.

## The container contract

Your container must do four things. Everything else is optional.

| Rule                                    | Why                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| Serve HTTP on `PORT` (default `8080`)   | the platform injects `PORT` and routes your host to it                               |
| Persist only under `DATA_DIR` (`/data`) | the one writable mount that survives redeploys; [snapshots](/docs/snapshots) copy it |
| Run as non-root                         | the runtime enforces it; write files your user can read back                         |
| Start with no manual steps              | container start is the last step of the deploy — nobody will exec in to finish setup |

The platform runs every app with all capabilities dropped,
`no-new-privileges`, restart-always, and user `65534:65534` unless your image
says otherwise (`packages/engine/src/index.ts:247-270`). Container ports never
bind publicly — the [gate](/docs/ingress) is the only ingress.

## The template

New apps start from a three-file template that already satisfies the contract:

- `server.ts` — a single-file Bun server: `bun:sqlite` database under
  `DATA_DIR` (`genesis/app-template/server.ts:25-26`), HTTP on `PORT`
  (`genesis/app-template/server.ts:161`), platform sign-in, and peer calls.
- `ui.ts` — a zero-dependency, server-rendered UI kit carrying the console's
  design language (`genesis/app-template/ui.ts:1`).
- `Dockerfile` — COPY-only on purpose; one layer keeps the full push-to-live
  loop under a minute:

```dockerfile title="Dockerfile"
FROM oven/bun:1-alpine
WORKDIR /app
COPY server.ts ui.ts ./
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "server.ts"]
```

Add a `RUN` step only when you need a runtime beyond Bun — you trade build
speed for it. Memory, CPU, raw TCP ports, and peers are declared in `op.json`;
see [the app manifest](/docs/app-manifest).

## Push, build, run

A push to an app repo converges just that app; a push to the gitops repo
re-converges everything (`packages/opd/src/reconcile.ts:75-76`). The
reconciler clones the deployed ref, builds it as
`op/<owner>-<app>:<sha12>` (`packages/opd/src/reconcile.ts:142`), and only
after the build succeeds stops the old container and starts the new one
(`packages/opd/src/reconcile.ts:381-383`).

Each phase lands on the app's deploy timeline:

| Phase                       | Meaning                                          |
| --------------------------- | ------------------------------------------------ |
| `queued`                    | commit resolved, deploy started                  |
| `waiting`                   | no `Dockerfile` on the ref yet — benign          |
| `assets`                    | `op.json` assets fetched and placed into `/data` |
| `building` / `built`        | image build ran; the full log is saved           |
| `starting`                  | new container replacing the old one              |
| `tcp`                       | public TCP port bound to a container port        |
| `running` / `preview-ready` | live at its host                                 |
| `failed`                    | any phase errored; the reason is the message     |

> [!note]
> Deploys are stop-then-start, not blue-green: exactly one container writes
> `/data` at a time, so there is a brief gap while the new container starts.
> The build always completes first, so a broken build never takes you down.

## Watching a deploy

Three read endpoints cover the whole story
(`packages/opd/src/api.ts:1065-1100`):

| Route                               | What you get                                |
| ----------------------------------- | ------------------------------------------- |
| `/api/v1/apps/:owner/:app/events`   | the deploy timeline, newest first           |
| `/api/v1/apps/:owner/:app/buildlog` | the last build's full `docker build` output |
| `/api/v1/apps/:owner/:app/logs`     | the running container's last 200 lines      |

The console shows the same timeline and logs on the app's page.

## The deploy spec

Desired state for an app lives at `apps/<owner>/<app>/app.json` in the
`sys/gitops` repo (`packages/opd/src/policy.ts:10-17`) — see
[GitOps](/docs/gitops). Creating an app writes it for you; edit it to deploy a
different branch or port.

| Field           | Meaning                      | Default on create |
| --------------- | ---------------------------- | ----------------- |
| `repo`          | the repo to build            | the app's own     |
| `ref`           | the git ref to deploy        | `main`            |
| `containerPort` | the container's HTTP port    | `8080`            |
| `data`          | whether the app gets `/data` | `true`            |

Admission fails closed: a spec that doesn't parse cleanly never reaches the
reconciler.

## Image reaping

After each successful prod deploy the platform deletes the app's superseded
image tags, keeping the one it just shipped
(`packages/opd/src/reconcile.ts:505-513`). Images still in use — say, by a
live PR preview — are skipped, never force-removed, so a deploy can't pull an
image out from under an open review.
