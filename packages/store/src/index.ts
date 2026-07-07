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

export interface HostRow {
  host: string;
  owner: string;
  app: string;
  container_id: string | null;
  container_port: number | null;
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
  labels: string; // comma-separated
  author: string;
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

  // ── issues ────────────────────────────────────────────────────────────
  createIssue(
    owner: string,
    repo: string,
    fields: { title: string; body: string; author: string; labels: string[] },
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
      };
      this.db.run(
        `INSERT INTO issues (id, owner, repo, number, title, body, state, labels, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return this.db
      .query<
        IssueCommentRow,
        [string, string, number]
      >("SELECT * FROM issue_comments WHERE owner = ? AND repo = ? AND number = ? ORDER BY id ASC")
      .all(owner, repo, number);
  }
}
