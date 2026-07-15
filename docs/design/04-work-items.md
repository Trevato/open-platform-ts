# Work Items — the development-process design (synthesis)

Judged designs: A = minimal (link column + Work view), B = systems (new `changes` spine table),
C = crew-first (promote `issues` to work items, absorb the PR). Verdict: **C's skeleton wins**,
with B's state-machine rigor and A's migration discipline grafted on.

---

## 1. Scores

| Criterion (1-10) | A minimal | B systems | C crew-first |
| ---------------- | --------- | --------- | ------------ |
| Inevitability    | 6         | 8         | **9**        |
| Migration safety | **9**     | 6         | 8.5          |
| Crew-usability   | 6         | 9         | **9**        |
| Payoff-per-line  | 7         | 7         | **9**        |

- **A** is safe but refinances the loan: two number sequences keep minting forever (createPr still
  mints), the comma-string label protocol stays the state machine (unenforced — contradicts
  fail-closed), and "frozen" parallel forge/API families are two implementations kept alive.
  Its best ideas — trivial backfill, `/pulls` kept as cheap compat, shipped-intent-lives-in-git
  (ISSUE.md merged into history) as the mitosis answer — are grafted below.
- **B** has the best process model (phase as single source of truth, CAS claim, boot sweep,
  forge-enforced transitions) but pays for it with a rewrite: a new spine table, orphan-PR
  renumbering, `issue_comments` RENAME, immediate route deletion, and pure-churn renames
  (`agent/issue-N`→`change/N`, `pr-N-`→`chg-N-` hosts) that break sim greps, reviewer
  instructions, and data-branch dirs (`<app>@<branch>`, data/src/index.ts:193) for zero capability.
- **C** notices the decisive fact: the issue row _already is_ the work item (number in the branch
  name, state machine in labels, comments, deps, trigger). Absorbing `{head_ref, base_ref,
change_state}` into it via `ALTER TABLE ADD COLUMN` is full model unification at
  model-level-migration cost — the number-collision problem is solved by never minting PR
  numbers again, not by renumbering. Adds the one thing neither A nor B has: a persisted
  **attempts ledger** (reviewer memory + cost accounting + restart-safe rework).

**THE design = C, with grafts:** B's CAS claim + boot sweep + phase-derives-state discipline +
`agent-import`-is-taxonomy note; A's same-owner dep scope, `/pulls` one-release compat,
independent-shippable sequencing, and the intent-in-git mitosis framing.

---

## 2. The model

**A work item = intent + at most one live change + an append-only attempt ledger.**

- **Intent** — title + body, human- or composer-authored. The only thing a human must write.
  It rides the branch as `ISSUE.md` (builder behavior unchanged), so _shipped intent is merged
  into git history_ — the only store that survives mitosis. In-flight coordination state
  (phase, attempts) is correctly ephemeral platform-DB state. Genome untouched.
- **Change** — `{head_ref, base_ref, change_state}` on the item, NULL until the builder (or a
  human push) produces one. One live change per item, ever; rework recommits on the same
  branch (already builder.ts:163-169 behavior). No second number is ever minted again.
- **Attempts** — append-only rows `(attempt n, head_sha, builder cost, verdict, verdict_line,
reviewer cost)`. Today this lives in Dispatcher locals and dies on restart
  (dispatcher.ts:206-207, 325) — the single biggest crew-reliability defect. The reviewer gets
  prior verdict lines as context, so attempt 2 doesn't re-litigate attempt 1.

**Is the PR an implementation detail?** Yes — at the git layer it always was just
`diffStat` + `mergeBranch` (githost.ts:350-418). User-visible remains, as sections of the one
work-item page: diff, branch name (external `git fetch origin agent/issue-7` still works),
preview URL, attempt/verdict ledger, and Merge / Close / Re-queue controls (mandatory for
parked items and for self-repos, which never auto-merge). The noun "pull request" disappears
from API, console, and crew prompts.

### 2.1 Lifecycle — one `phase` column, fail-closed transitions

```
intent ──queue──▶ queued ──claim(CAS)──▶ building ──attachChange──▶ reviewing ──✅/⚠️──▶ shipped
  │                 │                       │                        ▲   │
  ▼                 ▼                       ▼                        │   ├─❌,attempt<max─▶ reworking ─┐
closed            closed                  parked                     └───┘                            │
                                            ▲   ▲──── rework exhausted / preview-never-up ◀──────────┘
                                            └──requeue──▶ queued        parked ──human merge──▶ shipped
```

Phases: `intent, queued, building, reviewing, reworking, shipped, parked, closed`.
Terminal: `shipped`, `closed`. No `previewing` phase — preview readiness is observable from
`deploy_events`, not process state (kills a whole class of reconciler/crew drift).

Legal-edge table (single enforcement point, in **store**, mirroring `admitSpec`'s role —
an illegal transition throws; the mutation never happened):

| from → to                               | actor / trigger                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| intent → queued                         | human/composer `queue` verb (the `agent-work` label remains the verb; it now stamps phase)                                              |
| intent, queued → closed                 | human close                                                                                                                             |
| queued → building                       | dispatcher, **CAS**: `UPDATE … SET phase='building' WHERE …AND phase='queued'`; changes()==1 ⇔ claimed                                  |
| building → reviewing                    | `attachChange` (replaces createPr)                                                                                                      |
| building, reviewing, reworking → parked | dispatcher, with `parked_reason` ∈ `preview-never-up, rework-exhausted, untestable, merge-failed, self-repo-human-merge`                |
| reviewing → reworking                   | verdict ❌, `countAttempts < maxRework`                                                                                                 |
| reworking → reviewing                   | fix pushed, re-review begins                                                                                                            |
| reviewing → shipped                     | verdict ✅/⚠️ → `mergeBranch` + prod kick + `change_state='merged'`                                                                     |
| reviewing, reworking, parked → shipped  | human Merge (self-repo path; parked rescue)                                                                                             |
| parked → queued                         | human Re-queue (attempts keep counting)                                                                                                 |
| any non-terminal → closed               | human close; open change → `change_state='closed'` → reconciler prunes preview + data branch (reconcile.ts:391-429 semantics unchanged) |

`state` (existing open/closed column) becomes **derived**: `closed ⇔ phase ∈ {shipped, closed}`,
maintained only inside `setWorkPhase` — one write site, old readers keep working during cutover.
Labels become **taxonomy only** (`import`, `bug`, …); the seven crew phase labels die. Dispatcher
role selection keeps reading labels (`agent-import` is taxonomy, not state — it stays).

**Human-pushed branches get first-class symmetry**: `POST /work {title, body?, head}` creates an
item with the change pre-attached, born at `reviewing`. This subsumes 100% of "open a PR" and is
strictly better: the adversarial reviewer QAs _human_ code through the same preview+verdict
machinery. The crew process and the human process become the same process, differing only in
who occupies `building`.

**Boot sweep** (dispatcher `start()`): `building`/`reworking` with no in-flight process →
re-`queued` with an explanatory comment; `reviewing` → resume the review wait-loop from the last
attempt row. Crash recovery exists for the first time.

### 2.2 Cross-app dependencies

`issue_deps` (bare INTEGER blocked_by, same-repo by schema, unused live) is frozen. New table
carries **full coordinates on both sides** (schema is future-proof; no later migration needed),
but forge **enforces same-owner** for now — exactly what Thread 5's org-decomposer needs
("website blocked by shop#3") and nothing more. Cross-owner deps: cut, speculative; lifting the
check later is a one-line change, not a migration. Authz: write on the blocked item's repo
(`canWriteOwner`, forge.ts:174-180); existence/read on the blocker (M1 public-read). Cycle check:
the existing DFS (forge.ts:563-580) generalized from ints to `(owner,repo,number)` triples.
Dispatcher DAG gate (dispatcher.ts:99-104) becomes `openWorkBlockers` — a blocker counts as open
unless its phase is terminal.

---

## 3. Schema — migration 9 (append to `MIGRATIONS`, `packages/store/src/schema.ts`)

Live list has 8 entries (tcp_ports landed as #8 since the map was written).

```sql
-- migration 9 — work items: the issue is the unit of work; the PR collapses into
-- change fields + an attempts ledger. pull_requests is frozen (read-only history);
-- no new PR numbers are ever minted.
ALTER TABLE issues ADD COLUMN phase TEXT NOT NULL DEFAULT 'intent';
ALTER TABLE issues ADD COLUMN head_ref TEXT;
ALTER TABLE issues ADD COLUMN base_ref TEXT;
ALTER TABLE issues ADD COLUMN change_state TEXT;   -- 'open'|'merged'|'closed'|NULL
ALTER TABLE issues ADD COLUMN parked_reason TEXT;
CREATE INDEX issues_phase ON issues (phase);

CREATE TABLE work_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  head_sha TEXT,
  builder_cost_usd REAL,
  verdict TEXT,             -- 'pass'|'concerns'|'fail'|'untestable'|NULL while building
  verdict_line TEXT,
  reviewer_cost_usd REAL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner, repo, number, attempt)
);

CREATE TABLE work_deps (
  owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
  on_owner TEXT NOT NULL, on_repo TEXT NOT NULL, on_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, repo, number, on_owner, on_repo, on_number)
);
CREATE INDEX work_deps_item ON work_deps (owner, repo, number);
```

No table renamed or dropped (renames are rewrites). `issue_comments` untouched — numbers are
unambiguous once PRs mint none, and no historic PR has comments (comments were issue-only).
Mitosis untouched: the platform DB never travels; daughters run the full migration list against
an empty DB — frozen `pull_requests` is vestigial and empty there, zero cost.

**Backfill** (one-shot alongside migration 9, pure SQL + one regex pass):

1. For each `pull_requests` row with `head_ref` matching `agent/issue-(\d+)`: stamp the captured
   issue's `head_ref/base_ref/change_state` from the PR row. (All 8 live pairs match; all merged.)
2. Labels → phase: `agent-work→queued`, `agent-building→building`, `agent-reviewing→reviewing`,
   `agent-reworking→reworking`, `agent-shipped→shipped`, `agent-failed|agent-review-failed→parked`
   (reason `migrated`); strip phase labels from the labels string (keep `agent-work` only on
   still-queued items); everything else → `intent` (closed issues → `closed`).
3. Copy `issue_deps` → `work_deps` with `on_owner=owner, on_repo=repo` (table unused live).
4. Any stragglers in active phases at migration time → `parked(migrated)`, never guessed.

---

## 4. API shape (`packages/opd/src/api.ts`) — one family replaces two

Replaces api.ts:435-534 (/pulls) and :603-745 (/issues):

- `POST /api/v1/repos/:o/:r/work` `{title, body?, labels?, head?}` — with `head`: validate
  branch exists ≠ base (lift createPr checks, forge.ts:384-401), attach change, born `reviewing`.
  Without: `intent` (`queued` if labels include `agent-work`).
- `GET /api/v1/repos/:o/:r/work?phase=…&state=…` · `GET /api/v1/work?phase=…` (platform-wide
  crew queue for dashboard/heartbeat).
- `GET /api/v1/repos/:o/:r/work/:n` →

```json
{
  "number": 7,
  "owner": "greener",
  "repo": "shop",
  "title": "…",
  "body": "…",
  "author": "trevato",
  "state": "open",
  "labels": ["agent-work"],
  "phase": "reviewing",
  "parkedReason": null,
  "change": {
    "head": "agent/issue-7",
    "base": "main",
    "state": "open",
    "diffStat": { "files": 3, "adds": 120, "dels": 8 },
    "preview": "https://pr-7-shop-greener.plat.dev"
  },
  "attempts": [
    {
      "attempt": 1,
      "verdict": "fail",
      "verdictLine": "FAIL — cart total ignores qty",
      "builderCostUsd": 1.42,
      "reviewerCostUsd": 0.31,
      "headSha": "ab12…"
    }
  ],
  "blockedBy": [
    { "owner": "greener", "repo": "site", "number": 3, "phase": "building" }
  ]
}
```

- `POST …/work/:n/{queue,comments,close,merge,deps}` · `DELETE …/work/:n/deps/:do/:dr/:dn`.
  `deps` takes `{on: "owner/repo#n"}`; `merge` is the human control for parked/self-repo items.
- **Compat, one release**: `/issues/:n` → 301 `/work/:n` (identity — same numbers);
  `/pulls` list = items with `change_state='open'`; `/pulls/:num` resolves historic numbers via
  the frozen table → 301. Then delete. Only consumers are console, crew, sim — all in-tree.

---

## 5. File-level change list (shippable order)

1. **`packages/store/src/schema.ts`** — migration 9 + backfill (§3).
2. **`packages/store/src/index.ts`** — `setWorkPhase(from[], to)` with the legal-edge table
   (illegal → throw; CAS `WHERE phase IN (from)`); `claimWork` (queued→building CAS);
   `attachChange`; `listOpenChanges` (replaces `listOpenPrs`, :604-611); `openWorkAttempt` /
   `setAttemptVerdict` / `countAttempts`; `listWorkByPhase` (indexed — delete the JS
   label-filter, :695-700); `openWorkBlockers` cross-repo join; work_deps ops.
   Delete `createPr/getPr/setPrState/listPrs` after callers move — no delegation shims.
   _This step is additive and can land early as a standalone reliability fix._
3. **`packages/opd/src/crew/dispatcher.ts`** — drop the seven label constants (:15-21); read
   `listWorkByPhase('queued')`; claim via CAS; every `setLabels` state-write becomes a guarded
   `setWorkPhase`; persist attempts (open row before `runBuilder`, stamp verdict after
   `runReviewer`); `maxRework` compares `countAttempts`, not a local (:206-207, 325 fixed);
   boot sweep in `start()`; self-repo path parks with `self-repo-human-merge` (fixes the
   :179-187 mislabel). Role selection keeps reading taxonomy labels (:394-398).
   **`crew/builder.ts:303-311`** — `forge.createPr` → `forge.attachChange(n, {head})`;
   branch `agent/issue-N` and ISSUE.md **unchanged**.
   **`crew/reviewer.ts`** — prior attempts' verdict lines added to prompt context.
4. **`packages/forge/src/forge.ts:368-636`** — collapse the two op families into one:
   `createWork` (absorbs createIssue + createPr validation, optional `{head}` → born reviewing),
   `queueWork` (label verb → phase stamp; keeps setIssueLabels' external contract),
   `attachChange`, `mergeWork` (mergeBranch + change_state + phase), `closeWork`, `comment`
   (unchanged), `setLabels` (taxonomy only), `addDep/removeDep` (same-owner enforced,
   triple-keyed cycle DFS).
5. **`packages/opd/src/api.ts`** — §4; delete the parallel families; on-ramp (:246-278) files
   its first work item at `queued` (same `agent-work` verb underneath).
6. **`packages/opd/src/reconcile.ts:380-429`** — `convergePreviews` iterates
   `store.listOpenChanges()`; prune keys off `change_state` transitions. Preview host stays
   `pr-<n>-<app>-<owner>` with n = the work number (`pr-` is an inert prefix; gate/host pattern
   and data-branch dirs `<app>@<branch>` untouched).
7. **`packages/opd/src/console/index.ts`** — one **Work** tab (kills :527-536, :606-614 twins);
   one detail route merging :760-824 and :827-949; **one phase-driven stepper** on server and
   client (kills the `agent-reworking` renderer drift :51-86 vs :928-940 and the pr.state label
   faking :790-795); human stepper mapping unchanged: intent/queued="Got it",
   building/reworking="Building it", reviewing="Making sure it works", shipped="Live",
   parked/closed explicit. `mdLite` `#N` → `/work/:n` (:886 — fixes a live wrong-link bug).
   Redirects `/issues/:n → /work/:n`, `/pulls/:n → legacy lookup`.
8. **`genesis/platform/crew/*/instructions.md` + live commit to plat/platform** (two-place
   discipline, map §3.2) — prompts speak "work item #N", never "PR"; document the `queue` verb,
   phases, and the attempts ledger. Hot-reloads (platform-config.ts:121-152); no restart.
9. **`test/sim/`** — see §6.

**Cutover guard**: ship steps 3-7 only with no items in `building/reviewing/reworking`
(live: all 8 shipped — currently safe); backfill parks stragglers.

---

## 6. Test plan

**Sim oracle invariants** (`test/sim/invariants.ts`):

- Every item has exactly one phase; every observed transition is a legal edge.
- No item is `building` in two dispatcher ticks with different attempt rows open (CAS invariant).
- Attempt numbers strictly monotone per item; `countAttempts ≤ maxRework + 1`.
- `preview host exists ⇔ change_state='open'` (replaces the listOpenPrs coupling check, :266-303).
- `shipped ⇒ change_state='merged'` and branch merged; `closed with head_ref ⇒ change_state='closed'`
  and preview + data branch pruned.
- `state` column always equals the phase derivation (guards the compat mirror).
- Restart mid-flight (kill between builder and reviewer): boot sweep re-queues or resumes; no
  item stranded in `building`.

**Persona op mix** (`test/sim/personas.ts:532-585, 734-758`):

- Builder persona files work, queues, ships. New: create-work-with-`head` (human PR path) →
  expect born-reviewing → reviewer verdict → human merge.
- Attacker probes: non-writer cannot `queue`/`merge`/transition; illegal phase jump via API →
  rejected, state unchanged; cross-owner dep → rejected; dep cycle across two repos → rejected;
  writing phase labels via `setLabels` does NOT change phase.
- Cross-repo DAG: file A blocked-by B (same owner, different repos); crew must not claim A until
  B terminal; parked B keeps A blocked; closed B unblocks.

**E2E** (`test/e2e/`): on-ramp → queued → shipped happy path against real Platform.up();
parked → console Re-queue → shipped; self-repo item parks with `self-repo-human-merge` and human
Merge ships it; `/pulls/:n` and `/issues/:n` redirects resolve.

---

## 7. What does NOT change

- **Git layer, entirely**: smart-HTTP, `diffStat`, `mergeBranch`, `emitPush` (githost.ts).
  External tools clone/push/fetch `agent/issue-N` branches exactly as before; merges remain
  ordinary merge commits. PRs never existed at the git level here (no `refs/pull/*`).
- Branch convention `agent/issue-N`, ISSUE.md, preview host scheme `pr-N-…`, data-branch naming.
- `policy.ts` AppSpec, `deployVariant`, gate, engine, identity, data CoW, secrets, mitosis
  genome list (work state was never genome content; shipped _intent_ already travels in git).
- `issues` table name, existing issue numbers and URLs, `issue_comments`.
- The `agent-work` label as the human/composer enqueue verb; composer output format.
- Store discipline: migrations stay append-only; old tables shadowed, never edited.

---

## 8. Rejected ideas (and why)

| Idea (source)                                                             | Why rejected                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| New `changes` spine table + one new number sequence (B)                   | A rewrite by another name: orphan renumbering, permanent `legacy_pr_number` redirect machinery, big backfill. The collision problem is solved cheaper by never minting PR numbers again.                         |
| Rename branch `agent/issue-N`→`change/N`, hosts `pr-`→`chg-` (B)          | Pure churn: breaks sim greps, reviewer instructions, data-branch dirs; zero capability. Names are conventions, not couplings.                                                                                    |
| `ALTER TABLE issue_comments RENAME` (B)                                   | Renames are rewrites; comments were always issue-only and stay valid untouched.                                                                                                                                  |
| Delete `/issues` + `/pulls` routes immediately (B)                        | One release of thin compat reads + 301s costs ~20 lines and de-risks in-tree stragglers and live scripts.                                                                                                        |
| Keep both forge/API families "frozen" alive (A)                           | Two implementations of one subsystem — the exact pattern the platform bans. Delete a family, don't bridge it.                                                                                                    |
| Keep labels as the state machine + persist only `attempt` (A)             | Comma-string parsing stays the enforcement point; "policy is enforced or the mutation never happened" demands a typed, guarded phase column.                                                                     |
| Keep minting PR numbers with an `issue_id` link (A)                       | Perpetuates two sequences and the `#N` ambiguity forever; mdLite stays unfixable.                                                                                                                                |
| Polymorphic `kind='issue'                                                 | 'pr'` work_items table (B rejected too)                                                                                                                                                                          | Preserves the split inside one table. The correct model is one kind with an optional change. |
| A `previewing` phase (B)                                                  | Preview readiness is deploy_events observability, not process state — a phase for it re-creates reconciler/crew drift.                                                                                           |
| Cross-owner deps now (B, C schema-permitted)                              | Speculative; Thread 5 needs same-owner only. Schema carries full coordinates so lifting the check later is one line, not a migration.                                                                            |
| PR-level review threads / inline comments (A cut)                         | No human review queue exists; the reviewer's verdict is a comment. State with no consumer.                                                                                                                       |
| pkt-line ref parsing for "branch updated" events now (all three deferred) | Not required for unification. Phase 2, prerequisite only for humans and agents co-authoring branches (push to a work branch → stamp head_sha, `reworking→reviewing`). Body is already buffered (githost.ts:229). |
| Third noun in the API (`/changes` alongside…)                             | One noun: **work**. `/work` replaces both families; "Work" is also the console tab.                                                                                                                              |

---

## 9. Sequencing note

Campaign rank stays #5, but **step 2 (store primitives + attempts persistence) is a standalone
additive reliability fix** — land it early; every later thread's crew work gains restart-safe
attempts, and Thread 5's org-decomposer needs `work_deps` + the `queue` verb specifically.
Phase-2 follow-up (post-unification): pkt-line push refs → human/agent co-authoring on work
branches.
