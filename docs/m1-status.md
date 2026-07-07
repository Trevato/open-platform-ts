# M1 status — the full loop, green

**Done.** `bun test` = 115 pass / 1 skip / 0 fail; `bunx tsc --noEmit` clean.
The docker-gated M1 e2e (`test/m1.e2e.test.ts`) runs the entire product
constraint end to end and, warm-cache, completes in **3–19s** (soft budget 60s,
hard 90s). It is not mocked: real git-over-HTTPS push against our smart-HTTP
server, a real container serving a request backed by a real SQLite round-trip,
a real snapshot with `integrity_check`, a real docker germination, and a real
cross-key decryption failure.

## What one Bun process now is

git hosting (smart-HTTP wrapping the system git binary, conformance-tested
against the real git CLI) · forge (users / PATs / sessions, fail-closed authz) ·
OIDC-ready identity root · Docker Engine API client (context-aware socket
resolution — colima/OrbStack/Desktop) · the **data** primitive (provision +
snapshot: checkpoint → CoW clone → `integrity_check`) · CA + wildcard TLS
ingress with forward-auth middleware (on by default) · event-driven reconciler
(a push _is_ the event; stop-before-start for the single-writer data plane;
prune) · fail-closed policy admission (no audit mode) · **mitosis** as two TS
functions (`seed` / `germinate` with custody gate, regenerate-all,
verify-all-sealed on every boot, ORIGIN lineage).

## Adversarial validation

A fresh-context validator attacked the load-bearing claims.

- **Sovereignty — the claim that most needs to be true.** `verifyAllSealed` is a
  real hard gate (both call sites `Result.unwrap` it → boot/germinate aborts on
  failure). A hand-crafted 2-recipient age ciphertext was correctly rejected as
  multi-recipient. **One confirmed leak — now fixed:** `seed()` had bundled full
  gitops history, so a daughter's public-read `sys/gitops` still carried the
  mother's earlier `secrets.age.json` commits, decryptable by the mother's key.
  Fix: `seed()` squashes gitops to a single orphan commit with
  `secrets.age.json` stripped; the daughter regenerates all secrets and commits
  them fresh. The e2e now scans the daughter's **entire** history and asserts the
  mother key opens nothing (permanent regression guard).
- **Git auth / tenant isolation.** No path traversal (`isValidName` blocks
  `.`/`/`/`..`; manifest fields re-validated on extract). Write requires
  owner-or-admin, fails closed on unknown repo. Read is public-by-design (M1).
- **Policy.** No bypass: image tags are server-synthesized; `admitImageTag`
  rejects any non-platform-built image; `admitSpec` is strict and fails closed.
- **<60s honesty.** Confirmed honest — see above.

## Carry-forward into M2 (explicit)

1. **Reserved names.** No denylist reserves `sys` / `plat` for platform use.
   Not reachable in M1 (no self-serve signup; only a first-boot admin can create
   users). **M2 signup MUST reject reserved owner names** — genesis legitimately
   owns `plat`/`sys`, so enforcement belongs in the signup handler, not
   `createUser`.
2. **Concurrent-push reconcile.** Passes serialize on one FIFO promise queue, so
   they never overlap (reasoned-correct; the stop()/drain race was fixed and is
   covered by the e2e). A stress test with concurrent pushes is worth adding.
3. The rest of the M2 spine per `docs/plan.md`: OIDC SSO consumed by the
   template app, PRs/reviews/webhooks/branch protection, both policy admission
   points with rejection tests, blobs S3-subset (+ multipart, conformance),
   per-PR data branches, off-host backups + destroy-and-restore drill,
   app-owner day-2 surface (logs/restart/exec), app cron, ACME, console UI,
   MCP surface v1.
