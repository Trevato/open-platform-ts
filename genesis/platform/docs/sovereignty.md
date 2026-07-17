---
title: Sovereignty
description: One key seals every secret, seeds carry no keys, and parents can provably never read children.
---

Sovereignty is the platform's reproduction guarantee: every platform — the one
you booted and every one grown from its seed — is the sole owner of its own
secrets. One key seals everything, no key ever travels in a seed, and the
guarantee is verified with cryptography at boot, not promised in prose. You
care about this page when you hand someone a platform, or someone hands you
one.

## One key, acknowledged or no boot

First boot mints a sovereign age key at `<root>/key.age` — an X25519 identity
whose recipient half seals every platform secret. The platform refuses to mint
it until you acknowledge custody: an interactive TTY counts, and scripts must
set `FORK_KEY_ACK=1` (`packages/opd/src/cli.ts:20`) or boot fails with SEC-1
(`packages/opd/src/platform.ts:135`). An existing key file is never
overwritten (`packages/secrets/src/keys.ts:31`).

Secrets live in one git-diffable document, `secrets.age.json`, committed to
the `sys/gitops` repo (`packages/opd/src/gitops.ts:16`) — each value
independently age-encrypted. Every boot runs the sovereignty gate: each value
must decrypt with your key and its header must name exactly one recipient
stanza — no escrow, no second recipient, no leftover parent ciphertext
(`packages/secrets/src/seal.ts:88`). A violation aborts startup
(`packages/opd/src/platform.ts:239`).

> [!warning]
> `key.age` is the only decryptor. There is no escrow and no recovery. Back it
> up offline. See the [security model](/docs/security) for the full threat
> table.

## `op seed` exports the genome

```sh title="Terminal"
op seed                       # writes seed-YYYY-MM-DD.tar.gz
```

A seed is a tarball of git bundles: the [gitops](/docs/gitops) repo, the app
template, and `plat/platform` (config, crew prompts, these docs). No key
ships. Before bundling, the platform squashes `sys/gitops` to a single orphan
commit with `apps/` and `secrets.age.json` deleted
(`packages/opd/src/platform.ts:551-555`) — full history would carry the
mother's old ciphertext, decryptable by her key, into every descendant's repo
forever. The orphan commit has no parent, so no earlier tree is reachable.
Hand the file to anyone.

## `op germinate` grows a daughter

```sh title="Terminal"
SEED=seed.tar.gz DOMAIN=you.example FORK_KEY_ACK=1 op germinate
```

Germination refuses an occupied root and unacknowledged custody, then: mints a
fresh sovereign key — never derived from the parent
(`packages/opd/src/platform.ts:757`); restores the repos from bundles;
regenerates every secret in the platform inventory
(`packages/secrets/src/regen.ts:20`) sealed to the daughter's recipient,
replacing the parent's ciphertext wholesale; reads the committed file back and
runs the sovereignty gate to prove every value decrypts with the daughter's
key (`packages/opd/src/platform.ts:780`); records lineage; then boots
normally.

Parents can never read children: the daughter's key is minted locally and
never travels, the seed carried no key in either direction, and the daughter's
first commit replaces every sealed value before anything serves.

Each germination appends one line to the plain-text `ORIGIN` file —
`<domain> germinated-from <parent> <time> seed=<file>`
(`packages/mitosis/src/lineage.ts:20`). `op lineage` prints it; the console
renders it at `/lineage`.

## Moving one app

The per-app version of the same story: `op app export owner/app` bundles the
repo's full history plus a fresh integrity-checked
[data snapshot](/docs/snapshots) (`packages/opd/src/platform.ts:631`) — no key
material, since the app's OIDC client and secrets are re-minted at deploy on
the target. `op app import` restores the repo, verifies the data opens, and
commits a spec remapped to the buyer's namespace
(`packages/opd/src/platform.ts:706`). See
[Import an app](/docs/import-an-app) for the buyer's walkthrough.
