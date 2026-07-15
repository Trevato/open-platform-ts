import { Database } from "bun:sqlite";
import { newId } from "@op/core";
import { MIGRATIONS } from "./schema.ts";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number;
  created_at: number;
}

export interface RepoRow {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  is_template: number;
  created_at: number;
}

export interface OrgRow {
  name: string;
  display_name: string;
  created_by: string;
  created_at: number;
}

export interface OrgMemberRow {
  org: string;
  user_id: string;
  role: string;
  created_at: number;
}

export interface HostRow {
  host: string;
  owner: string;
  app: string;
  container_id: string | null;
  container_port: number | null;
  updated_at: number;
}

export interface AppPortRow {
  public_port: number;
  owner: string;
  app: string;
  container_port: number;
  host_port: number | null;
  updated_at: number;
}

export interface AppStatusRow {
  owner: string;
  app: string;
  state: string;
  image_digest: string | null;
  container_id: string | null;
  message: string | null;
  updated_at: number;
}

export interface DeployEventRow {
  id: number;
  owner: string;
  app: string;
  ts: number;
  phase: string;
  message: string | null;
  sha: string | null;
}

export interface OauthClientRow {
  client_id: string;
  secret_hash: string;
  owner: string;
  app: string;
  redirect_uris: string; // JSON array
  created_at: number;
}

export interface OauthCodeRow {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  nonce: string | null;
  expires_at: number;
}

export interface PullRequestRow {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  head_ref: string;
  base_ref: string;
  state: string;
  author: string;
  created_at: number;
}

export interface IssueRow {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string; // comma-separated (taxonomy only; phase is process truth)
  author: string;
  created_at: number;
  /** Work-item lifecycle. state is derived: closed ⇔ phase ∈ {shipped, closed}. */
  phase: WorkPhase;
  head_ref: string | null;
  base_ref: string | null;
  change_state: string | null; // 'open' | 'merged' | 'closed' | null
  parked_reason: string | null;
}

export type WorkPhase =
  | "intent"
  | "queued"
  | "building"
  | "reviewing"
  | "reworking"
  | "shipped"
  | "parked"
  | "closed";

// The legal-edge table — the single enforcement point for process state,
// mirroring admitSpec's role: an illegal transition throws and the mutation
// never happened. Keys are targets; values are the phases allowed to move there.
const WORK_EDGES: Record<WorkPhase, WorkPhase[]> = {
  intent: [],
  queued: ["intent", "parked"],
  building: ["queued"],
  reviewing: ["building", "reworking"],
  reworking: ["reviewing"],
  shipped: ["reviewing", "reworking", "parked"],
  parked: ["building", "reviewing", "reworking"],
  closed: ["intent", "queued", "building", "reviewing", "reworking", "parked"],
};

export interface WorkAttemptRow {
  id: number;
  owner: string;
  repo: string;
  number: number;
  attempt: number;
  head_sha: string | null;
  builder_cost_usd: number | null;
  verdict: string | null;
  verdict_line: string | null;
  reviewer_cost_usd: number | null;
  created_at: number;
}

export interface WorkDepRow {
  owner: string;
  repo: string;
  number: number;
  on_owner: string;
  on_repo: string;
  on_number: number;
  created_at: number;
}

export interface IssueCommentRow {
  id: string;
  owner: string;
  repo: string;
  number: number;
  author: string;
  body: string;
  created_at: number;
}

export class Store {
  readonly db: Database;

  constructor(file: string) {
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode = WAL;" +
        "PRAGMA foreign_keys = ON;" +
        "PRAGMA busy_timeout = 5000;" +
        "PRAGMA synchronous = NORMAL;",
    );
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    const row = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _migrations")
      .get();
    const applied = row?.n ?? 0;
    for (let i = applied; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.run("INSERT INTO _migrations (idx, applied_at) VALUES (?, ?)", [
          i,
          Date.now(),
        ]);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // ── users ──────────────────────────────────────────────────────────────
  createUser(username: string, passwordHash: string, isAdmin = false): UserRow {
    const row: UserRow = {
      id: newId("usr"),
      username,
      password_hash: passwordHash,
      is_admin: isAdmin ? 1 : 0,
      created_at: Date.now(),
    };
    this.db.run(
      "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
      [row.id, row.username, row.password_hash, row.is_admin, row.created_at],
    );
    return row;
  }

  getUser(username: string): UserRow | null {
    return (
      this.db
        .query<UserRow, [string]>("SELECT * FROM users WHERE username = ?")
        .get(username) ?? null
    );
  }

  getUserById(id: string): UserRow | null {
    return (
      this.db
        .query<UserRow, [string]>("SELECT * FROM users WHERE id = ?")
        .get(id) ?? null
    );
  }

  // ── PATs (hash stored; plaintext never persisted) ─────────────────────
  createToken(userId: string, name: string, tokenHash: string): string {
    const id = newId("tok");
    this.db.run(
      "INSERT INTO tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, userId, name, tokenHash, Date.now()],
    );
    return id;
  }

  userByTokenHash(tokenHash: string): UserRow | null {
    return (
      this.db
        .query<
          UserRow,
          [string]
        >("SELECT u.* FROM users u JOIN tokens t ON t.user_id = u.id WHERE t.token_hash = ?")
        .get(tokenHash) ?? null
    );
  }

  // ── sessions ───────────────────────────────────────────────────────────
  createSession(
    userId: string,
    ttlMs: number,
  ): { id: string; expiresAt: number } {
    const id = newId("ses");
    const expiresAt = Date.now() + ttlMs;
    this.db.run(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      [id, userId, expiresAt, Date.now()],
    );
    return { id, expiresAt };
  }

  userBySession(sessionId: string): UserRow | null {
    return (
      this.db
        .query<
          UserRow,
          [string, number]
        >("SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.id = ? AND s.expires_at > ?")
        .get(sessionId, Date.now()) ?? null
    );
  }

  // ── repos ──────────────────────────────────────────────────────────────
  createRepo(
    owner: string,
    name: string,
    opts?: { isTemplate?: boolean },
  ): RepoRow {
    const row: RepoRow = {
      id: newId("repo"),
      owner,
      name,
      default_branch: "main",
      is_template: opts?.isTemplate ? 1 : 0,
      created_at: Date.now(),
    };
    this.db.run(
      "INSERT INTO repos (id, owner, name, default_branch, is_template, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        row.id,
        row.owner,
        row.name,
        row.default_branch,
        row.is_template,
        row.created_at,
      ],
    );
    return row;
  }

  getRepo(owner: string, name: string): RepoRow | null {
    return (
      this.db
        .query<
          RepoRow,
          [string, string]
        >("SELECT * FROM repos WHERE owner = ? AND name = ?")
        .get(owner, name) ?? null
    );
  }

  listRepos(): RepoRow[] {
    return this.db
      .query<RepoRow, []>("SELECT * FROM repos ORDER BY owner, name")
      .all();
  }

  listReposByOwner(owner: string): RepoRow[] {
    return this.db
      .query<
        RepoRow,
        [string]
      >("SELECT * FROM repos WHERE owner = ? ORDER BY name")
      .all(owner);
  }

  deleteRepo(owner: string, name: string): void {
    this.db.run("DELETE FROM repos WHERE owner = ? AND name = ?", [
      owner,
      name,
    ]);
  }

  // ── orgs ───────────────────────────────────────────────────────────────
  createOrg(name: string, createdBy: string, displayName = ""): OrgRow {
    const row: OrgRow = {
      name,
      display_name: displayName,
      created_by: createdBy,
      created_at: Date.now(),
    };
    // Create the org and enroll the creator as an owner-member atomically, so
    // an org can never exist with nobody able to write to it.
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO orgs (name, display_name, created_by, created_at) VALUES (?, ?, ?, ?)",
        [row.name, row.display_name, row.created_by, row.created_at],
      );
      this.db.run(
        "INSERT INTO org_members (org, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        [name, createdBy, row.created_at],
      );
    })();
    return row;
  }

  getOrg(name: string): OrgRow | null {
    return (
      this.db
        .query<OrgRow, [string]>("SELECT * FROM orgs WHERE name = ?")
        .get(name) ?? null
    );
  }

  listOrgs(): OrgRow[] {
    return this.db.query<OrgRow, []>("SELECT * FROM orgs ORDER BY name").all();
  }

  addOrgMember(org: string, userId: string, role = "member"): void {
    // Re-adding an existing member may promote (member → owner) but never
    // demote: a roleless re-invite must not strip the creator's ownership.
    this.db.run(
      `INSERT INTO org_members (org, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(org, user_id) DO UPDATE SET
         role = CASE WHEN org_members.role = 'owner' THEN 'owner' ELSE excluded.role END`,
      [org, userId, role, Date.now()],
    );
  }

  removeOrgMember(org: string, userId: string): void {
    this.db.run("DELETE FROM org_members WHERE org = ? AND user_id = ?", [
      org,
      userId,
    ]);
  }

  isOrgMember(org: string, userId: string): boolean {
    return (
      this.db
        .query<
          { n: number },
          [string, string]
        >("SELECT COUNT(*) AS n FROM org_members WHERE org = ? AND user_id = ?")
        .get(org, userId)?.n === 1
    );
  }

  listOrgMembers(org: string): Array<OrgMemberRow & { username: string }> {
    return this.db
      .query<OrgMemberRow & { username: string }, [string]>(
        `SELECT m.*, u.username FROM org_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.org = ? ORDER BY m.role DESC, u.username`,
      )
      .all(org);
  }

  listOrgsForUser(userId: string): OrgRow[] {
    return this.db
      .query<OrgRow, [string]>(
        `SELECT o.* FROM orgs o
         JOIN org_members m ON m.org = o.name
         WHERE m.user_id = ? ORDER BY o.name`,
      )
      .all(userId);
  }

  // ── gate host table ────────────────────────────────────────────────────
  setHost(
    host: string,
    owner: string,
    app: string,
    containerId: string,
    containerPort: number,
  ): void {
    this.db.run(
      `INSERT INTO hosts (host, owner, app, container_id, container_port, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET
         owner = excluded.owner, app = excluded.app,
         container_id = excluded.container_id, container_port = excluded.container_port,
         updated_at = excluded.updated_at`,
      [host, owner, app, containerId, containerPort, Date.now()],
    );
  }

  resolveHost(host: string): HostRow | null {
    return (
      this.db
        .query<HostRow, [string]>("SELECT * FROM hosts WHERE host = ?")
        .get(host) ?? null
    );
  }

  deleteHostsFor(owner: string, app: string): void {
    this.db.run("DELETE FROM hosts WHERE owner = ? AND app = ?", [owner, app]);
  }

  deleteHost(host: string): void {
    this.db.run("DELETE FROM hosts WHERE host = ?", [host]);
  }

  // ── public TCP ports (the hosts analog for L4, relayed by the TCP gate) ──
  /** Stable public port for (owner, app, containerPort): reuse the existing
   *  allocation, else claim the lowest free port in the platform range.
   *  Returns null when the range is exhausted. */
  allocateAppPort(
    owner: string,
    app: string,
    containerPort: number,
    range: [number, number],
  ): number | null {
    const existing = this.db
      .query<
        AppPortRow,
        [string, string, number]
      >("SELECT * FROM app_ports WHERE owner = ? AND app = ? AND container_port = ?")
      .get(owner, app, containerPort);
    if (existing) return existing.public_port;
    const taken = new Set(
      this.db
        .query<{ public_port: number }, []>("SELECT public_port FROM app_ports")
        .all()
        .map((r) => r.public_port),
    );
    for (let p = range[0]; p <= range[1]; p++) {
      if (taken.has(p)) continue;
      this.db.run(
        `INSERT INTO app_ports (public_port, owner, app, container_port, host_port, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
        [p, owner, app, containerPort, Date.now()],
      );
      return p;
    }
    return null;
  }

  /** Point a public port at the container's loopback binding (null = stopped). */
  setAppPortBinding(
    owner: string,
    app: string,
    containerPort: number,
    hostPort: number | null,
  ): void {
    this.db.run(
      `UPDATE app_ports SET host_port = ?, updated_at = ?
       WHERE owner = ? AND app = ? AND container_port = ?`,
      [hostPort, Date.now(), owner, app, containerPort],
    );
  }

  listAppPorts(): AppPortRow[] {
    return this.db
      .query<AppPortRow, []>("SELECT * FROM app_ports ORDER BY public_port")
      .all();
  }

  listAppPortsFor(owner: string, app: string): AppPortRow[] {
    return this.db
      .query<
        AppPortRow,
        [string, string]
      >("SELECT * FROM app_ports WHERE owner = ? AND app = ? ORDER BY container_port")
      .all(owner, app);
  }

  /** Release an app's public ports — only on app removal, never on redeploy,
   *  so the public address players saved stays stable across restarts. */
  deleteAppPortsFor(owner: string, app: string): void {
    this.db.run("DELETE FROM app_ports WHERE owner = ? AND app = ?", [
      owner,
      app,
    ]);
  }

  // ── app status (runtime observation, written by the reconciler) ───────
  upsertAppStatus(s: Omit<AppStatusRow, "updated_at">): void {
    this.db.run(
      `INSERT INTO app_status (owner, app, state, image_digest, container_id, message, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner, app) DO UPDATE SET
         state = excluded.state, image_digest = excluded.image_digest,
         container_id = excluded.container_id, message = excluded.message,
         updated_at = excluded.updated_at`,
      [
        s.owner,
        s.app,
        s.state,
        s.image_digest,
        s.container_id,
        s.message,
        Date.now(),
      ],
    );
  }

  getAppStatus(owner: string, app: string): AppStatusRow | null {
    return (
      this.db
        .query<
          AppStatusRow,
          [string, string]
        >("SELECT * FROM app_status WHERE owner = ? AND app = ?")
        .get(owner, app) ?? null
    );
  }

  // ── deploy events (the ship timeline) ─────────────────────────────────
  appendEvent(
    owner: string,
    app: string,
    phase: string,
    message: string | null,
    sha: string | null,
  ): void {
    this.db.run(
      "INSERT INTO deploy_events (owner, app, ts, phase, message, sha) VALUES (?, ?, ?, ?, ?, ?)",
      [owner, app, Date.now(), phase, message, sha],
    );
    // Bounded history: keep the most recent 60 events per app.
    this.db.run(
      `DELETE FROM deploy_events WHERE owner = ? AND app = ? AND id NOT IN (
         SELECT id FROM deploy_events WHERE owner = ? AND app = ? ORDER BY id DESC LIMIT 60)`,
      [owner, app, owner, app],
    );
  }

  listEvents(owner: string, app: string, limit = 40): DeployEventRow[] {
    return this.db
      .query<
        DeployEventRow,
        [string, string, number]
      >("SELECT * FROM deploy_events WHERE owner = ? AND app = ? ORDER BY id DESC LIMIT ?")
      .all(owner, app, limit);
  }

  // ── OAuth clients (one per app; upserted at deploy) ───────────────────
  upsertClient(c: Omit<OauthClientRow, "created_at">): void {
    this.db.run(
      `INSERT INTO oauth_clients (client_id, secret_hash, owner, app, redirect_uris, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         secret_hash = excluded.secret_hash, redirect_uris = excluded.redirect_uris`,
      [c.client_id, c.secret_hash, c.owner, c.app, c.redirect_uris, Date.now()],
    );
  }

  getClient(clientId: string): OauthClientRow | null {
    return (
      this.db
        .query<
          OauthClientRow,
          [string]
        >("SELECT * FROM oauth_clients WHERE client_id = ?")
        .get(clientId) ?? null
    );
  }

  // ── OAuth authorization codes (short-lived, single-use) ───────────────
  createCode(c: OauthCodeRow): void {
    this.db.run(
      `INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, scope, nonce, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.code,
        c.client_id,
        c.user_id,
        c.redirect_uri,
        c.code_challenge,
        c.scope,
        c.nonce,
        c.expires_at,
      ],
    );
  }

  /** Atomically fetch-and-delete: a code can be redeemed at most once. */
  consumeCode(code: string): OauthCodeRow | null {
    return this.db.transaction(() => {
      const row =
        this.db
          .query<
            OauthCodeRow,
            [string]
          >("SELECT * FROM oauth_codes WHERE code = ?")
          .get(code) ?? null;
      if (row) this.db.run("DELETE FROM oauth_codes WHERE code = ?", [code]);
      return row;
    })();
  }

  // ── pull requests ─────────────────────────────────────────────────────
  createPr(
    owner: string,
    repo: string,
    fields: { title: string; headRef: string; baseRef: string; author: string },
  ): PullRequestRow {
    return this.db.transaction(() => {
      const max =
        this.db
          .query<
            { n: number | null },
            [string, string]
          >("SELECT MAX(number) AS n FROM pull_requests WHERE owner = ? AND repo = ?")
          .get(owner, repo)?.n ?? 0;
      const row: PullRequestRow = {
        id: newId("pr"),
        owner,
        repo,
        number: max + 1,
        title: fields.title,
        head_ref: fields.headRef,
        base_ref: fields.baseRef,
        state: "open",
        author: fields.author,
        created_at: Date.now(),
      };
      this.db.run(
        `INSERT INTO pull_requests (id, owner, repo, number, title, head_ref, base_ref, state, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          owner,
          repo,
          row.number,
          row.title,
          row.head_ref,
          row.base_ref,
          row.state,
          row.author,
          row.created_at,
        ],
      );
      return row;
    })();
  }

  getPr(owner: string, repo: string, number: number): PullRequestRow | null {
    return (
      this.db
        .query<
          PullRequestRow,
          [string, string, number]
        >("SELECT * FROM pull_requests WHERE owner = ? AND repo = ? AND number = ?")
        .get(owner, repo, number) ?? null
    );
  }

  listPrs(owner: string, repo: string, state?: string): PullRequestRow[] {
    if (state) {
      return this.db
        .query<
          PullRequestRow,
          [string, string, string]
        >("SELECT * FROM pull_requests WHERE owner = ? AND repo = ? AND state = ? ORDER BY number DESC")
        .all(owner, repo, state);
    }
    return this.db
      .query<
        PullRequestRow,
        [string, string]
      >("SELECT * FROM pull_requests WHERE owner = ? AND repo = ? ORDER BY number DESC")
      .all(owner, repo);
  }

  /** Open PRs across all repos — the reconciler's preview work-list. */
  listOpenPrs(): PullRequestRow[] {
    return this.db
      .query<
        PullRequestRow,
        []
      >("SELECT * FROM pull_requests WHERE state = 'open'")
      .all();
  }

  setPrState(owner: string, repo: string, number: number, state: string): void {
    this.db.run(
      "UPDATE pull_requests SET state = ? WHERE owner = ? AND repo = ? AND number = ?",
      [state, owner, repo, number],
    );
  }

  // ── issues (work items) ─────────────────────────────────────────────────
  /** Create a work item. Birth phase is a creation fact, not a transition:
   *  plain intent by default, `queued` when filed with the agent-work verb,
   *  or `reviewing` with a pre-attached change (the human-pushed-branch path). */
  createIssue(
    owner: string,
    repo: string,
    fields: {
      title: string;
      body: string;
      author: string;
      labels: string[];
      phase?: Extract<WorkPhase, "intent" | "queued" | "reviewing">;
      change?: { head: string; base: string };
    },
  ): IssueRow {
    return this.db.transaction(() => {
      const max =
        this.db
          .query<
            { n: number | null },
            [string, string]
          >("SELECT MAX(number) AS n FROM issues WHERE owner = ? AND repo = ?")
          .get(owner, repo)?.n ?? 0;
      const row: IssueRow = {
        id: newId("iss"),
        owner,
        repo,
        number: max + 1,
        title: fields.title,
        body: fields.body,
        state: "open",
        labels: fields.labels.join(","),
        author: fields.author,
        created_at: Date.now(),
        phase: fields.phase ?? "intent",
        head_ref: fields.change?.head ?? null,
        base_ref: fields.change?.base ?? null,
        change_state: fields.change ? "open" : null,
        parked_reason: null,
      };
      this.db.run(
        `INSERT INTO issues (id, owner, repo, number, title, body, state, labels, author, created_at,
                             phase, head_ref, base_ref, change_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          owner,
          repo,
          row.number,
          row.title,
          row.body,
          row.state,
          row.labels,
          row.author,
          row.created_at,
          row.phase,
          row.head_ref,
          row.base_ref,
          row.change_state,
        ],
      );
      return row;
    })();
  }

  getIssue(owner: string, repo: string, number: number): IssueRow | null {
    return (
      this.db
        .query<
          IssueRow,
          [string, string, number]
        >("SELECT * FROM issues WHERE owner = ? AND repo = ? AND number = ?")
        .get(owner, repo, number) ?? null
    );
  }

  listIssues(owner: string, repo: string, state?: string): IssueRow[] {
    if (state) {
      return this.db
        .query<
          IssueRow,
          [string, string, string]
        >("SELECT * FROM issues WHERE owner = ? AND repo = ? AND state = ? ORDER BY number DESC")
        .all(owner, repo, state);
    }
    return this.db
      .query<
        IssueRow,
        [string, string]
      >("SELECT * FROM issues WHERE owner = ? AND repo = ? ORDER BY number DESC")
      .all(owner, repo);
  }

  /** All open issues carrying a given label — the crew dispatcher's work-list. */
  listIssuesByLabel(label: string): IssueRow[] {
    return this.db
      .query<IssueRow, []>("SELECT * FROM issues WHERE state = 'open'")
      .all()
      .filter((i) => i.labels.split(",").includes(label));
  }

  // ── issue dependencies ────────────────────────────────────────────────
  addIssueDep(
    owner: string,
    repo: string,
    number: number,
    blockedBy: number,
  ): void {
    this.db.run(
      `INSERT INTO issue_deps (owner, repo, number, blocked_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner, repo, number, blocked_by) DO NOTHING`,
      [owner, repo, number, blockedBy, Date.now()],
    );
  }

  removeIssueDep(
    owner: string,
    repo: string,
    number: number,
    blockedBy: number,
  ): void {
    this.db.run(
      "DELETE FROM issue_deps WHERE owner = ? AND repo = ? AND number = ? AND blocked_by = ?",
      [owner, repo, number, blockedBy],
    );
  }

  /** The issue numbers this issue is blocked by (all edges, regardless of the
   *  blocker's state). */
  listIssueBlockers(owner: string, repo: string, number: number): number[] {
    return this.db
      .query<{ blocked_by: number }, [string, string, number]>(
        "SELECT blocked_by FROM issue_deps WHERE owner = ? AND repo = ? AND number = ? ORDER BY blocked_by",
      )
      .all(owner, repo, number)
      .map((r) => r.blocked_by);
  }

  /** Blockers that are still OPEN — the ones that actually gate crew work. */
  openBlockers(owner: string, repo: string, number: number): number[] {
    return this.db
      .query<{ blocked_by: number }, [string, string, number]>(
        `SELECT d.blocked_by FROM issue_deps d
         JOIN issues i
           ON i.owner = d.owner AND i.repo = d.repo AND i.number = d.blocked_by
         WHERE d.owner = ? AND d.repo = ? AND d.number = ? AND i.state = 'open'
         ORDER BY d.blocked_by`,
      )
      .all(owner, repo, number)
      .map((r) => r.blocked_by);
  }

  setIssueState(
    owner: string,
    repo: string,
    number: number,
    state: string,
  ): void {
    this.db.run(
      "UPDATE issues SET state = ? WHERE owner = ? AND repo = ? AND number = ?",
      [state, owner, repo, number],
    );
  }

  setIssueLabels(
    owner: string,
    repo: string,
    number: number,
    labels: string[],
  ): void {
    this.db.run(
      "UPDATE issues SET labels = ? WHERE owner = ? AND repo = ? AND number = ?",
      [labels.join(","), owner, repo, number],
    );
  }

  addComment(
    owner: string,
    repo: string,
    number: number,
    author: string,
    body: string,
  ): IssueCommentRow {
    const row: IssueCommentRow = {
      id: newId("cmt"),
      owner,
      repo,
      number,
      author,
      body,
      created_at: Date.now(),
    };
    this.db.run(
      "INSERT INTO issue_comments (id, owner, repo, number, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [row.id, owner, repo, number, author, body, row.created_at],
    );
    return row;
  }

  listComments(owner: string, repo: string, number: number): IssueCommentRow[] {
    // rowid is monotonic insertion order; the text id is random, so never sort by it.
    return this.db
      .query<
        IssueCommentRow,
        [string, string, number]
      >("SELECT * FROM issue_comments WHERE owner = ? AND repo = ? AND number = ? ORDER BY rowid ASC")
      .all(owner, repo, number);
  }

  // ── work items (phase machine + attempts ledger over issues) ────────────
  /** Transition a work item. CAS against the legal-edge table: the UPDATE
   *  only fires from a phase allowed to reach `to`, so a concurrent mover
   *  loses cleanly. Illegal/late transitions throw — the mutation never
   *  happened. The old open/closed `state` is maintained here, its one write
   *  site, so pre-work-item readers keep working. */
  setWorkPhase(
    owner: string,
    repo: string,
    number: number,
    to: WorkPhase,
    opts?: { parkedReason?: string },
  ): void {
    const from = WORK_EDGES[to];
    if (from.length === 0)
      throw new Error(`no legal transition into phase '${to}'`);
    const derived = to === "shipped" || to === "closed" ? "closed" : "open";
    const changed = this.db.run(
      `UPDATE issues SET phase = ?, state = ?, parked_reason = ?
       WHERE owner = ? AND repo = ? AND number = ?
         AND phase IN (${from.map(() => "?").join(", ")})`,
      [
        to,
        derived,
        to === "parked" ? (opts?.parkedReason ?? null) : null,
        owner,
        repo,
        number,
        ...from,
      ],
    ).changes;
    if (changed !== 1) {
      const current = this.getIssue(owner, repo, number);
      throw new Error(
        current
          ? `illegal transition ${current.phase} → ${to} for ${owner}/${repo}#${number}`
          : `no such work item: ${owner}/${repo}#${number}`,
      );
    }
  }

  /** Claim a queued item for building. The CAS makes double-claims
   *  structurally impossible; losing the race is normal, not an error. */
  claimWork(owner: string, repo: string, number: number): boolean {
    return (
      this.db.run(
        `UPDATE issues SET phase = 'building'
         WHERE owner = ? AND repo = ? AND number = ? AND phase = 'queued'`,
        [owner, repo, number],
      ).changes === 1
    );
  }

  /** Attach the (single, ever) change to a work item. Idempotent per item:
   *  rework recommits on the same branch. */
  attachChange(
    owner: string,
    repo: string,
    number: number,
    change: { head: string; base: string },
  ): void {
    this.db.run(
      `UPDATE issues SET head_ref = ?, base_ref = ?, change_state = 'open'
       WHERE owner = ? AND repo = ? AND number = ?`,
      [change.head, change.base, owner, repo, number],
    );
  }

  setChangeState(
    owner: string,
    repo: string,
    number: number,
    state: "open" | "merged" | "closed",
  ): void {
    this.db.run(
      `UPDATE issues SET change_state = ? WHERE owner = ? AND repo = ? AND number = ?`,
      [state, owner, repo, number],
    );
  }

  /** Work items with a live change — the reconciler's preview work-list. */
  listOpenChanges(): IssueRow[] {
    return this.db
      .query<IssueRow, []>("SELECT * FROM issues WHERE change_state = 'open'")
      .all();
  }

  listWorkByPhase(phase: WorkPhase): IssueRow[] {
    return this.db
      .query<
        IssueRow,
        [string]
      >("SELECT * FROM issues WHERE phase = ? ORDER BY created_at")
      .all(phase);
  }

  /** Open a new attempt row (append-only ledger). Returns the attempt number. */
  openWorkAttempt(
    owner: string,
    repo: string,
    number: number,
    fields?: { headSha?: string; builderCostUsd?: number },
  ): number {
    return this.db.transaction(() => {
      const max =
        this.db
          .query<
            { n: number | null },
            [string, string, number]
          >("SELECT MAX(attempt) AS n FROM work_attempts WHERE owner = ? AND repo = ? AND number = ?")
          .get(owner, repo, number)?.n ?? 0;
      const attempt = max + 1;
      this.db.run(
        `INSERT INTO work_attempts (owner, repo, number, attempt, head_sha, builder_cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          owner,
          repo,
          number,
          attempt,
          fields?.headSha ?? null,
          fields?.builderCostUsd ?? null,
          Date.now(),
        ],
      );
      return attempt;
    })();
  }

  /** Stamp the build half of an attempt once the builder returns. */
  setAttemptBuilder(
    owner: string,
    repo: string,
    number: number,
    attempt: number,
    fields: { builderCostUsd?: number; headSha?: string },
  ): void {
    this.db.run(
      `UPDATE work_attempts SET
         builder_cost_usd = COALESCE(?, builder_cost_usd),
         head_sha = COALESCE(?, head_sha)
       WHERE owner = ? AND repo = ? AND number = ? AND attempt = ?`,
      [
        fields.builderCostUsd ?? null,
        fields.headSha ?? null,
        owner,
        repo,
        number,
        attempt,
      ],
    );
  }

  setAttemptVerdict(
    owner: string,
    repo: string,
    number: number,
    attempt: number,
    fields: {
      verdict: string;
      verdictLine?: string;
      reviewerCostUsd?: number;
      headSha?: string;
    },
  ): void {
    this.db.run(
      `UPDATE work_attempts SET verdict = ?, verdict_line = ?,
         reviewer_cost_usd = COALESCE(?, reviewer_cost_usd),
         head_sha = COALESCE(?, head_sha)
       WHERE owner = ? AND repo = ? AND number = ? AND attempt = ?`,
      [
        fields.verdict,
        fields.verdictLine ?? null,
        fields.reviewerCostUsd ?? null,
        fields.headSha ?? null,
        owner,
        repo,
        number,
        attempt,
      ],
    );
  }

  countAttempts(owner: string, repo: string, number: number): number {
    return (
      this.db
        .query<
          { n: number },
          [string, string, number]
        >("SELECT COUNT(*) AS n FROM work_attempts WHERE owner = ? AND repo = ? AND number = ?")
        .get(owner, repo, number)?.n ?? 0
    );
  }

  listAttempts(owner: string, repo: string, number: number): WorkAttemptRow[] {
    return this.db
      .query<
        WorkAttemptRow,
        [string, string, number]
      >("SELECT * FROM work_attempts WHERE owner = ? AND repo = ? AND number = ? ORDER BY attempt")
      .all(owner, repo, number);
  }

  // ── work dependencies (cross-repo; same-owner enforced in forge) ────────
  addWorkDep(
    item: { owner: string; repo: string; number: number },
    on: { owner: string; repo: string; number: number },
  ): void {
    this.db.run(
      `INSERT INTO work_deps (owner, repo, number, on_owner, on_repo, on_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [
        item.owner,
        item.repo,
        item.number,
        on.owner,
        on.repo,
        on.number,
        Date.now(),
      ],
    );
  }

  removeWorkDep(
    item: { owner: string; repo: string; number: number },
    on: { owner: string; repo: string; number: number },
  ): void {
    this.db.run(
      `DELETE FROM work_deps WHERE owner = ? AND repo = ? AND number = ?
         AND on_owner = ? AND on_repo = ? AND on_number = ?`,
      [item.owner, item.repo, item.number, on.owner, on.repo, on.number],
    );
  }

  listWorkDeps(owner: string, repo: string, number: number): WorkDepRow[] {
    return this.db
      .query<
        WorkDepRow,
        [string, string, number]
      >("SELECT * FROM work_deps WHERE owner = ? AND repo = ? AND number = ? ORDER BY on_owner, on_repo, on_number")
      .all(owner, repo, number);
  }

  /** Blockers that still gate work: a blocker counts as open until its phase
   *  is terminal. */
  openWorkBlockers(
    owner: string,
    repo: string,
    number: number,
  ): Array<WorkDepRow & { phase: WorkPhase }> {
    return this.db
      .query<WorkDepRow & { phase: WorkPhase }, [string, string, number]>(
        `SELECT d.*, i.phase FROM work_deps d
         JOIN issues i
           ON i.owner = d.on_owner AND i.repo = d.on_repo AND i.number = d.on_number
         WHERE d.owner = ? AND d.repo = ? AND d.number = ?
           AND i.phase NOT IN ('shipped', 'closed')
         ORDER BY d.on_owner, d.on_repo, d.on_number`,
      )
      .all(owner, repo, number);
  }
}
