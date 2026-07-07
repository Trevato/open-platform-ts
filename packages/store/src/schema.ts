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
];
