---
title: Quickstart
description: Boot a platform and ship your first app in a few minutes.
---

You need three things on the machine: `bun`, `git`, and a reachable
Docker Engine socket. Everything else — git hosting, TLS, identity, CI,
deploys — is the one process you are about to start.

## Boot

Zero install — with Bun and a Docker socket:

```sh title="Terminal"
bunx open-platform-ts up
```

The first boot mints the world: a sovereign key, sealed secrets, the system
repos, and an admin user (`packages/opd/src/platform.ts:181`). It ends by printing
your platform card — domain, console URL, the admin password, and a
ready-to-paste first-app command (`packages/opd/src/cli.ts:24`).

> [!warning]
> The sovereign key file named on the card is the **only** decryptor of this
> platform's secrets. There is no escrow and no recovery. Back it up offline
> before you do anything else. Non-interactive boots must acknowledge this
> with `FORK_KEY_ACK=1`.

By default the platform serves `*.plat.localtest.me` on ports **80/443**, which
resolve to `127.0.0.1` without any DNS setup. If 80 or 443 are already in use —
a dev proxy, an ssh tunnel — set your own ports (the card prints the URL it
actually bound), and set `DOMAIN` to use a real domain:

```sh title="Terminal"
HTTP_PORT=8080 HTTPS_PORT=8443 bunx open-platform-ts up
# → console at https://plat.localtest.me:8443, public docs at /docs
```

Prefer typing `op`? `bun add -g open-platform-ts` installs the same binary
globally, so `op up` works too.

## Sign in

Open the console at the URL on the card and sign in as `plat` with the
printed password. You land on the dashboard: a text box that asks what you
spend time on.

> [!tip]
> Missed the password, or the card said "set on first boot"? It's shown only
> once at genesis. Recover it any time with `bunx open-platform-ts admin-password`
> (or `op admin-password` if installed) — it decrypts it from the sealed store
> with your local sovereign key.

## Ship your first app

The fastest path is to describe a task in plain words — the on-ramp names an
app for you, deploys it, and files the first build in one motion
(`packages/opd/src/api.ts:255`):

> I keep track of vacation requests for our office — who asked, the dates,
> and whether their manager approved.

Press **Build my tool** and watch: the crew builds it, an adversarial
reviewer attacks the preview, and on a pass it ships to production at its own
URL. The whole pipeline streams live on the work item's page.

If you'd rather push code, create an app (seeded from the starter template)
and clone it — every app is a git repo on your platform
(`packages/opd/src/api.ts:185`):

```sh title="Terminal"
curl -sk -u plat:<password> -X POST https://plat.localtest.me/api/v1/apps \
  -H 'content-type: application/json' -d '{"name":"hello"}'
git clone https://plat.localtest.me/plat/hello.git && cd hello
# edit server.ts, then:
git commit -am "my change" && git push
```

The push is the deploy. There is no separate CI system to configure — the
platform builds the Dockerfile, runs the container, and routes
`https://hello-plat.plat.localtest.me` to it. See
[Deploy an app](/docs/deploy-an-app) for the container contract.

## Give the crew its credential

The build crew drives the `claude` CLI and needs a Claude Code OAuth token
(`packages/opd/src/platform.ts:318`):

```sh title="Terminal"
claude setup-token          # prints sk-ant-oat01-…
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-… bunx open-platform-ts up
```

Without it the platform runs fine — git, deploys, data, ingress all work —
and the crew simply stays idle. See [The crew](/docs/crew).

## Where to go next

- **[How a request becomes software](/docs/how-it-builds)** — the pipeline
  you just watched, step by step.
- **[Architecture](/docs/architecture)** — what's actually inside the one
  process.
- **[Sovereignty](/docs/sovereignty)** — `op seed` and `op germinate`: hand
  someone a whole platform.
