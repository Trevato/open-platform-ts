# `test/sim` — simulation-at-scale testing harness

A seeded, deterministic workload runner that drives **real** traffic (the
platform's own HTTPS API, the real `git` CLI, live Docker containers) at a
single `Platform.up()` instance, and checks a **mechanical invariant library**
between every batch of operations.

The design follows deterministic-simulation-testing canon (FoundationDB →
TigerBeetle's VOPR → Antithesis): one master seed tunes every workload decision,
the seed is printed at start and embedded in every failure message, and the
correctness oracle is fully deterministic and independent of what generated the
traffic. There is **no `Math.random` anywhere** — all entropy flows from the
seeded `SimRng` (splitmix64).

## Run it

```bash
bun test test/sim                          # default: cheap, a few real deploys
OP_SIM_SEED=0xdeadbeef bun test test/sim   # pin a seed to reproduce a run
OP_SIM_SEED=random bun test test/sim       # explore; the chosen seed is printed
```

The runner prints its seed at the top:

```
[sim] master seed OP_SIM_SEED=0x504c4154 (default) — re-run with this to reproduce
```

Every failure ends with the exact reproduction command
(`OP_SIM_SEED=0x… bun test test/sim`). Docker-gated: if no engine socket is
found the suite skips (like the other e2e tests).

### Knobs

| env              | default         | effect                                                 |
| ---------------- | --------------- | ------------------------------------------------------ |
| `OP_SIM_SEED`    | `0x504c4154`    | master seed: hex `0x…`, decimal, or `random`           |
| `OP_SIM_ROUNDS`  | `3`             | operation batches; invariants run after each           |
| `OP_SIM_STEPS`   | `1` (heavy `2`) | persona steps per batch                                |
| `OP_SIM_TENANTS` | `4`             | tenants provisioned (min 4)                            |
| `OP_SIM_HEAVY=1` | off             | add a 2nd builder + the forker (PR→preview deploys)    |
| `OP_SIM_FLEET=1` | off             | germinate a sovereign daughter + run fleet-sovereignty |
| `OP_SIM_HARD_MS` | `300000`        | hard wall-clock ceiling                                |

The default run keeps Docker cost low (a handful of app builds); the preview and
fleet tiers — the expensive ones — are gated behind `OP_SIM_HEAVY` /
`OP_SIM_FLEET`.

## What each invariant guarantees

The oracle lives in `invariants.ts` and runs between batches, judging only
observed state (never the RNG):

1. **Tenant isolation** — the `forge.authorize` matrix over every tenant × every
   repo (including the system repos `sys/gitops`, `plat/*`): public **reads**
   are allowed (the _only_ thing that crosses tenants in M1); every cross-tenant
   **write** is denied; a tenant keeps write on its own repos. The `attacker`
   persona independently confirms this live over HTTP + git (push / snapshot /
   PR / label / token-mint / user-create against another tenant → all `403`), and
   a `2xx` on any of those is flagged a breach with the seed.
2. **Content isolation** — every `builder`/`forker` push writes a unique,
   owner-tagged sentinel file; the checker greps every _other_ repo's full object
   graph and asserts the sentinel appears nowhere but its home repo.
3. **Credential canaries** — the admin password, the age identity, every PAT,
   `CLAUDE_CODE_OAUTH_TOKEN`, and every value in the sealed secrets inventory
   (decrypted with the sovereign key) must appear in **no** world-readable
   surface: all repos' full git object graph (`cat-file --batch-all-objects`,
   generalizing m1's `allHistoricalSecrets`), `deploy_events`, and
   issue/PR/comment bodies.
4. **Deploy state machine** — per app, `deploy_events` follow
   `queued → building → (built → running | preview-ready | failed)`; no illegal
   jumps. Preview streams are validated as their own partition.
5. **Container coherence + teardown hygiene** — every platform-labelled
   container maps to an app in the workload (no orphans, no cross-tenant
   containers); and after teardown, none linger.
6. **Fleet sovereignty** (`OP_SIM_FLEET=1`) — the mother's key opens **nothing**
   in a germinated daughter (HEAD _and_ full git history), the keys differ, and
   the lineage ledger grows by exactly one generation.

## Files

- `rng.ts` — `SimRng`, a splitmix64 PRNG. `SimRng.fromEnv()` resolves
  `OP_SIM_SEED` and prints the banner; `.derive(key)` mints an independent child
  stream seeded from `h(masterSeed, key)` — this is the per-actor stream
  `h(masterSeed, platformIdx, personaIdx)`, order-independent so siblings never
  perturb each other.
- `personas.ts` — programmatic (not LLM) workload generators: `builder`,
  `churner`, `forker`, `noisyNeighbor`, `attacker`. Each is a weighted sequence
  of real operations over HTTP/git, every choice drawn from its own stream. A
  `World` carries cross-tenant knowledge so the attacker can find foreign targets
  and the checkers can find sentinels.
- `invariants.ts` — the deterministic checker library above.
- `helpers.ts` — polling (`until`), one waited happy-path `shipAndServe`, and
  container cleanup, factored from m1's patterns.
- `sim.test.ts` — the `bun test` entry that boots one platform, provisions
  tenants, runs the personas in seeded batches, and asserts every invariant.

## Where this grows (the L-tier future)

This is swarm **level 0**: one platform, programmatic personas, deterministic
oracles. The invariant library is the permanent asset — every later tier reuses
it unchanged. Next:

- **Fleet runner** — germinate `N` sovereign platforms on one host (ports/domains
  are pure parameterization; `p1..pN.localtest.me` all resolve to loopback), run
  `K` personas per platform, and add cross-platform attacker personas that probe
  platform _i_ with platform _j_'s credentials. Record every executed operation
  to a JSONL trace so a failure replays verbatim without the RNG (replayability
  without a hypervisor).
- **LLM persona swarm** — replace the programmatic personas with cheap-model
  (Haiku-class) agents carrying goal cards and temperament profiles (tau-bench
  style). They generate _diversity_ of traffic; every correctness judgment still
  comes from this invariant library. The payoff unique to a self-reproducing
  platform: agents file **real issues** that the platform's own AI build crew
  picks up and fixes — a closed self-hosting flywheel, with the credential-canary
  invariant guarding every crew-authored commit.
