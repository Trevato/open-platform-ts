# M1 package contracts

The composition root (`opd`) composes packages against these exact surfaces.
If a signature must change, change it here in the same commit.

Shared rules for every package:

- Errors are `TaggedError` classes from `@op/core`; fallible I/O returns
  `Result` (better-result via `@op/core`). Pure logic returns plain values.
- No new runtime dependencies beyond what the package.json already declares.
- `Bun.spawn` for subprocesses; never shell-interpolate user input (argv arrays
  only). All fs paths through `@op/core` `repoPath`/`appDataDir` or validated
  with `isValidName`.
- Tests live in `packages/<name>/test/*.test.ts` and must pass with `bun test`.

## @op/git — GitHost

```ts
export class GitError extends TaggedError("GitError")<{
  message: string;
  op: string;
}>() {}

export interface PushEvent {
  owner: string;
  name: string;
}

export class GitHost {
  constructor(sd: StateDir, opts?: { log?: Log });
  /** git init --bare (dir from repoPath). Idempotent. */
  initBareRepo(owner: string, name: string): Promise<Result<void, GitError>>;
  /**
   * Smart-HTTP endpoint. Handles:
   *   GET  …/info/refs?service=git-upload-pack|git-receive-pack
   *   POST …/git-upload-pack | …/git-receive-pack
   * Spawns `git upload-pack|receive-pack --stateless-rpc [--advertise-refs]`.
   * MUST transparently gunzip request bodies when Content-Encoding: gzip
   * (git clients send this). Streams stdout to the Response.
   * Emits PushEvent to onPush subscribers after a receive-pack POST exits 0.
   * Caller has already authenticated/authorized; `write` gates receive-pack.
   */
  handleSmartHttp(
    req: Request,
    owner: string,
    name: string,
    perms: { read: boolean; write: boolean },
  ): Promise<Response>;
  onPush(cb: (evt: PushEvent) => void): void;
  /** SHA of ref (default HEAD). */
  headSha(
    owner: string,
    name: string,
    ref?: string,
  ): Promise<Result<string, GitError>>;
  /** File bytes at ref:path via `git cat-file blob`. */
  readFile(
    owner: string,
    name: string,
    ref: string,
    path: string,
  ): Promise<Result<Uint8Array, GitError>>;
  /** List paths at ref via `git ls-tree -r --name-only`. */
  listFiles(
    owner: string,
    name: string,
    ref: string,
  ): Promise<Result<string[], GitError>>;
  /**
   * Fresh-history instantiation (like Forgejo generate): temp checkout of
   * template HEAD tree → single orphan commit → push into a new bare repo.
   */
  createFromTemplate(
    tpl: { owner: string; name: string },
    owner: string,
    name: string,
  ): Promise<Result<void, GitError>>;
  /** Materialize a repo's default branch into a bare repo from a directory of files (used for genesis + tests). */
  seedRepoFromDir(
    owner: string,
    name: string,
    dir: string,
    message?: string,
  ): Promise<Result<void, GitError>>;
  /** git bundle create <out> --all */
  bundle(
    owner: string,
    name: string,
    outFile: string,
  ): Promise<Result<void, GitError>>;
  /** Create the bare repo from a bundle (clone --bare <bundle>). */
  restoreFromBundle(
    bundleFile: string,
    owner: string,
    name: string,
  ): Promise<Result<void, GitError>>;
}
```

## @op/forge — Forge

```ts
export class ForgeError extends TaggedError("ForgeError")<{
  message: string;
  code: "conflict" | "not_found" | "unauthorized" | "invalid";
}>() {}

export class Forge {
  constructor(store: Store, git: GitHost);
  createUser(
    username: string,
    password: string,
    opts?: { admin?: boolean },
  ): Promise<Result<UserRow, ForgeError>>;
  /** argon2id via Bun.password. */
  verifyPassword(username: string, password: string): Promise<UserRow | null>;
  /** Returns plaintext token ONCE (`op_pat_…`); sha256 stored. */
  createPat(
    userId: string,
    name: string,
  ): Promise<Result<{ token: string }, ForgeError>>;
  /** Basic (user:pat|user:password), Bearer <pat>, or `op_session` cookie. */
  authenticate(req: Request): Promise<UserRow | null>;
  createSession(userId: string): { id: string; expiresAt: number };
  /** M1 policy: write = owner or admin; read = anyone (repos public-read). Fail-closed on unknown repo. */
  authorize(
    user: UserRow | null,
    owner: string,
    repo: string,
    need: "read" | "write",
  ): boolean;
  createRepo(
    actor: UserRow,
    owner: string,
    name: string,
    opts?: { isTemplate?: boolean },
  ): Promise<Result<RepoRow, ForgeError>>;
  createFromTemplate(
    actor: UserRow,
    tpl: { owner: string; name: string },
    name: string,
  ): Promise<Result<RepoRow, ForgeError>>;
}

/**
 * HTTP surface, mounted by opd on the platform host. Returns null if the
 * request doesn't match a forge route.
 * Routes:
 *   POST /api/v1/users            {username,password} admin-only (or first-boot)
 *   POST /api/v1/users/:u/tokens  {name} → {token}   (self or admin)
 *   POST /api/v1/repos            {name, template?: "owner/name", isTemplate?} → repo (owner = caller)
 *   GET  /api/v1/repos/:o/:n      → repo row
 *   ANY  /:owner/:name.git/...    → GitHost.handleSmartHttp (Basic auth; 401 with WWW-Authenticate on anon write)
 */
export function forgeRouter(
  forge: Forge,
  git: GitHost,
): (req: Request) => Promise<Response | null>;
```

## @op/engine — Docker Engine API client (+ image build)

```ts
export class EngineError extends TaggedError("EngineError")<{
  message: string;
  op: string;
  status?: number;
}>() {}

export class Engine {
  constructor(socketPath?: string); // default /var/run/docker.sock; honors DOCKER_HOST unix: paths
  ping(): Promise<Result<void, EngineError>>;
  /**
   * POST /build with a tar of contextDir (spawn `tar -C dir -cf - .`).
   * Parses the JSON progress stream; returns the built image ID.
   * Tag format: op/<owner>-<app>:<shortsha>.
   */
  buildImage(opts: {
    contextDir: string;
    tag: string;
  }): Promise<Result<{ imageId: string }, EngineError>>;
  /**
   * Create+start. Returns published host port for the container port.
   * Hardening defaults ALWAYS applied: User "65534:65534" unless spec.user,
   * CapDrop ALL, SecurityOpt no-new-privileges, Memory/CPU limits,
   * RestartPolicy always, label op.platform=<platformId>, op.owner, op.app.
   * PortBindings: containerPort → 127.0.0.1:0 (engine assigns; read back via inspect).
   */
  runApp(spec: {
    image: string;
    owner: string;
    app: string;
    platformId: string;
    env: Record<string, string>;
    containerPort: number;
    dataDir?: string; // bind-mounted at /data
    memoryBytes?: number;
    nanoCpus?: number;
    user?: string;
  }): Promise<Result<{ containerId: string; hostPort: number }, EngineError>>;
  stopAndRemove(containerId: string): Promise<Result<void, EngineError>>;
  /** Containers labeled op.platform=<platformId>. */
  listPlatformContainers(
    platformId: string,
  ): Promise<
    Result<
      Array<{
        id: string;
        owner: string;
        app: string;
        image: string;
        state: string;
        hostPort: number | null;
      }>,
      EngineError
    >
  >;
  logs(
    containerId: string,
    opts?: { tail?: number },
  ): Promise<Result<string, EngineError>>;
}
```

## @op/data — the data primitive

```ts
export class DataError extends TaggedError("DataError")<{
  message: string;
  op: string;
}>() {}

/** mkdir appdata/<owner>/<app>/files; returns absolute dir. Idempotent. */
export function provisionDataDir(
  sd: StateDir,
  owner: string,
  app: string,
): Promise<Result<string, DataError>>;

/**
 * Crash-consistent snapshot:
 * 1. If app.db exists: open it (same host, POSIX locks coordinate with the
 *    app), PRAGMA wal_checkpoint(TRUNCATE), close.
 * 2. Clone dir to appdata/.snapshots/<owner>/<app>/<id>/ — try APFS clonefile
 *    (`cp -c -R`), then GNU reflink (`cp -a --reflink=always`), else fall back
 *    to `VACUUM INTO` for app.db + plain copy for files/.
 * 3. Verify: open snapshot app.db read-only, PRAGMA integrity_check == "ok".
 * Never returns a snapshot that failed verification.
 */
export function snapshot(
  sd: StateDir,
  owner: string,
  app: string,
): Promise<Result<{ id: string; dir: string }, DataError>>;

export function listSnapshots(
  sd: StateDir,
  owner: string,
  app: string,
): Promise<Result<string[], DataError>>;

/** Replaces the live data dir with the snapshot (app must be stopped by caller). */
export function restore(
  sd: StateDir,
  owner: string,
  app: string,
  snapshotId: string,
): Promise<Result<void, DataError>>;
```

## @op/gate — ingress

```ts
export class GateError extends TaggedError("GateError")<{
  message: string;
}>() {}

/** CA + wildcard leaf (*.domain and domain SANs), PEM files in certsDir
 *  (ca.crt, ca.key, wildcard.crt, wildcard.key). @peculiar/x509 on WebCrypto.
 *  Idempotent: reuses existing files. Returns PEM strings. */
export function ensureCa(
  certsDir: string,
  domain: string,
): Promise<Result<{ caCert: string; cert: string; key: string }, GateError>>;

export class Gate {
  constructor(opts: {
    store: Store;
    domain: string;
    httpPort: number;
    httpsPort: number;
    tls: { cert: string; key: string };
    /** Handles requests whose Host is exactly `domain` (the platform itself). */
    platformHandler: (req: Request) => Promise<Response>;
    /** null = anonymous. Used by the SSO gate for app hosts. */
    resolveUser: (req: Request) => Promise<{ username: string } | null>;
    /** Fail-closed app access decision (M1: public-read repos → anon allowed). */
    authorizeApp: (
      user: { username: string } | null,
      owner: string,
      app: string,
    ) => boolean;
    log?: Log;
  });
  /** Starts HTTPS on httpsPort and an HTTP→HTTPS redirect on httpPort. */
  start(): void;
  stop(): void;
}
```

App-host flow (forward-auth as a function, ON by default): strip any client
`X-Plat-*` headers → resolveUser → look up Host in store.hosts → authorizeApp
(403/302 on deny) → proxy to `127.0.0.1:<host_port>` injecting `X-Plat-User`.
Unknown Host → 404. WebSockets/streaming may be deferred past M1; plain
request/response proxying must work.

## Composition (owned by opd — do not implement in leaf packages)

reconcile, policy, mitosis, genesis content, CLI, and the M1 e2e test compose
the above. Leaf packages must not import each other beyond what's listed in
their package.json.
