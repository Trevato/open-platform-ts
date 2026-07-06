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
];
