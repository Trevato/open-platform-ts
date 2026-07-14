// Personas — weighted operation generators that drive REAL traffic at a live
// platform over its own HTTPS API and the real `git` CLI. No mocks: a persona
// is a signed-in tenant doing tenant things, its every choice drawn from a
// SimRng child stream so the whole run replays from one master seed.
//
// Design contract (from the DST scout report): personas GENERATE diversity;
// they do not judge correctness — that is the deterministic invariant library's
// job. The two exceptions a persona is entitled to flag itself are (1) an
// operation that threw / 5xx'd (a live server error is almost always a real
// bug) and (2) an ISOLATION BREACH — the attacker using tenant A's credential
// to mutate tenant B and getting a 2xx it should never have gotten. Both record
// ok:false with the reproduction handle (OP_SIM_SEED=…) baked into the detail.
//
// Personas covered: builder, churner, forker, noisyNeighbor, attacker.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimRng } from "./rng.ts";

// ── shared shapes ────────────────────────────────────────────────────────

export interface PlatformTarget {
  /** Origin the tenant reaches, e.g. https://plat.localtest.me:28443 */
  api: string;
  /** Bare platform domain, e.g. plat.localtest.me */
  domain: string;
  /** HTTPS port apps are served on (host header carries the app subdomain). */
  httpsPort: number;
  /** PEM of the platform CA — for fetch({ tls: { ca } }). */
  caPem: string;
  /** Path to ca.crt on disk — for git's GIT_SSL_CAINFO. */
  caFile: string;
}

export interface Actor {
  username: string;
  /** "username:pat" basic-auth pair. */
  auth: string;
}

/** A registered app, keyed so cross-tenant personas can find each other. */
export interface RegisteredApp {
  owner: string;
  app: string;
  /** <app>-<owner>.<domain> */
  host: string;
}

/** One executed operation — a JSONL trace row and a failure record in one. */
export interface OpRecord {
  persona: string;
  actor: string;
  op: string;
  args?: Record<string, unknown>;
  /** false only on a thrown op, a 5xx, or a detected isolation breach. */
  ok: boolean;
  status?: number;
  detail?: string;
  ms: number;
  /** rng.label — carries OP_SIM_SEED and the derivation path for replay. */
  seed: string;
  /** Per-persona monotonic step index. */
  seq: number;
  /** Set when the attacker got a 2xx on a cross-tenant mutation. */
  breach?: boolean;
}

/**
 * Shared, cross-tenant knowledge the runner populates and personas read. The
 * attacker mines foreignApps()/foreignActors(); the invariant library (later)
 * consumes canaries() for the tenant-isolation grep.
 */
export class World {
  private appList: RegisteredApp[] = [];
  private actorList: Actor[] = [];
  private canaryList: { owner: string; app: string; sentinel: string }[] = [];

  recordActor(a: Actor): void {
    if (!this.actorList.some((x) => x.username === a.username))
      this.actorList.push(a);
  }
  recordApp(app: RegisteredApp): void {
    if (!this.appList.some((x) => x.owner === app.owner && x.app === app.app))
      this.appList.push(app);
  }
  recordCanary(owner: string, app: string, sentinel: string): void {
    this.canaryList.push({ owner, app, sentinel });
  }

  actors(): readonly Actor[] {
    return this.actorList;
  }
  apps(): readonly RegisteredApp[] {
    return this.appList;
  }
  canaries(): readonly { owner: string; app: string; sentinel: string }[] {
    return this.canaryList;
  }

  /** Apps NOT owned by `username` — the attacker's targets. */
  foreignApps(username: string): RegisteredApp[] {
    return this.appList.filter((a) => a.owner !== username);
  }
  /** Actors other than `username`. */
  foreignActors(username: string): Actor[] {
    return this.actorList.filter((a) => a.username !== username);
  }
}

export interface PersonaContext {
  target: PlatformTarget;
  actor: Actor;
  /** This actor's derived stream — persona-private entropy. */
  rng: SimRng;
  world: World;
  /** Optional trace sink; the runner appends these to a JSONL file. */
  log?: (rec: OpRecord) => void;
}

export interface Persona {
  readonly name: string;
  /**
   * Execute exactly ONE weighted operation. Never throws — every outcome
   * (including failures) comes back as an OpRecord with the seed embedded.
   */
  step(ctx: PersonaContext): Promise<OpRecord>;
}

// ── low-level clients (HTTP + git), CA-pinned ────────────────────────────

interface HttpOpts {
  auth?: string;
  body?: unknown;
  accept?: string;
  headers?: Record<string, string>;
}

async function http(
  target: PlatformTarget,
  method: string,
  pathOrUrl: string,
  opts: HttpOpts = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${target.api}${pathOrUrl}`;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.auth) headers["authorization"] = `Basic ${btoa(opts.auth)}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.accept) headers["accept"] = opts.accept;
  return fetch(url, {
    method,
    tls: { ca: target.caPem },
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

function repoUrl(
  target: PlatformTarget,
  auth: string,
  owner: string,
  name: string,
): string {
  const host = new URL(target.api).host;
  return `https://${auth}@${host}/${owner}/${name}.git`;
}

function appUrl(target: PlatformTarget, host: string): string {
  return `https://${host}:${target.httpsPort}/`;
}

interface GitResult {
  code: number;
  stderr: string;
}

async function git(
  cwd: string,
  caFile: string,
  ...argv: string[]
): Promise<GitResult> {
  const p = Bun.spawn(["git", ...argv], {
    cwd,
    env: {
      ...process.env,
      GIT_SSL_CAINFO: caFile,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await p.exited;
  return { code, stderr: await new Response(p.stderr).text() };
}

/** Clone → mutate (via `edit`) → commit → push a branch. Returns the git step
 *  that failed, if any. Cleans up its worktree unconditionally. */
async function pushBranch(
  ctx: PersonaContext,
  owner: string,
  repo: string,
  branch: string,
  message: string,
  edit: (dir: string) => Promise<void>,
): Promise<GitResult & { step: string }> {
  const work = await mkdtemp(join(tmpdir(), "op-sim-git-"));
  try {
    const { target, actor } = ctx;
    const url = repoUrl(target, actor.auth, owner, repo);
    let r = await git(work, target.caFile, "clone", "-q", url, "src");
    if (r.code !== 0) return { ...r, step: "clone" };
    const dir = join(work, "src");
    if (branch !== "main") {
      r = await git(dir, target.caFile, "checkout", "-q", "-b", branch);
      if (r.code !== 0) return { ...r, step: "checkout" };
    }
    await edit(dir);
    r = await git(dir, target.caFile, "add", "-A");
    if (r.code !== 0) return { ...r, step: "add" };
    r = await git(
      dir,
      target.caFile,
      "-c",
      "user.email=sim@op",
      "-c",
      "user.name=sim",
      "commit",
      "-q",
      "-m",
      message,
    );
    if (r.code !== 0) return { ...r, step: "commit" };
    r = await git(
      dir,
      target.caFile,
      "push",
      "-q",
      "origin",
      `${branch === "main" ? "HEAD:main" : branch}`,
    );
    return { ...r, step: "push" };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ── op framework ─────────────────────────────────────────────────────────

interface Outcome {
  ok: boolean;
  status?: number;
  detail?: string;
  args?: Record<string, unknown>;
  breach?: boolean;
}

interface Op<S> {
  name: string;
  /** Dynamic weight; return 0 to make this op ineligible for this step. */
  weight: (state: S, ctx: PersonaContext) => number;
  run: (ctx: PersonaContext, state: S) => Promise<Outcome>;
}

/** A live server error is worth surfacing; anything else that got a response is
 *  a successful probe (the oracle decides correctness). */
const okStatus = (status: number): boolean => status < 500;

/** Build an Outcome from a response, attaching the body only on a 5xx. Avoids
 *  assigning an explicit `undefined` (exactOptionalPropertyTypes). */
async function statusOutcome(
  res: Response,
  args: Record<string, unknown>,
): Promise<Outcome> {
  const ok = okStatus(res.status);
  const out: Outcome = { ok, status: res.status, args };
  if (!ok) out.detail = await res.text();
  return out;
}

function definePersona<S>(
  name: string,
  initState: () => S,
  ops: Op<S>[],
): () => Persona {
  return () => {
    const state = initState();
    let seq = 0;
    return {
      name,
      async step(ctx: PersonaContext): Promise<OpRecord> {
        const t0 = performance.now();
        const candidates: { value: Op<S>; weight: number }[] = ops
          .map((o) => ({ value: o, weight: Math.max(0, o.weight(state, ctx)) }))
          .filter((c) => c.weight > 0);
        const thisSeq = seq++;
        let opName = "idle";
        let outcome: Outcome;
        if (candidates.length === 0) {
          outcome = { ok: true, detail: "no eligible op" };
        } else {
          const chosen = ctx.rng.weighted(candidates);
          opName = chosen.name;
          try {
            outcome = await chosen.run(ctx, state);
          } catch (e) {
            outcome = { ok: false, detail: `threw: ${String(e)}` };
          }
        }
        const rec: OpRecord = {
          persona: name,
          actor: ctx.actor.username,
          op: opName,
          ok: outcome.ok,
          ms: Math.round(performance.now() - t0),
          seed: ctx.rng.label,
          seq: thisSeq,
        };
        if (outcome.args) rec.args = outcome.args;
        if (outcome.status !== undefined) rec.status = outcome.status;
        if (outcome.breach) rec.breach = true;
        const tag = `[${ctx.rng.label} op=${opName} seq=${thisSeq}]`;
        if (!outcome.ok)
          rec.detail = outcome.detail ? `${outcome.detail} ${tag}` : tag;
        else if (outcome.detail) rec.detail = outcome.detail;
        ctx.log?.(rec);
        return rec;
      },
    };
  };
}

// ── shared operations ────────────────────────────────────────────────────

interface AppState {
  apps: RegisteredApp[];
}

async function createApp(
  ctx: PersonaContext,
  state: AppState,
): Promise<Outcome> {
  const name = ctx.rng.name("app");
  const res = await http(ctx.target, "POST", "/api/v1/apps", {
    auth: ctx.actor.auth,
    body: { name },
  });
  const args = { name };
  if (res.status === 201) {
    const host = `${name}-${ctx.actor.username}.${ctx.target.domain}`;
    const app: RegisteredApp = { owner: ctx.actor.username, app: name, host };
    state.apps.push(app);
    ctx.world.recordApp(app);
    return { ok: true, status: 201, args };
  }
  // 409 (name reuse) is a legitimate response, not a failure.
  return statusOutcome(res, args);
}

async function pushCommit(
  ctx: PersonaContext,
  state: AppState,
): Promise<Outcome> {
  const app = ctx.rng.pick(state.apps);
  // A per-push sentinel: unique, owner-tagged, and committed as a file so the
  // tenant-isolation checker can later grep every OTHER tenant's repo/data for
  // it and assert absence.
  const sentinel = `canary-${ctx.actor.username}-${ctx.rng.token(12)}`;
  const r = await pushBranch(
    ctx,
    app.owner,
    app.app,
    "main",
    `sim: ${sentinel}`,
    async (dir) => {
      await writeFile(join(dir, `CANARY-${sentinel}.txt`), `${sentinel}\n`);
    },
  );
  const args = { app: app.app, sentinel };
  if (r.code !== 0)
    return { ok: false, args, detail: `git ${r.step}: ${r.stderr.trim()}` };
  ctx.world.recordCanary(app.owner, app.app, sentinel);
  return { ok: true, args };
}

async function hitApp(ctx: PersonaContext, state: AppState): Promise<Outcome> {
  const app = ctx.rng.pick(state.apps);
  const res = await http(ctx.target, "GET", appUrl(ctx.target, app.host), {
    accept: "application/json",
  });
  const args: Record<string, unknown> = { host: app.host };
  // 502 = building / not yet routed — expected and transient, never a failure.
  if (res.status === 200) {
    const body = (await res.json().catch(() => null)) as {
      visits?: number;
    } | null;
    if (body?.visits !== undefined) args["visits"] = body.visits;
  }
  return { ok: true, status: res.status, args };
}

// ── builder: ship apps and keep them warm ────────────────────────────────

export const builder = definePersona<AppState>(
  "builder",
  () => ({ apps: [] }),
  [
    {
      name: "createApp",
      // Bootstrap one app, then create sparingly — a builder mostly iterates.
      weight: (s) => (s.apps.length === 0 ? 8 : 1),
      run: createApp,
    },
    {
      name: "pushCommit",
      weight: (s) => (s.apps.length > 0 ? 4 : 0),
      run: pushCommit,
    },
    {
      name: "hitApp",
      weight: (s) => (s.apps.length > 0 ? 5 : 0),
      run: hitApp,
    },
  ],
);

// ── churner: create and abandon, fast ────────────────────────────────────
// The M1 API exposes no delete, so "churn" is a high create/abandon rate that
// stresses name allocation, template copies, gitops commits, and reconcile
// pressure — plus deliberate 409 collisions on reused names.

interface ChurnState {
  repoNames: string[];
  appNames: string[];
}

export const churner = definePersona<ChurnState>(
  "churner",
  () => ({ repoNames: [], appNames: [] }),
  [
    {
      name: "createRepo",
      weight: () => 4,
      run: async (ctx, state) => {
        const name = ctx.rng.name("repo");
        const res = await http(ctx.target, "POST", "/api/v1/repos", {
          auth: ctx.actor.auth,
          body: { name },
        });
        if (res.status === 201) state.repoNames.push(name);
        return statusOutcome(res, { name });
      },
    },
    {
      name: "createApp",
      weight: () => 3,
      run: async (ctx, state) => {
        const name = ctx.rng.name("app");
        const res = await http(ctx.target, "POST", "/api/v1/apps", {
          auth: ctx.actor.auth,
          body: { name },
        });
        if (res.status === 201) {
          state.appNames.push(name);
          ctx.world.recordApp({
            owner: ctx.actor.username,
            app: name,
            host: `${name}-${ctx.actor.username}.${ctx.target.domain}`,
          });
        }
        return statusOutcome(res, { name });
      },
    },
    {
      name: "collide",
      // Re-POST a name we already created — must come back 409, not 500.
      weight: (s) => (s.repoNames.length > 0 ? 2 : 0),
      run: async (ctx, state) => {
        const name = ctx.rng.pick(state.repoNames);
        const res = await http(ctx.target, "POST", "/api/v1/repos", {
          auth: ctx.actor.auth,
          body: { name },
        });
        return statusOutcome(res, { name, expect: 409 });
      },
    },
  ],
);

// ── forker: open PRs → get previews → merge/close ─────────────────────────

interface ForkState {
  apps: RegisteredApp[];
  prs: { repo: string; number: number; branch: string; state: string }[];
}

export const forker = definePersona<ForkState>(
  "forker",
  () => ({ apps: [], prs: [] }),
  [
    {
      name: "createApp",
      weight: (s) => (s.apps.length === 0 ? 8 : 1),
      // ForkState is structurally an AppState (has `apps`).
      run: (ctx, state) => createApp(ctx, state),
    },
    {
      name: "openPr",
      weight: (s) => (s.apps.length > 0 ? 5 : 0),
      run: async (ctx, state) => {
        const app = ctx.rng.pick(state.apps);
        const branch = `feat-${ctx.rng.token(6)}`;
        const sentinel = `pr-canary-${ctx.actor.username}-${ctx.rng.token(8)}`;
        const pushed = await pushBranch(
          ctx,
          app.owner,
          app.app,
          branch,
          `sim: ${sentinel}`,
          async (dir) => {
            await writeFile(join(dir, `PR-${sentinel}.txt`), `${sentinel}\n`);
          },
        );
        if (pushed.code !== 0)
          return {
            ok: false,
            args: { app: app.app, branch },
            detail: `git ${pushed.step}: ${pushed.stderr.trim()}`,
          };
        const res = await http(
          ctx.target,
          "POST",
          `/api/v1/repos/${app.owner}/${app.app}/pulls`,
          {
            auth: ctx.actor.auth,
            body: { title: `sim PR ${branch}`, head: branch, base: "main" },
          },
        );
        const args = { app: app.app, branch };
        if (res.status === 201) {
          const pr = (await res.json()) as { number: number };
          state.prs.push({
            repo: app.app,
            number: pr.number,
            branch,
            state: "open",
          });
          return { ok: true, status: 201, args };
        }
        return statusOutcome(res, args);
      },
    },
    {
      name: "hitPreview",
      weight: (s) => (s.prs.some((p) => p.state === "open") ? 4 : 0),
      run: async (ctx, state) => {
        const open = state.prs.filter((p) => p.state === "open");
        const pr = ctx.rng.pick(open);
        const app = state.apps.find((a) => a.app === pr.repo)!;
        const host = `pr-${pr.number}-${app.app}-${app.owner}.${ctx.target.domain}`;
        const res = await http(ctx.target, "GET", appUrl(ctx.target, host), {
          accept: "application/json",
        });
        // 502 while the preview builds is expected.
        return {
          ok: true,
          status: res.status,
          args: { host, pr: pr.number },
        };
      },
    },
    {
      name: "resolvePr",
      weight: (s) => (s.prs.some((p) => p.state === "open") ? 2 : 0),
      run: async (ctx, state) => {
        const open = state.prs.filter((p) => p.state === "open");
        const pr = ctx.rng.pick(open);
        const action = ctx.rng.bool(0.6) ? "merge" : "close";
        const res = await http(
          ctx.target,
          "POST",
          `/api/v1/repos/${ctx.actor.username}/${pr.repo}/pulls/${pr.number}/${action}`,
          { auth: ctx.actor.auth },
        );
        if (okStatus(res.status))
          pr.state = action === "merge" ? "merged" : "closed";
        return statusOutcome(res, { pr: pr.number, action });
      },
    },
  ],
);

// ── noisy-neighbor: hot concurrent request loops on shared ingress ────────

export const noisyNeighbor = definePersona<Record<string, never>>(
  "noisy-neighbor",
  () => ({}),
  [
    {
      name: "burst",
      weight: () => 1,
      run: async (ctx) => {
        // Saturate ingress: a burst of concurrent GETs against whatever public
        // apps exist (all apps are public-read), else the platform's healthz.
        const apps = ctx.world.apps();
        const n = ctx.rng.between(6, 24);
        const targets = Array.from({ length: n }, () =>
          apps.length > 0
            ? appUrl(ctx.target, ctx.rng.pick(apps).host)
            : `${ctx.target.api}/healthz`,
        );
        const results = await Promise.allSettled(
          targets.map((u) =>
            http(ctx.target, "GET", u, { accept: "application/json" }),
          ),
        );
        const got = results.filter((r) => r.status === "fulfilled").length;
        const server5xx = results.filter(
          (r) => r.status === "fulfilled" && r.value.status >= 500,
        ).length;
        // Only a hard 500 (not a 502 "still building") counts against us.
        const bad = results.filter(
          (r) => r.status === "fulfilled" && r.value.status === 500,
        ).length;
        const out: Outcome = {
          ok: bad === 0,
          args: { fired: n, completed: got, s5xx: server5xx },
        };
        if (bad > 0) out.detail = `${bad} responses were 500`;
        return out;
      },
    },
  ],
);

// ── attacker: tenant A's PAT against tenant B — expect denial ─────────────
// Probes only the WRITE/mutation and admin surface: in M1 repos and apps are
// public-READ by design, so a 200 on a read is NOT a breach. Every probe here
// SHOULD be denied (403/404). A 2xx on any of them is a real cross-tenant
// isolation breach and is flagged ok:false + breach:true with the seed.

interface Probe {
  name: string;
  /** Runs the denied action; returns the HTTP status and human args. */
  run: (
    ctx: PersonaContext,
    victim: { app?: RegisteredApp; actor?: Actor },
  ) => Promise<{
    status: number;
    args: Record<string, unknown>;
    body?: string;
  }>;
  /** Whether this probe needs a foreign app / foreign actor available. */
  needs: "app" | "actor" | "none";
}

const PROBES: Probe[] = [
  {
    name: "pushToForeignRepo",
    needs: "app",
    run: async (ctx, v) => {
      // Push to B's repo with A's PAT — smart-HTTP receive-pack must 403.
      const app = v.app!;
      const r = await pushBranch(
        ctx,
        app.owner,
        app.app,
        "main",
        "sim: attacker push",
        async (dir) => {
          await writeFile(join(dir, "PWNED.txt"), "attacker was here\n");
        },
      );
      // git surfaces the HTTP status in stderr; treat push-success as 200.
      const denied =
        r.step !== "push" ||
        r.code !== 0 ||
        /403|denied|forbidden|not permitted|unauthor/i.test(r.stderr);
      return {
        status: denied ? 403 : 200,
        args: { repo: `${app.owner}/${app.app}`, step: r.step },
        ...(denied ? {} : { body: "push accepted" }),
      };
    },
  },
  {
    name: "snapshotForeignApp",
    needs: "app",
    run: async (ctx, v) => {
      const app = v.app!;
      const res = await http(
        ctx.target,
        "POST",
        `/api/v1/apps/${app.owner}/${app.app}/snapshots`,
        { auth: ctx.actor.auth },
      );
      return {
        status: res.status,
        args: { app: `${app.owner}/${app.app}` },
        body: await res.text(),
      };
    },
  },
  {
    name: "openPrOnForeignRepo",
    needs: "app",
    run: async (ctx, v) => {
      const app = v.app!;
      const res = await http(
        ctx.target,
        "POST",
        `/api/v1/repos/${app.owner}/${app.app}/pulls`,
        {
          auth: ctx.actor.auth,
          body: { title: "sim intrusion", head: "main", base: "main" },
        },
      );
      return {
        status: res.status,
        args: { repo: `${app.owner}/${app.app}` },
        body: await res.text(),
      };
    },
  },
  {
    name: "labelForeignIssue",
    needs: "app",
    run: async (ctx, v) => {
      // File an issue on B's repo (open by design) then try to LABEL it — a
      // write intent that must be denied even on an issue we authored.
      const app = v.app!;
      const mk = await http(
        ctx.target,
        "POST",
        `/api/v1/repos/${app.owner}/${app.app}/issues`,
        { auth: ctx.actor.auth, body: { title: "sim probe" } },
      );
      if (mk.status !== 201)
        return {
          status: mk.status,
          args: { repo: `${app.owner}/${app.app}`, at: "create-issue" },
          body: await mk.text(),
        };
      const issue = (await mk.json()) as { number: number };
      const res = await http(
        ctx.target,
        "POST",
        `/api/v1/repos/${app.owner}/${app.app}/issues/${issue.number}/labels`,
        { auth: ctx.actor.auth, body: { labels: ["agent-work"] } },
      );
      return {
        status: res.status,
        args: { repo: `${app.owner}/${app.app}`, issue: issue.number },
        body: await res.text(),
      };
    },
  },
  {
    name: "mintTokenForForeignUser",
    needs: "actor",
    run: async (ctx, v) => {
      const victim = v.actor!;
      const res = await http(
        ctx.target,
        "POST",
        `/api/v1/users/${victim.username}/tokens`,
        { auth: ctx.actor.auth, body: { name: "stolen" } },
      );
      return {
        status: res.status,
        args: { victim: victim.username },
        body: await res.text(),
      };
    },
  },
  {
    name: "createUser",
    needs: "none",
    run: async (ctx) => {
      // Non-admin tenant trying to mint a user — must 403.
      const res = await http(ctx.target, "POST", "/api/v1/users", {
        auth: ctx.actor.auth,
        body: { username: ctx.rng.name("ghost"), password: "x-password-123" },
      });
      return { status: res.status, args: {}, body: await res.text() };
    },
  },
  {
    name: "probeForeignSubdomain",
    needs: "app",
    run: async (ctx, v) => {
      // A GET on B's app host. Apps are public in M1, so this is a control
      // probe: a response (even 200) is fine; we only record what happened.
      const app = v.app!;
      const res = await http(ctx.target, "GET", appUrl(ctx.target, app.host), {
        auth: ctx.actor.auth,
        accept: "application/json",
      });
      // Public read: never a breach. Signal that by reporting 403 (denied is
      // the breach condition; a public 200 here is expected and allowed).
      return {
        status: 403,
        args: { host: app.host, observed: res.status, public: true },
      };
    },
  },
];

export const attacker = definePersona<Record<string, never>>(
  "attacker",
  () => ({}),
  [
    {
      name: "probe",
      weight: () => 1,
      run: async (ctx) => {
        const foreignApps = ctx.world.foreignApps(ctx.actor.username);
        const foreignActors = ctx.world.foreignActors(ctx.actor.username);
        const eligible = PROBES.filter(
          (p) =>
            p.needs === "none" ||
            (p.needs === "app" && foreignApps.length > 0) ||
            (p.needs === "actor" && foreignActors.length > 0),
        );
        if (eligible.length === 0)
          return { ok: true, detail: "no foreign target yet" };
        const probe = ctx.rng.pick(eligible);
        const victim = {
          ...(foreignApps.length > 0 ? { app: ctx.rng.pick(foreignApps) } : {}),
          ...(foreignActors.length > 0
            ? { actor: ctx.rng.pick(foreignActors) }
            : {}),
        };
        const out = await probe.run(ctx, victim);
        const breach = out.status < 400; // a 2xx/3xx on a denied action
        const args: Record<string, unknown> = {
          probe: probe.name,
          ...out.args,
        };
        if (breach)
          return {
            ok: false,
            breach: true,
            status: out.status,
            args,
            detail: `ISOLATION BREACH: ${ctx.actor.username} performed ${probe.name} (status ${out.status})${
              out.body ? ` — ${out.body.slice(0, 120)}` : ""
            }`,
          };
        return { ok: true, status: out.status, args };
      },
    },
  ],
);

// ── registry + actor provisioning ────────────────────────────────────────

export const PERSONAS = {
  builder,
  churner,
  forker,
  "noisy-neighbor": noisyNeighbor,
  attacker,
} as const;

export type PersonaName = keyof typeof PERSONAS;

export function makePersona(name: PersonaName): Persona {
  return PERSONAS[name]();
}

/**
 * Provision a real tenant: create the user (admin-gated) and a PAT, returning
 * an Actor. Mirrors the m1 e2e flow so a runner needs nothing else. Registers
 * the actor in the world for cross-tenant personas.
 */
export async function provisionActor(
  target: PlatformTarget,
  adminAuth: string,
  username: string,
  world?: World,
): Promise<Actor> {
  const mk = await http(target, "POST", "/api/v1/users", {
    auth: adminAuth,
    body: { username, password: `sim-${username}-password-123` },
  });
  if (mk.status !== 201)
    throw new Error(
      `provisionActor(${username}): user create -> ${mk.status} ${await mk.text()}`,
    );
  const tok = await http(target, "POST", `/api/v1/users/${username}/tokens`, {
    auth: adminAuth,
    body: { name: "sim" },
  });
  if (tok.status !== 201)
    throw new Error(
      `provisionActor(${username}): token -> ${tok.status} ${await tok.text()}`,
    );
  const { token } = (await tok.json()) as { token: string };
  const actor: Actor = { username, auth: `${username}:${token}` };
  world?.recordActor(actor);
  return actor;
}
