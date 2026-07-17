// Migrations are append-only. Never edit a shipped entry — add a new one.
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE repos (
    id             TEXT PRIMARY KEY,
    owner          TEXT NOT NULL,
    name           TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    is_template    INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    UNIQUE(owner, name)
  );
  CREATE TABLE hosts (
    host           TEXT PRIMARY KEY,
    owner          TEXT NOT NULL,
    app            TEXT NOT NULL,
    container_id   TEXT,
    container_port INTEGER,
    updated_at     INTEGER NOT NULL
  );
  CREATE TABLE app_status (
    owner        TEXT NOT NULL,
    app          TEXT NOT NULL,
    state        TEXT NOT NULL,
    image_digest TEXT,
    container_id TEXT,
    message      TEXT,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (owner, app)
  );
  `,
  `
  CREATE TABLE deploy_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner      TEXT NOT NULL,
    app        TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    phase      TEXT NOT NULL,
    message    TEXT,
    sha        TEXT
  );
  CREATE INDEX deploy_events_app ON deploy_events (owner, app, id);
  `,
  `
  CREATE TABLE oauth_clients (
    client_id       TEXT PRIMARY KEY,
    secret_hash     TEXT NOT NULL,
    owner           TEXT NOT NULL,
    app             TEXT NOT NULL,
    redirect_uris   TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE oauth_codes (
    code           TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope          TEXT NOT NULL,
    nonce          TEXT,
    expires_at     INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE pull_requests (
    id         TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    repo       TEXT NOT NULL,
    number     INTEGER NOT NULL,
    title      TEXT NOT NULL,
    head_ref   TEXT NOT NULL,
    base_ref   TEXT NOT NULL,
    state      TEXT NOT NULL DEFAULT 'open',
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(owner, repo, number)
  );
  `,
  `
  CREATE TABLE issues (
    id         TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    repo       TEXT NOT NULL,
    number     INTEGER NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL DEFAULT 'open',
    labels     TEXT NOT NULL DEFAULT '',   -- comma-separated
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(owner, repo, number)
  );
  CREATE TABLE issue_comments (
    id         TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    repo       TEXT NOT NULL,
    number     INTEGER NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX issue_comments_issue ON issue_comments (owner, repo, number, id);
  `,
  `
  -- An org is a shared OWNER namespace: repos and apps are owned by an org name
  -- exactly as they are by a username (owner stays a bare string everywhere —
  -- paths, hosts, gitops, mitosis are unchanged). Membership is what lets more
  -- than one user write under that namespace. Names live in the SAME flat space
  -- as usernames, so creation guards both directions against collision.
  CREATE TABLE orgs (
    name        TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE org_members (
    org       TEXT NOT NULL REFERENCES orgs(name) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'member'
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org, user_id)
  );
  CREATE INDEX org_members_user ON org_members (user_id);
  `,
  `
  -- Issue dependencies: a single "blocked-by" edge per pair. An issue with any
  -- OPEN blocker is not worked by the crew until the blocker closes. Cycles are
  -- rejected at write time (forge), so this graph is always a DAG.
  CREATE TABLE issue_deps (
    owner       TEXT NOT NULL,
    repo        TEXT NOT NULL,
    number      INTEGER NOT NULL,   -- the blocked issue
    blocked_by  INTEGER NOT NULL,   -- the issue it waits on (same repo)
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (owner, repo, number, blocked_by)
  );
  CREATE INDEX issue_deps_repo ON issue_deps (owner, repo, number);
  `,
  `
  -- Public raw-TCP endpoints (the hosts-table analog for L4). An app's op.json
  -- may declare container TCP ports (a Minecraft server's 25565); each gets a
  -- STABLE public port from the platform's range — the allocation outlives
  -- redeploys so players' saved addresses keep working. host_port is the
  -- container's loopback binding the TCP gate relays to; NULL while stopped.
  CREATE TABLE app_ports (
    public_port    INTEGER PRIMARY KEY,
    owner          TEXT NOT NULL,
    app            TEXT NOT NULL,
    container_port INTEGER NOT NULL,
    host_port      INTEGER,
    updated_at     INTEGER NOT NULL,
    UNIQUE(owner, app, container_port)
  );
  `,
  `
  -- Work items: the issue IS the unit of work; the PR collapses into change
  -- fields on the item plus an append-only attempts ledger. pull_requests is
  -- frozen read-only history — no new PR numbers are ever minted.
  --
  -- phase is the single source of process truth (labels become taxonomy only):
  --   intent → queued → building → reviewing → (reworking ↔ reviewing)*
  --     → shipped | parked | closed
  -- state stays as the derived open/closed mirror for old readers.
  ALTER TABLE issues ADD COLUMN phase TEXT NOT NULL DEFAULT 'intent';
  ALTER TABLE issues ADD COLUMN head_ref TEXT;
  ALTER TABLE issues ADD COLUMN base_ref TEXT;
  ALTER TABLE issues ADD COLUMN change_state TEXT;
  ALTER TABLE issues ADD COLUMN parked_reason TEXT;
  CREATE INDEX issues_phase ON issues (phase);

  CREATE TABLE work_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    head_sha TEXT,
    builder_cost_usd REAL,
    verdict TEXT,
    verdict_line TEXT,
    reviewer_cost_usd REAL,
    created_at INTEGER NOT NULL,
    UNIQUE (owner, repo, number, attempt)
  );

  -- Cross-repo work dependencies. Full coordinates on both sides so lifting
  -- the same-owner rule (enforced in forge) is a one-line change, never a
  -- migration. issue_deps is frozen (same-repo, unused live).
  CREATE TABLE work_deps (
    owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
    on_owner TEXT NOT NULL, on_repo TEXT NOT NULL, on_number INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner, repo, number, on_owner, on_repo, on_number)
  );
  CREATE INDEX work_deps_item ON work_deps (owner, repo, number);

  -- Backfill. 1) Stamp change fields onto issues from crew PRs (branch
  -- convention agent/issue-N was the only link between the two tables).
  UPDATE issues SET
    head_ref = (SELECT pr.head_ref FROM pull_requests pr
      WHERE pr.owner = issues.owner AND pr.repo = issues.repo
        AND pr.head_ref = 'agent/issue-' || issues.number),
    base_ref = (SELECT pr.base_ref FROM pull_requests pr
      WHERE pr.owner = issues.owner AND pr.repo = issues.repo
        AND pr.head_ref = 'agent/issue-' || issues.number),
    change_state = (SELECT CASE pr.state WHEN 'merged' THEN 'merged'
        WHEN 'open' THEN 'open' ELSE 'closed' END FROM pull_requests pr
      WHERE pr.owner = issues.owner AND pr.repo = issues.repo
        AND pr.head_ref = 'agent/issue-' || issues.number)
  WHERE EXISTS (SELECT 1 FROM pull_requests pr
      WHERE pr.owner = issues.owner AND pr.repo = issues.repo
        AND pr.head_ref = 'agent/issue-' || issues.number);

  -- 2) Labels → phase. A closed issue is closed regardless of any stale
  -- in-flight label an interrupted attempt left behind — state wins over
  -- transient labels. Only agent-shipped outranks it (that IS the closed,
  -- terminal-success phase). Active labels on OPEN issues park as 'migrated'.
  UPDATE issues SET phase = CASE
    WHEN instr(',' || labels || ',', ',agent-shipped,') > 0 THEN 'shipped'
    WHEN state = 'closed' THEN 'closed'
    WHEN instr(',' || labels || ',', ',agent-failed,') > 0
      OR instr(',' || labels || ',', ',agent-review-failed,') > 0 THEN 'parked'
    WHEN instr(',' || labels || ',', ',agent-building,') > 0
      OR instr(',' || labels || ',', ',agent-reviewing,') > 0
      OR instr(',' || labels || ',', ',agent-reworking,') > 0 THEN 'parked'
    WHEN instr(',' || labels || ',', ',agent-work,') > 0 THEN 'queued'
    ELSE 'intent' END;
  UPDATE issues SET parked_reason = 'migrated' WHERE phase = 'parked';

  -- 3) Strip dead phase labels; agent-work survives as the enqueue verb.
  UPDATE issues SET labels = trim(replace(replace(replace(replace(replace(replace(
    ',' || labels || ',',
    ',agent-building,', ','), ',agent-reviewing,', ','), ',agent-reworking,', ','),
    ',agent-shipped,', ','), ',agent-failed,', ','), ',agent-review-failed,', ','), ',');

  -- 4) issue_deps → work_deps (same-repo edges, table unused on live).
  INSERT OR IGNORE INTO work_deps (owner, repo, number, on_owner, on_repo, on_number, created_at)
    SELECT owner, repo, number, owner, repo, blocked_by, created_at FROM issue_deps;
  `,
  `
  -- hosts.container_port always stored the HOST loopback port the container
  -- published (it is what the gate dials on 127.0.0.1) — name it what it is,
  -- matching app_ports.host_port.
  ALTER TABLE hosts RENAME COLUMN container_port TO host_port;
  `,
];
