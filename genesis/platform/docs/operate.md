---
title: Operate the platform
description: Policy knobs that hot-reload from git — and what deliberately does not.
---

Your platform's own configuration is a git repo on the platform:
`plat/platform`. It holds `platform.json` (the policy knobs), the crew's role
prompts under `crew/`, and this manual under `docs/`. A push to that repo is
the operation: the daemon re-reads the file and re-converges, with no
restart. You care about this page when you want
to change the crew's budget or model, raise an app resource cap, or open the
asset-download allowlist.

## The policy file

`platform.json` has two blocks — `crew` (the AI workforce's tunables) and
`apps` (operator bounds on what any app's `op.json` may request), seeded
from `genesis/platform/platform.json:2` at first boot:

| Key                      | Genesis default        | Accepted      | Governs                                                           |
| ------------------------ | ---------------------- | ------------- | ----------------------------------------------------------------- |
| `crew.maxRework`         | `2`                    | 0–5           | rework rounds after a failed review; `0` disables rework          |
| `crew.sweepMs`           | `30000`                | 5000–600000   | how often the dispatcher sweeps for queued work                   |
| `crew.model`             | `claude-sonnet-5`      | model id      | the model builder/reviewer runs use                               |
| `apps.maxMemoryMb`       | `2048`                 | 64–65536      | cap on `resources.memoryMb`                                       |
| `apps.maxCpus`           | `2`                    | 0.1–64        | cap on `resources.cpus`                                           |
| `apps.tcpPortRange`      | `[25500, 25599]`       | 1024–65535    | public port pool for raw TCP ([game servers](/docs/game-servers)) |
| `apps.maxTcpPortsPerApp` | `4`                    | 0–16          | `tcpPorts` entries per app                                        |
| `apps.maxAssetMb`        | `512`                  | 1–10240       | per-asset download size                                           |
| `apps.assetHosts`        | 4 Mojang/PaperMC hosts | ≤32 hostnames | where `op.json` assets may download from                          |

The `apps` block is enforced at manifest admission — an `op.json` asking for
more memory than `maxMemoryMb` fails its deploy with the reason
(`packages/opd/src/manifest.ts:103`), and an asset from a host not on
`assetHosts` is refused (`packages/opd/src/manifest.ts:154`). Genesis ships
the four hosts the Minecraft example needs; the compiled-in default is empty,
so on a bare config every asset download is denied
(`packages/opd/src/manifest.ts:52`). See [the app manifest](/docs/app-manifest).

## Change policy with a commit

```sh title="Terminal"
git clone https://<your-domain>/plat/platform.git
# edit platform.json, then:
git commit -am "ops: raise app memory cap" && git push
```

The push — or a console Merge of a crew-proposed change; both fire the push
event (`packages/forge/src/forge.ts:577`) — triggers a reload and then a
full re-converge, so a raised memory cap reaches already-running apps
without another push (`packages/opd/src/platform.ts:493`). Crew prompts are even more direct:
`crew/<role>/instructions.md` and `crew/<role>/skills/*.md` are read fresh
from git for every job, so an edited prompt applies to the next run
(`packages/opd/src/platform-config.ts:184`). Docs work the same way — see
[how the docs work](/docs/docs).

> [!note]
> When the [crew](/docs/crew) itself edits `plat/platform`, the change is
> parked as a proposal for a human — the platform's own repos are never
> auto-merged (`packages/opd/src/platform-config.ts:25`).

## A bad commit cannot brick it

Every reload runs the fail-closed validator `admitPlatformConfig`
(`packages/opd/src/platform-config.ts:54`): out-of-range values are rejected
whole, and `crew.model` must match a model-id shape that cannot begin with
`-`, so a config commit can never smuggle a CLI flag into the crew's
`claude` invocation (`packages/opd/src/platform-config.ts:50`). On an
unreadable file, invalid JSON, or a rejected config, the daemon keeps the
last-good settings in memory and logs the reason
(`packages/opd/src/platform-config.ts:150`). A bad commit degrades to prior
behavior — never a dead daemon. Revert the commit to move forward.

## What a restart owns

Only hot-reloadable behavior lives in `plat/platform`. The domain, the gate
ports, the sovereign key, and the reconciler itself are frozen in the binary
and deliberately not in this repo — structurally unreachable by
self-modification (`packages/opd/src/platform-config.ts:15`). Change those
via [environment variables](/docs/env) (`DOMAIN`, `HTTP_PORT`, `HTTPS_PORT`)
and a restart. The platform's own source is a separate repo, `plat/opd`,
where a merge requests a supervised re-exec — see
[self-sourcing](/docs/self-source).

## Stopping the platform, and what happens to apps

App containers run with Docker's `--restart=always`, so their lifecycle is
tied to _how_ the daemon goes away
(`packages/opd/src/cli.ts:63`):

- **A crash or a self-upgrade re-exec → apps keep running.** A blip in the
  daemon must not take your apps down; the re-exec (or a host reboot's
  Docker restart) leaves them serving and reconciles them on the way back
  up (`packages/opd/src/cli.ts:80`, `teardownApps: false`).
- **An operator shutdown (Ctrl-C / `SIGTERM`) → apps stop too.** Stopping
  the platform stops its apps, so you never accumulate a mess of orphan
  containers from platforms that are no longer running
  (`packages/opd/src/cli.ts:96`). A later `op up` brings everything back —
  the reconciler recreates each app from `sys/gitops`.

The teardown is scoped to _this_ platform's containers (the `op.platform`
label), so stopping one platform never touches another's apps.
