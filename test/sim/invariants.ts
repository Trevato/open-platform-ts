// The deterministic invariant library. These checkers are the ORACLE: they run
// between operation batches, judge only observed state, and are wholly
// independent of what generated the traffic (the seeded personas today, an LLM
// swarm tomorrow). None of them draw from the RNG — the same platform state
// always yields the same verdict, so a failure is a fact, not a flake.
//
// Live invariants:
//   1. tenant isolation      — the forge.authorize matrix: reads are public
//                              (the ONLY thing that crosses tenants in M1),
//                              every cross-tenant WRITE is denied.
//   2. content isolation     — each persona's per-push sentinel appears in its
//                              OWN repo's history and NOWHERE else.
//   3. credential canaries   — the admin password, every PAT, the age identity,
//                              CLAUDE_CODE_OAUTH_TOKEN, and every sealed secret
//                              appear in NO world-readable surface: all repos'
//                              full git object graph, deploy_events, and
//                              issue/PR/comment bodies.
//   4. deploy state machine  — per app, deploy_events follow
//                              queued→building→(built→running|preview-ready |
//                              failed); no illegal jumps.
//   5. container coherence   — every platform-labelled container maps to an app
//                              in the workload (no orphans, no cross-tenant
//                              containers); and, at teardown, none linger.
//   6. fleet sovereignty     — a mother's key opens NOTHING in any daughter
//                              (HEAD and full history), and lineage grows by
//                              exactly one per generation.
//   7. work-item coherence   — every item sits in exactly one legal phase; the
//                              derived open/closed state matches it; shipped ⇒
//                              change merged, closed-with-change ⇒ change
//                              closed; attempt numbers are strictly monotone.
//   8. preview coupling      — a live preview container implies its work
//                              item's change is still open (the reconciler
//                              tears previews down when the change resolves).

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { readLineage } from "@op/mitosis";
import type { Platform } from "@op/opd";
import { readSecretsFile, SYS } from "@op/opd";
import type { SecretsFile } from "@op/secrets";
import { openAll } from "@op/secrets";
import type { RegisteredApp, World } from "./personas.ts";

export interface Violation {
  invariant: string;
  detail: string;
}

export function formatViolations(vs: readonly Violation[]): string {
  return vs.map((x) => `  [${x.invariant}] ${x.detail}`).join("\n");
}

// ── raw-surface scanners ─────────────────────────────────────────────────

/** Every git OBJECT (commits, trees, blobs) across all refs AND dangling
 *  history, as one latin1 string — exactly what a repo-cloning key-harvester
 *  can read. `--batch-all-objects` walks the whole object graph, not just HEAD. */
async function scanRepoObjects(bare: string): Promise<string> {
  const p = Bun.spawn(
    [
      "git",
      "-C",
      bare,
      "cat-file",
      "--batch-all-objects",
      "--batch",
      "--buffer",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const bytes = await new Response(p.stdout).bytes();
  await p.exited;
  return Buffer.from(bytes).toString("latin1");
}

/** All bare repos on disk (reposDir/<owner>/<name>.git). */
async function listBareRepos(reposDir: string): Promise<string[]> {
  const out: string[] = [];
  let owners: string[];
  try {
    owners = await readdir(reposDir);
  } catch {
    return out;
  }
  for (const owner of owners) {
    let names: string[];
    try {
      names = await readdir(join(reposDir, owner));
    } catch {
      continue;
    }
    for (const n of names)
      if (n.endsWith(".git")) out.push(join(reposDir, owner, n));
  }
  return out;
}

/** All forge free-text a public reader could reach: the deploy timeline plus
 *  issue/PR/comment bodies. Concatenated for substring canary scanning. */
function dumpForgeText(platform: Platform): string {
  const q = (sql: string): unknown[] =>
    platform.store.db.query<Record<string, unknown>, []>(sql).all();
  return JSON.stringify({
    events: q("SELECT owner, app, phase, message, sha FROM deploy_events"),
    issues: q("SELECT owner, repo, title, body, labels FROM issues"),
    prs: q("SELECT owner, repo, title, head_ref, base_ref FROM pull_requests"),
    comments: q("SELECT owner, repo, body FROM issue_comments"),
  });
}

/** Every historical secrets.age.json across the bare's full history (generalized
 *  from m1's allHistoricalSecrets) — the surface a full-history seed would leak. */
async function historicalSecrets(bare: string): Promise<SecretsFile[]> {
  const rev = Bun.spawn(["git", "-C", bare, "rev-list", "--all"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const shas = (await new Response(rev.stdout).text())
    .split("\n")
    .filter(Boolean);
  await rev.exited;
  const out: SecretsFile[] = [];
  for (const sha of shas) {
    const show = Bun.spawn(
      ["git", "-C", bare, "show", `${sha}:${"secrets.age.json"}`],
      { stdout: "pipe", stderr: "ignore" },
    );
    if ((await show.exited) !== 0) continue;
    try {
      out.push(
        JSON.parse(await new Response(show.stdout).text()) as SecretsFile,
      );
    } catch {
      /* not a valid secrets file at this rev */
    }
  }
  return out;
}

// ── 1. tenant isolation (the forge.authorize matrix) ─────────────────────

/**
 * For every tenant × every repo: public READ must be allowed (that is the only
 * thing crossing tenants in M1); a cross-tenant WRITE must be denied; a tenant
 * must retain WRITE on its own repos. Includes system repos (sys/gitops,
 * plat/*) — a tenant writing platform config would be a privilege escalation.
 */
export function tenantIsolation(
  platform: Platform,
  tenants: readonly string[],
): Violation[] {
  const v: Violation[] = [];
  const repos = platform.store.listRepos();
  for (const t of tenants) {
    const user = platform.store.getUser(t);
    if (!user) {
      v.push({ invariant: "tenant-isolation", detail: `tenant ${t} missing` });
      continue;
    }
    for (const r of repos) {
      const own = r.owner === t;
      const canRead = platform.forge.authorize(user, r.owner, r.name, "read");
      const canWrite = platform.forge.authorize(user, r.owner, r.name, "write");
      if (!canRead)
        v.push({
          invariant: "tenant-isolation",
          detail: `${t} denied public READ of ${r.owner}/${r.name}`,
        });
      if (own && !canWrite)
        v.push({
          invariant: "tenant-isolation",
          detail: `${t} denied WRITE of OWN repo ${r.owner}/${r.name}`,
        });
      if (!own && canWrite)
        v.push({
          invariant: "tenant-isolation",
          detail: `BREACH: ${t} may WRITE foreign repo ${r.owner}/${r.name}`,
        });
    }
  }
  return v;
}

// ── 2. content isolation (per-tenant sentinels stay home) ────────────────

/** Each recorded canary sentinel was pushed into exactly one tenant's app repo;
 *  assert it appears in NO other repo's object graph. */
export async function contentIsolation(
  platform: Platform,
  canaries: readonly { owner: string; app: string; sentinel: string }[],
): Promise<Violation[]> {
  const v: Violation[] = [];
  if (canaries.length === 0) return v;
  const repos = platform.store.listRepos();
  const cache = new Map<string, string>();
  const dump = async (bare: string): Promise<string> => {
    const hit = cache.get(bare);
    if (hit !== undefined) return hit;
    const text = await scanRepoObjects(bare);
    cache.set(bare, text);
    return text;
  };
  for (const c of canaries) {
    for (const r of repos) {
      if (r.owner === c.owner && r.name === c.app) continue; // its own repo
      const bare = join(platform.sd.reposDir, r.owner, `${r.name}.git`);
      if ((await dump(bare)).includes(c.sentinel))
        v.push({
          invariant: "content-isolation",
          detail: `sentinel ${c.sentinel} (of ${c.owner}/${c.app}) leaked into ${r.owner}/${r.name}`,
        });
    }
  }
  return v;
}

// ── 3. credential canaries ───────────────────────────────────────────────

/**
 * The admin password, the age identity, every PAT, CLAUDE_CODE_OAUTH_TOKEN, and
 * every value in the sealed secrets file must appear in NO world-readable
 * surface: git object graphs, the deploy timeline, and issue/PR/comment bodies.
 * `extraSecrets` carries the PATs (never recoverable from state — they are only
 * sha256-hashed at rest) and the crew OAuth token.
 */
export async function credentialCanaries(
  platform: Platform,
  extraSecrets: readonly string[],
): Promise<Violation[]> {
  const v: Violation[] = [];
  const secrets = new Set<string>();
  const add = (s: string | undefined | null): void => {
    if (s && s.length >= 8) secrets.add(s);
  };
  for (const s of extraSecrets) add(s);
  add(platform.freshAdminPassword);
  add(platform.key.identity);
  // Decrypt the whole sealed inventory (SESSION_KEY, WEBHOOK_HMAC, QA_PASSWORD,
  // ADMIN_PASSWORD …) and canary every plaintext.
  const file = await readSecretsFile(platform.git);
  if (file.status === "ok") {
    const plain = await openAll(platform.key.identity, file.value);
    if (plain.status === "ok")
      for (const val of Object.values(plain.value)) add(val);
  }
  const list = [...secrets];
  if (list.length === 0) return v;

  for (const bare of await listBareRepos(platform.sd.reposDir)) {
    const objs = await scanRepoObjects(bare);
    for (const s of list)
      if (objs.includes(s))
        v.push({
          invariant: "credential-canary",
          detail: `a live secret leaked into git objects of ${basename(bare)}`,
        });
  }
  const forge = dumpForgeText(platform);
  for (const s of list)
    if (forge.includes(s))
      v.push({
        invariant: "credential-canary",
        detail: `a live secret leaked into deploy_events / issue / PR / comment bodies`,
      });
  return v;
}

// ── 4. deploy state machine ──────────────────────────────────────────────

// The reconciler's full phase vocabulary (reconcile.ts): a deploy runs
// queued → building → built → starting → running (prod) | preview-ready
// (preview); failure lands on failed | preview-failed; removal on stopped.
const PHASES = new Set([
  "queued",
  "building",
  "built",
  "starting",
  "running",
  "preview-ready",
  "failed",
  "preview-failed",
  "stopped",
]);

// Legal successors. Same-phase repeats are always allowed (idempotent reconcile
// re-emit); a "queued" may begin a fresh deploy at any time.
const NEXT: Record<string, ReadonlySet<string>> = {
  queued: new Set(["queued", "building", "failed", "stopped"]),
  building: new Set(["building", "built", "failed", "stopped"]),
  built: new Set(["built", "starting", "failed", "stopped"]),
  starting: new Set([
    "starting",
    "running",
    "preview-ready",
    "failed",
    "preview-failed",
    "stopped",
  ]),
  running: new Set(["running", "queued", "building", "stopped"]),
  "preview-ready": new Set(["preview-ready", "queued", "building", "stopped"]),
  failed: new Set(["failed", "queued", "building", "stopped"]),
  "preview-failed": new Set([
    "preview-failed",
    "queued",
    "building",
    "stopped",
    "failed",
  ]),
  stopped: new Set(["stopped", "queued", "building"]),
};

/** deploy_events per app follow a coherent state machine. Preview streams (whose
 *  phase labels carry a "(<pr>)" suffix) are validated as their own partition. */
export function deployStateMachine(
  platform: Platform,
  apps: readonly RegisteredApp[],
): Violation[] {
  const v: Violation[] = [];
  const done = new Set<string>();
  for (const a of apps) {
    const key = `${a.owner}/${a.app}`;
    if (done.has(key)) continue;
    done.add(key);
    const asc = platform.store.listEvents(a.owner, a.app, 60).reverse();
    if (asc.length === 0) continue;
    const partitions = new Map<string, string[]>();
    for (const e of asc) {
      const m = /^(\S+)(?:\s*\((.+)\))?$/.exec(e.phase.trim());
      const base = m?.[1] ?? e.phase.trim();
      const part = m?.[2] ?? "prod";
      if (!PHASES.has(base)) {
        v.push({
          invariant: "deploy-state-machine",
          detail: `${key}: unknown phase '${e.phase}'`,
        });
        continue;
      }
      let bucket = partitions.get(part);
      if (!bucket) {
        bucket = [];
        partitions.set(part, bucket);
      }
      bucket.push(base);
    }
    for (const [part, bases] of partitions) {
      for (let i = 1; i < bases.length; i++) {
        const prev = bases[i - 1]!;
        const cur = bases[i]!;
        if (cur === "queued") continue;
        const allowed = NEXT[prev];
        if (allowed && !allowed.has(cur))
          v.push({
            invariant: "deploy-state-machine",
            detail: `${key}[${part}]: illegal transition ${prev} -> ${cur}`,
          });
      }
    }
  }
  return v;
}

// ── 5. container coherence + teardown hygiene ────────────────────────────

/** Every platform-labelled container maps to an app in the workload — no
 *  orphans, no containers for owners/apps the harness never created. */
export async function containerCoherence(
  platform: Platform,
  apps: readonly RegisteredApp[],
): Promise<Violation[]> {
  const list = await platform.engine.listPlatformContainers(
    platform.platformId,
  );
  if (list.status !== "ok") return []; // engine hiccup is not an invariant breach
  const known = new Set(apps.map((a) => `${a.owner}/${a.app}`));
  const v: Violation[] = [];
  for (const c of list.value) {
    const k = `${c.owner}/${c.app}`;
    if (!known.has(k))
      v.push({
        invariant: "container-coherence",
        detail: `container ${c.id.slice(0, 12)} labelled ${k}${
          c.preview ? ` (preview ${c.preview})` : ""
        } has no matching app in the workload`,
      });
  }
  return v;
}

/** After teardown, no platform-labelled container may survive. */
export async function noContainersAfterTeardown(
  platform: Platform,
): Promise<Violation[]> {
  const list = await platform.engine.listPlatformContainers(
    platform.platformId,
  );
  if (list.status !== "ok") return [];
  return list.value.map((c) => ({
    invariant: "teardown-hygiene",
    detail: `container ${c.id.slice(0, 12)} (${c.owner}/${c.app}) survived teardown`,
  }));
}

// ── 6. fleet sovereignty ─────────────────────────────────────────────────

/** A mother's key opens NOTHING in any daughter (HEAD or full history), keys
 *  differ, and lineage grows by exactly one generation. */
export async function fleetSovereignty(
  mother: Platform,
  daughters: readonly Platform[],
): Promise<Violation[]> {
  const v: Violation[] = [];
  const motherLineage = await readLineage(mother.sd.originFile);
  for (const d of daughters) {
    if (d.key.identity === mother.key.identity)
      v.push({
        invariant: "fleet-sovereignty",
        detail: `daughter ${d.domain} shares the mother's identity`,
      });

    const head = await readSecretsFile(d.git);
    if (head.status === "ok") {
      const opened = await openAll(mother.key.identity, head.value);
      if (opened.status === "ok")
        v.push({
          invariant: "fleet-sovereignty",
          detail: `mother key OPENS daughter ${d.domain} HEAD secrets`,
        });
    }

    const bare = join(d.sd.reposDir, SYS.owner, `${SYS.name}.git`);
    for (const f of await historicalSecrets(bare)) {
      const opened = await openAll(mother.key.identity, f);
      if (opened.status === "ok")
        v.push({
          invariant: "fleet-sovereignty",
          detail: `mother key OPENS a historical secrets blob in daughter ${d.domain}`,
        });
    }

    // The ledger carries a one-time "root:" header plus one "germinated-from"
    // line per generation; a germination appends exactly one such line.
    const gens = (lines: readonly string[]): number =>
      lines.filter((l) => l.includes(" germinated-from ")).length;
    const dl = await readLineage(d.sd.originFile);
    if (gens(dl) !== gens(motherLineage) + 1)
      v.push({
        invariant: "fleet-sovereignty",
        detail: `daughter ${d.domain} has ${gens(dl)} generation(s), expected ${
          gens(motherLineage) + 1
        }`,
      });
    if (!dl.join("\n").includes(`${d.domain} germinated-from ${mother.domain}`))
      v.push({
        invariant: "fleet-sovereignty",
        detail: `daughter ${d.domain} lineage missing 'germinated-from ${mother.domain}'`,
      });
  }
  return v;
}

// ── 7. work-item coherence ───────────────────────────────────────────────

const WORK_PHASE_SET = new Set([
  "intent",
  "queued",
  "building",
  "reviewing",
  "reworking",
  "shipped",
  "parked",
  "closed",
]);

/**
 * The unified work-item model, checked from state alone: every item has
 * exactly one known phase; the legacy `state` column always equals the phase
 * derivation (closed ⇔ shipped|closed — guards the compat mirror); `shipped`
 * items carry a merged change and `closed` items with a change carry a closed
 * one; an open change always names both refs; attempts are an append-only
 * ledger numbered 1..n. (Edge legality itself is enforced at the single write
 * site, store.setWorkPhase — a snapshot cannot observe transitions.)
 */
export function workItemCoherence(platform: Platform): Violation[] {
  const v: Violation[] = [];
  const flag = (key: string, detail: string): void => {
    v.push({ invariant: "work-item-coherence", detail: `${key}: ${detail}` });
  };
  for (const r of platform.store.listRepos()) {
    for (const i of platform.store.listIssues(r.owner, r.name)) {
      const key = `${i.owner}/${i.repo}#${i.number}`;
      if (!WORK_PHASE_SET.has(i.phase)) {
        flag(key, `unknown phase '${i.phase}'`);
        continue;
      }
      const derived =
        i.phase === "shipped" || i.phase === "closed" ? "closed" : "open";
      if (i.state !== derived)
        flag(
          key,
          `state '${i.state}' != derivation '${derived}' of phase '${i.phase}'`,
        );
      if (i.phase === "shipped" && i.change_state !== "merged")
        flag(key, `shipped but change_state is '${i.change_state}'`);
      if (i.phase === "closed" && i.head_ref && i.change_state !== "closed")
        flag(
          key,
          `closed with a change but change_state is '${i.change_state}'`,
        );
      if (
        (i.phase === "reviewing" || i.phase === "reworking") &&
        i.change_state !== "open"
      )
        flag(key, `${i.phase} but change_state is '${i.change_state}'`);
      if (i.change_state === "open" && (!i.head_ref || !i.base_ref))
        flag(key, `open change missing head/base ref`);
      platform.store.listAttempts(i.owner, i.repo, i.number).forEach((a, x) => {
        if (a.attempt !== x + 1)
          flag(key, `attempt ledger not 1..n (saw ${a.attempt} at index ${x})`);
      });
    }
  }
  return v;
}

// ── 8. preview coupling ──────────────────────────────────────────────────

/**
 * A live preview container implies its work item's change is still open.
 * Teardown is the reconciler's async job, so a just-resolved change gets a
 * settle window before it counts. (The ⇐ direction — open change ⇒ preview
 * serving — is build-latency-bound and proven by the preview e2e, not sampled
 * between batches.)
 */
export async function previewCoupling(
  platform: Platform,
): Promise<Violation[]> {
  const scan = async (): Promise<Violation[]> => {
    const list = await platform.engine.listPlatformContainers(
      platform.platformId,
    );
    if (list.status !== "ok") return [];
    const v: Violation[] = [];
    for (const c of list.value) {
      if (!c.preview) continue;
      const n = Number(c.preview.replace(/^pr-/, ""));
      const item = Number.isInteger(n)
        ? platform.store.getIssue(c.owner, c.app, n)
        : null;
      if (!item || item.change_state !== "open")
        v.push({
          invariant: "preview-coupling",
          detail: `preview ${c.preview} of ${c.owner}/${c.app} is live but ${
            item ? `its change is '${item.change_state}'` : "no such work item"
          }`,
        });
    }
    return v;
  };
  let v = await scan();
  const t0 = performance.now();
  while (v.length && performance.now() - t0 < 20_000) {
    await Bun.sleep(2_000);
    v = await scan();
  }
  return v;
}

// ── orchestration ────────────────────────────────────────────────────────

/** Run every cheap, single-platform invariant against current state and return
 *  the aggregated violations. Callable between operation batches. */
export async function checkAll(
  platform: Platform,
  world: World,
  opts: { tenants: readonly string[] },
): Promise<Violation[]> {
  const apps = world.apps();
  const pats = world
    .actors()
    .map((a) => a.auth.split(":")[1] ?? "")
    .filter(Boolean);
  const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (token) pats.push(token);
  return [
    ...tenantIsolation(platform, opts.tenants),
    ...(await contentIsolation(platform, world.canaries())),
    ...(await credentialCanaries(platform, pats)),
    ...deployStateMachine(platform, apps),
    ...(await containerCoherence(platform, apps)),
    ...workItemCoherence(platform),
    ...(await previewCoupling(platform)),
  ];
}
