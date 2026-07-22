import {
  isReservedName,
  isValidName,
  newToken,
  Result,
  sha256Hex,
} from "@op/core";
import type { GitHost } from "@op/git";
import type {
  IssueCommentRow,
  IssueRow,
  OrgRow,
  PullRequestRow,
  RepoRow,
  Store,
  UserRow,
} from "@op/store";
import { ForgeError } from "./errors.ts";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// bun:sqlite throws plain errors; the UNIQUE message is the only signal we
// get for duplicate usernames/repos.
function mapSqliteError(cause: unknown, what: string): ForgeError {
  const msg = String(cause);
  if (msg.includes("UNIQUE")) {
    return new ForgeError({
      message: `${what} already exists`,
      code: "conflict",
    });
  }
  return new ForgeError({ message: `${what}: ${msg}`, code: "invalid" });
}

export class Forge {
  constructor(
    readonly store: Store,
    readonly git: GitHost,
  ) {}

  async createUser(
    username: string,
    password: string,
    opts?: { admin?: boolean; system?: boolean },
  ): Promise<Result<UserRow, ForgeError>> {
    if (!isValidName(username)) {
      return Result.err(
        new ForgeError({
          message: `invalid username: ${username}`,
          code: "invalid",
        }),
      );
    }
    // Reserved names are platform-owned; only the platform itself (genesis,
    // system:true) may take one. Self-serve callers can never claim them.
    if (!opts?.system && isReservedName(username)) {
      return Result.err(
        new ForgeError({
          message: `'${username}' is reserved`,
          code: "invalid",
        }),
      );
    }
    if (password.length === 0) {
      return Result.err(
        new ForgeError({
          message: "password must not be empty",
          code: "invalid",
        }),
      );
    }
    // Usernames and org names share one flat owner space — a username may not
    // shadow an existing org (the createOrg guard covers the other direction).
    if (this.store.getOrg(username) !== null) {
      return Result.err(
        new ForgeError({
          message: `'${username}' is already an org`,
          code: "conflict",
        }),
      );
    }
    const hash = await Bun.password.hash(password);
    try {
      return Result.ok(
        this.store.createUser(username, hash, opts?.admin ?? false),
      );
    } catch (cause) {
      return Result.err(mapSqliteError(cause, `user ${username}`));
    }
  }

  async verifyPassword(
    username: string,
    password: string,
  ): Promise<UserRow | null> {
    const user = this.store.getUser(username);
    if (!user) return null;
    const ok = await Bun.password
      .verify(password, user.password_hash)
      .catch(() => false);
    return ok ? user : null;
  }

  async createPat(
    userId: string,
    name: string,
  ): Promise<Result<{ token: string }, ForgeError>> {
    const token = newToken("op_pat");
    try {
      this.store.createToken(userId, name, await sha256Hex(token));
    } catch (cause) {
      return Result.err(mapSqliteError(cause, `token for ${userId}`));
    }
    return Result.ok({ token });
  }

  async authenticate(req: Request): Promise<UserRow | null> {
    const auth = req.headers.get("authorization");
    if (auth !== null) {
      const space = auth.indexOf(" ");
      if (space < 0) return null;
      const scheme = auth.slice(0, space).toLowerCase();
      const cred = auth.slice(space + 1).trim();
      if (scheme === "basic") {
        let decoded: string;
        try {
          decoded = atob(cred);
        } catch {
          return null;
        }
        const colon = decoded.indexOf(":");
        if (colon < 0) return null;
        const username = decoded.slice(0, colon);
        const secret = decoded.slice(colon + 1);
        const byPat = this.store.userByTokenHash(await sha256Hex(secret));
        if (byPat !== null && byPat.username === username) return byPat;
        return this.verifyPassword(username, secret);
      }
      if (scheme === "bearer") {
        return this.store.userByTokenHash(await sha256Hex(cred));
      }
      return null;
    }
    const cookie = req.headers.get("cookie");
    if (cookie !== null) {
      for (const part of cookie.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === "op_session") {
          return this.store.userBySession(part.slice(eq + 1).trim());
        }
      }
    }
    return null;
  }

  createSession(userId: string): { id: string; expiresAt: number } {
    return this.store.createSession(userId, SESSION_TTL_MS);
  }

  authorize(
    user: UserRow | null,
    owner: string,
    repo: string,
    need: "read" | "write",
  ): boolean {
    if (this.store.getRepo(owner, repo) === null) return false;
    if (need === "read") return true;
    if (user === null) return false;
    return this.canWriteOwner(user, owner);
  }

  /** May this user write under an owner namespace? True for their own
   *  username, any org they're a member of, or admin. The single seam every
   *  write path (repos, PRs, issues, apps, imports) goes through. */
  canWriteOwner(user: UserRow, owner: string): boolean {
    if (user.is_admin === 1) return true;
    if (user.username === owner) return true;
    return this.store.isOrgMember(owner, user.id);
  }

  // ── orgs ─────────────────────────────────────────────────────────────
  /** Create an org namespace. Fails closed on collisions in EITHER direction:
   *  an org may not shadow a reserved name, an existing username, or an
   *  existing org — usernames and org names share one flat owner space. */
  async createOrg(
    actor: UserRow,
    name: string,
    displayName = "",
  ): Promise<Result<OrgRow, ForgeError>> {
    if (!isValidName(name)) {
      return Result.err(
        new ForgeError({
          message: `invalid org name: ${name}`,
          code: "invalid",
        }),
      );
    }
    if (isReservedName(name)) {
      return Result.err(
        new ForgeError({ message: `'${name}' is reserved`, code: "invalid" }),
      );
    }
    if (this.store.getUser(name) !== null) {
      return Result.err(
        new ForgeError({
          message: `'${name}' is already a username`,
          code: "conflict",
        }),
      );
    }
    try {
      return Result.ok(this.store.createOrg(name, actor.id, displayName));
    } catch (cause) {
      return Result.err(mapSqliteError(cause, `org ${name}`));
    }
  }

  /** Add a member to an org. Only an existing member may invite (M1: flat
   *  membership — every member can add). */
  addOrgMember(
    actor: UserRow,
    org: string,
    username: string,
  ): Result<void, ForgeError> {
    if (this.store.getOrg(org) === null)
      return Result.err(
        new ForgeError({ message: `no such org: ${org}`, code: "not_found" }),
      );
    if (!this.canWriteOwner(actor, org))
      return Result.err(
        new ForgeError({
          message: `${actor.username} is not a member of ${org}`,
          code: "unauthorized",
        }),
      );
    const target = this.store.getUser(username);
    if (target === null)
      return Result.err(
        new ForgeError({
          message: `no such user: ${username}`,
          code: "not_found",
        }),
      );
    this.store.addOrgMember(org, target.id);
    return Result.ok(undefined);
  }

  async createRepo(
    actor: UserRow,
    owner: string,
    name: string,
    opts?: { isTemplate?: boolean },
  ): Promise<Result<RepoRow, ForgeError>> {
    if (!isValidName(owner) || !isValidName(name)) {
      return Result.err(
        new ForgeError({
          message: `invalid repo name: ${owner}/${name}`,
          code: "invalid",
        }),
      );
    }
    if (!this.canWriteOwner(actor, owner)) {
      return Result.err(
        new ForgeError({
          message: `${actor.username} may not create repos under ${owner}`,
          code: "unauthorized",
        }),
      );
    }
    let row: RepoRow;
    try {
      row = this.store.createRepo(owner, name, {
        isTemplate: opts?.isTemplate ?? false,
      });
    } catch (cause) {
      return Result.err(mapSqliteError(cause, `repo ${owner}/${name}`));
    }
    const init = await this.git.initBareRepo(owner, name);
    if (init.status === "error") {
      return Result.err(
        new ForgeError({ message: init.error.message, code: "invalid" }),
      );
    }
    return Result.ok(row);
  }

  /**
   * Import an external git repo (e.g. a GitHub URL) as a new owner/name repo.
   * Same authz as createRepo (member of the owner namespace), then the repo
   * row + a hardened bare clone. The crew tunes it to platform conventions
   * afterward via an agent-import issue.
   */
  async importFromRemote(
    actor: UserRow,
    owner: string,
    name: string,
    url: string,
  ): Promise<Result<RepoRow, ForgeError>> {
    if (!isValidName(owner) || !isValidName(name))
      return Result.err(
        new ForgeError({
          message: `invalid repo name: ${owner}/${name}`,
          code: "invalid",
        }),
      );
    if (!this.canWriteOwner(actor, owner))
      return Result.err(
        new ForgeError({
          message: `${actor.username} may not create repos under ${owner}`,
          code: "unauthorized",
        }),
      );
    let row: RepoRow;
    try {
      row = this.store.createRepo(owner, name);
    } catch (cause) {
      return Result.err(mapSqliteError(cause, `repo ${owner}/${name}`));
    }
    const cloned = await this.git.cloneFromRemote(url, owner, name);
    if (cloned.status === "error") {
      // Roll back the row so a failed import leaves no phantom repo.
      this.store.deleteRepo(owner, name);
      return Result.err(
        new ForgeError({ message: cloned.error.message, code: "invalid" }),
      );
    }
    return Result.ok(row);
  }

  async createFromTemplate(
    actor: UserRow,
    tpl: { owner: string; name: string },
    name: string,
    owner: string = actor.username,
  ): Promise<Result<RepoRow, ForgeError>> {
    const tplRow = this.store.getRepo(tpl.owner, tpl.name);
    if (tplRow === null) {
      return Result.err(
        new ForgeError({
          message: `template not found: ${tpl.owner}/${tpl.name}`,
          code: "not_found",
        }),
      );
    }
    if (tplRow.is_template !== 1) {
      return Result.err(
        new ForgeError({
          message: `${tpl.owner}/${tpl.name} is not a template`,
          code: "invalid",
        }),
      );
    }
    // Auth up front (createRepo re-checks, but we run git BEFORE it now, so
    // guard here to avoid materializing an orphan git repo on a denied create).
    if (!this.canWriteOwner(actor, owner))
      return Result.err(
        new ForgeError({
          message: `${actor.username} may not create repos under ${owner}`,
          code: "unauthorized",
        }),
      );
    // Populate the git repo (init + clone template content) BEFORE the store
    // row exists. The store row is what makes a repo visible to the crew
    // dispatcher (`getRepo` gate); creating it last means `getRepo(...)=true`
    // implies a clonable, populated repo — so a work item filed concurrently
    // with app creation can never be claimed and fail to clone an empty repo.
    // (initBareRepo is idempotent, so createRepo's own init is a no-op here.)
    const gen = await this.git.createFromTemplate(tpl, owner, name);
    if (gen.status === "error")
      return Result.err(
        new ForgeError({ message: gen.error.message, code: "invalid" }),
      );
    return this.createRepo(actor, owner, name);
  }

  // ── work items ──────────────────────────────────────────────────────────
  // One unit of work: intent + at most one change + an attempts ledger. The
  // PR is an implementation detail that no longer exists as a noun; the old
  // pull-request ops below remain only until every caller has moved.

  /** File a work item. Anyone may state intent on a public repo; attaching a
   *  change (`head`) is a write intent and validates like the old createPr —
   *  that item is born at `reviewing`, so human branches flow through the
   *  same review machinery as crew branches. */
  async createWork(
    actor: UserRow,
    owner: string,
    repo: string,
    fields: {
      title: string;
      body?: string;
      labels?: string[];
      head?: string;
      base?: string;
    },
  ): Promise<Result<IssueRow, ForgeError>> {
    const repoRow = this.store.getRepo(owner, repo);
    if (!repoRow)
      return Result.err(
        new ForgeError({ message: "repo not found", code: "not_found" }),
      );
    const title = fields.title.trim();
    if (!title)
      return Result.err(
        new ForgeError({ message: "title required", code: "invalid" }),
      );
    const labels = (fields.labels ?? [])
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean);

    let change: { head: string; base: string } | undefined;
    if (fields.head) {
      if (!this.authorize(actor, owner, repo, "write"))
        return Result.err(
          new ForgeError({ message: "unauthorized", code: "unauthorized" }),
        );
      const base = fields.base ?? repoRow.default_branch;
      if (fields.head === base)
        return Result.err(
          new ForgeError({
            message: "head and base are the same branch",
            code: "invalid",
          }),
        );
      for (const ref of [fields.head, base]) {
        const sha = await this.git.headSha(owner, repo, ref);
        if (sha.status === "error")
          return Result.err(
            new ForgeError({
              message: `no such branch: ${ref}`,
              code: "invalid",
            }),
          );
      }
      change = { head: fields.head, base };
    }

    return Result.ok(
      this.store.createIssue(owner, repo, {
        title,
        body: fields.body ?? "",
        author: actor.username,
        labels,
        phase: change
          ? "reviewing"
          : labels.includes("agent-work")
            ? "queued"
            : "intent",
        ...(change ? { change } : {}),
      }),
    );
  }

  /** Queue an intent for the crew (the agent-work label remains the verb;
   *  this stamps the phase it implies). */
  queueWork(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
  ): Result<void, ForgeError> {
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    const item = this.store.getIssue(owner, repo, number);
    if (!item)
      return Result.err(
        new ForgeError({ message: "work item not found", code: "not_found" }),
      );
    if (item.phase === "queued") return Result.ok(undefined);
    try {
      this.store.setWorkPhase(owner, repo, number, "queued");
    } catch (cause) {
      return Result.err(
        new ForgeError({ message: String(cause), code: "invalid" }),
      );
    }
    const labels = item.labels.split(",").filter(Boolean);
    if (!labels.includes("agent-work"))
      this.store.setIssueLabels(owner, repo, number, [...labels, "agent-work"]);
    return Result.ok(undefined);
  }

  /** Attach the builder's change to a work item and hand it to review.
   *  Validates branches exactly as opening a PR once did. */
  async attachChange(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
    fields: { head: string; base?: string },
  ): Promise<Result<IssueRow, ForgeError>> {
    const repoRow = this.store.getRepo(owner, repo);
    if (!repoRow)
      return Result.err(
        new ForgeError({ message: "repo not found", code: "not_found" }),
      );
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    const item = this.store.getIssue(owner, repo, number);
    if (!item)
      return Result.err(
        new ForgeError({ message: "work item not found", code: "not_found" }),
      );
    const base = fields.base ?? repoRow.default_branch;
    if (fields.head === base)
      return Result.err(
        new ForgeError({
          message: "head and base are the same branch",
          code: "invalid",
        }),
      );
    for (const ref of [fields.head, base]) {
      const sha = await this.git.headSha(owner, repo, ref);
      if (sha.status === "error")
        return Result.err(
          new ForgeError({
            message: `no such branch: ${ref}`,
            code: "invalid",
          }),
        );
    }
    this.store.attachChange(owner, repo, number, { head: fields.head, base });
    try {
      this.store.setWorkPhase(owner, repo, number, "reviewing");
    } catch (cause) {
      // Self-heal a phase drift: under heavy concurrency a building item has
      // been observed back at `queued` by the time its build finishes (see the
      // phase-race note). We own this item and hold a real built change, so
      // rather than lose the work, re-assert the claim (queued → building) and
      // retry the move to reviewing. Any other unexpected phase is a genuine
      // error.
      const cur = this.store.getIssue(owner, repo, number);
      if (
        cur?.phase === "queued" &&
        this.store.claimWork(owner, repo, number)
      ) {
        try {
          this.store.setWorkPhase(owner, repo, number, "reviewing");
        } catch (retryCause) {
          return Result.err(
            new ForgeError({ message: String(retryCause), code: "invalid" }),
          );
        }
      } else {
        return Result.err(
          new ForgeError({ message: String(cause), code: "invalid" }),
        );
      }
    }
    return Result.ok(this.store.getIssue(owner, repo, number)!);
  }

  /** Merge a work item's change and ship it. The dispatcher calls this on a
   *  passing verdict; a human calls it to rescue parked or self-repo items. */
  async mergeWork(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
  ): Promise<Result<IssueRow, ForgeError>> {
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    const item = this.store.getIssue(owner, repo, number);
    if (!item)
      return Result.err(
        new ForgeError({ message: "work item not found", code: "not_found" }),
      );
    if (item.change_state !== "open" || !item.head_ref || !item.base_ref)
      return Result.err(
        new ForgeError({
          message: item.change_state
            ? `change is ${item.change_state}`
            : "no change attached",
          code: "invalid",
        }),
      );
    const merged = await this.git.mergeBranch(
      owner,
      repo,
      item.base_ref,
      item.head_ref,
      `Merge work item #${number}: ${item.title}`,
    );
    if (merged.status === "error")
      return Result.err(
        new ForgeError({ message: merged.error.message, code: "invalid" }),
      );
    try {
      this.store.setWorkPhase(owner, repo, number, "shipped");
    } catch (cause) {
      // The branch is merged in git; a phase race here must surface loudly.
      return Result.err(
        new ForgeError({ message: String(cause), code: "invalid" }),
      );
    }
    this.store.setChangeState(owner, repo, number, "merged");
    // The push event LAST: on plat/opd a subscriber stops the daemon for the
    // self-upgrade, and anything not yet written here would be lost — the
    // ledger must already say shipped/merged when it fires.
    this.git.firePushEvent(owner, repo);
    return Result.ok(this.store.getIssue(owner, repo, number)!);
  }

  /** Close a work item from any non-terminal phase. An open change closes
   *  with it, which is what tears down its preview on the next converge. */
  closeWork(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
  ): Result<void, ForgeError> {
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    const item = this.store.getIssue(owner, repo, number);
    if (!item)
      return Result.err(
        new ForgeError({ message: "work item not found", code: "not_found" }),
      );
    try {
      this.store.setWorkPhase(owner, repo, number, "closed");
    } catch (cause) {
      return Result.err(
        new ForgeError({ message: String(cause), code: "invalid" }),
      );
    }
    if (item.change_state === "open")
      this.store.setChangeState(owner, repo, number, "closed");
    return Result.ok(undefined);
  }

  /** Declare `item` blocked by `on`. Cross-repo, same-owner (the org
   *  decomposer's shape: website blocked by shop#3); lifting the owner rule
   *  later is one line, never a migration. The graph stays a DAG. */
  addWorkDep(
    actor: UserRow,
    item: { owner: string; repo: string; number: number },
    on: { owner: string; repo: string; number: number },
  ): Result<void, ForgeError> {
    if (!this.authorize(actor, item.owner, item.repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    if (on.owner !== item.owner)
      return Result.err(
        new ForgeError({
          message: "dependencies may not cross owners",
          code: "invalid",
        }),
      );
    const same =
      item.owner === on.owner &&
      item.repo === on.repo &&
      item.number === on.number;
    if (same)
      return Result.err(
        new ForgeError({
          message: "a work item cannot block itself",
          code: "invalid",
        }),
      );
    if (!this.store.getIssue(item.owner, item.repo, item.number))
      return Result.err(
        new ForgeError({
          message: `work item #${item.number} not found`,
          code: "not_found",
        }),
      );
    if (!this.store.getIssue(on.owner, on.repo, on.number))
      return Result.err(
        new ForgeError({
          message: `blocker ${on.repo}#${on.number} not found`,
          code: "not_found",
        }),
      );
    // Phase gate: the dispatcher only consults blockers while an item is still
    // `queued` (dispatcher tick, before it claims). Declaring a blocker on an
    // item the crew has already claimed (building/reviewing/…) would be
    // silently ignored — so reject it loudly instead of pretending it blocks.
    // Declare deps while the item is in `intent` or `queued`.
    const itemPhase = this.store.getIssue(
      item.owner,
      item.repo,
      item.number,
    )!.phase;
    if (itemPhase !== "intent" && itemPhase !== "queued")
      return Result.err(
        new ForgeError({
          message: `cannot add a dependency to a work item already in '${itemPhase}' — declare blockers before it is queued`,
          code: "invalid",
        }),
      );
    // Cycle check over (owner, repo, number) triples: adding item→on is
    // illegal if `on` already depends (transitively) on `item`.
    const keyOf = (x: { owner: string; repo: string; number: number }) =>
      `${x.owner}/${x.repo}#${x.number}`;
    const target = keyOf(item);
    const seen = new Set<string>();
    const stack = [on];
    while (stack.length) {
      const cur = stack.pop()!;
      if (keyOf(cur) === target)
        return Result.err(
          new ForgeError({
            message: `that dependency would create a cycle (${keyOf(on)} already depends on ${target})`,
            code: "invalid",
          }),
        );
      if (seen.has(keyOf(cur))) continue;
      seen.add(keyOf(cur));
      for (const d of this.store.listWorkDeps(cur.owner, cur.repo, cur.number))
        stack.push({ owner: d.on_owner, repo: d.on_repo, number: d.on_number });
    }
    this.store.addWorkDep(item, on);
    return Result.ok(undefined);
  }

  removeWorkDep(
    actor: UserRow,
    item: { owner: string; repo: string; number: number },
    on: { owner: string; repo: string; number: number },
  ): Result<void, ForgeError> {
    if (!this.authorize(actor, item.owner, item.repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    this.store.removeWorkDep(item, on);
    return Result.ok(undefined);
  }

  // ── pull requests ─────────────────────────────────────────────────────
  async createPr(
    actor: UserRow,
    owner: string,
    repo: string,
    fields: { title: string; head: string; base?: string },
  ): Promise<Result<PullRequestRow, ForgeError>> {
    const repoRow = this.store.getRepo(owner, repo);
    if (!repoRow)
      return Result.err(
        new ForgeError({ message: "repo not found", code: "not_found" }),
      );
    // Opening a PR is a write intent on the repo.
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    const base = fields.base ?? repoRow.default_branch;
    if (fields.head === base)
      return Result.err(
        new ForgeError({
          message: "head and base are the same branch",
          code: "invalid",
        }),
      );
    for (const ref of [fields.head, base]) {
      const sha = await this.git.headSha(owner, repo, ref);
      if (sha.status === "error")
        return Result.err(
          new ForgeError({
            message: `no such branch: ${ref}`,
            code: "invalid",
          }),
        );
    }
    const title = fields.title.trim() || `Merge ${fields.head} into ${base}`;
    return Result.ok(
      this.store.createPr(owner, repo, {
        title,
        headRef: fields.head,
        baseRef: base,
        author: actor.username,
      }),
    );
  }

  async mergePr(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
  ): Promise<Result<PullRequestRow, ForgeError>> {
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    const pr = this.store.getPr(owner, repo, number);
    if (!pr)
      return Result.err(
        new ForgeError({
          message: "pull request not found",
          code: "not_found",
        }),
      );
    if (pr.state !== "open")
      return Result.err(
        new ForgeError({
          message: `pull request is ${pr.state}`,
          code: "invalid",
        }),
      );
    const merged = await this.git.mergeBranch(
      owner,
      repo,
      pr.base_ref,
      pr.head_ref,
      `Merge pull request #${number}: ${pr.title}`,
    );
    if (merged.status === "error")
      return Result.err(
        new ForgeError({ message: merged.error.message, code: "invalid" }),
      );
    this.store.setPrState(owner, repo, number, "merged");
    // After the bookkeeping, same as mergeWork — see firePushEvent's contract.
    this.git.firePushEvent(owner, repo);
    return Result.ok({ ...pr, state: "merged" });
  }

  closePr(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
  ): Result<void, ForgeError> {
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    const pr = this.store.getPr(owner, repo, number);
    if (!pr)
      return Result.err(
        new ForgeError({
          message: "pull request not found",
          code: "not_found",
        }),
      );
    this.store.setPrState(owner, repo, number, "closed");
    return Result.ok(undefined);
  }

  // ── issues ────────────────────────────────────────────────────────────
  createIssue(
    actor: UserRow,
    owner: string,
    repo: string,
    fields: { title: string; body?: string; labels?: string[] },
  ): Result<IssueRow, ForgeError> {
    if (!this.store.getRepo(owner, repo))
      return Result.err(
        new ForgeError({ message: "repo not found", code: "not_found" }),
      );
    const title = fields.title.trim();
    if (!title)
      return Result.err(
        new ForgeError({ message: "title required", code: "invalid" }),
      );
    const labels = (fields.labels ?? [])
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean);
    return Result.ok(
      this.store.createIssue(owner, repo, {
        title,
        body: fields.body ?? "",
        author: actor.username,
        labels,
        // The agent-work label is the enqueue verb; filing with it is a birth
        // at queued, same as createWork.
        phase: labels.includes("agent-work") ? "queued" : "intent",
      }),
    );
  }

  /** Label changes are a write intent. Labels are taxonomy — with ONE verb:
   *  adding agent-work to an intent (or parked) item queues it for the crew.
   *  It can never move an item that is building/reviewing/shipped — the
   *  phase machine, not the label string, is the process truth. */
  setIssueLabels(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
    labels: string[],
  ): Result<IssueRow, ForgeError> {
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    const issue = this.store.getIssue(owner, repo, number);
    if (!issue)
      return Result.err(
        new ForgeError({ message: "issue not found", code: "not_found" }),
      );
    const clean = labels.map((l) => l.trim().toLowerCase()).filter(Boolean);
    this.store.setIssueLabels(owner, repo, number, clean);
    if (
      clean.includes("agent-work") &&
      (issue.phase === "intent" || issue.phase === "parked")
    )
      this.store.setWorkPhase(owner, repo, number, "queued");
    return Result.ok(this.store.getIssue(owner, repo, number)!);
  }

  /**
   * Declare that `number` is blocked by `blockedBy` (same repo). Rejects a
   * self-edge and any edge that would create a cycle, so the dependency graph
   * is always a DAG — the crew dispatcher can trust it to schedule work.
   */
  setIssueDep(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
    blockedBy: number,
  ): Result<void, ForgeError> {
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    if (number === blockedBy)
      return Result.err(
        new ForgeError({
          message: "an issue cannot block itself",
          code: "invalid",
        }),
      );
    if (!this.store.getIssue(owner, repo, number))
      return Result.err(
        new ForgeError({
          message: `issue #${number} not found`,
          code: "not_found",
        }),
      );
    if (!this.store.getIssue(owner, repo, blockedBy))
      return Result.err(
        new ForgeError({
          message: `issue #${blockedBy} not found`,
          code: "not_found",
        }),
      );
    // Phase gate (see addWorkDep): the dispatcher only honors blockers while an
    // item is still queued, so declaring one on an already-claimed item would
    // be silently ignored — reject it instead. Declare deps before queuing.
    const phase = this.store.getIssue(owner, repo, number)!.phase;
    if (phase !== "intent" && phase !== "queued")
      return Result.err(
        new ForgeError({
          message: `cannot add a dependency to a work item already in '${phase}' — declare blockers before it is queued`,
          code: "invalid",
        }),
      );
    // Cycle check: adding number→blockedBy is illegal if blockedBy already
    // depends (transitively) on number. Walk the blockers from blockedBy.
    const seen = new Set<number>();
    const stack = [blockedBy];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === number)
        return Result.err(
          new ForgeError({
            message: `that dependency would create a cycle (#${blockedBy} already depends on #${number})`,
            code: "invalid",
          }),
        );
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const b of this.store.listIssueBlockers(owner, repo, cur))
        stack.push(b);
    }
    this.store.addIssueDep(owner, repo, number, blockedBy);
    return Result.ok(undefined);
  }

  removeIssueDep(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
    blockedBy: number,
  ): Result<void, ForgeError> {
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    this.store.removeIssueDep(owner, repo, number, blockedBy);
    return Result.ok(undefined);
  }

  comment(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Result<IssueCommentRow, ForgeError> {
    if (!this.store.getIssue(owner, repo, number))
      return Result.err(
        new ForgeError({ message: "issue not found", code: "not_found" }),
      );
    if (!body.trim())
      return Result.err(
        new ForgeError({ message: "empty comment", code: "invalid" }),
      );
    return Result.ok(
      this.store.addComment(owner, repo, number, actor.username, body),
    );
  }

  closeIssue(
    actor: UserRow,
    owner: string,
    repo: string,
    number: number,
  ): Result<void, ForgeError> {
    if (!this.authorize(actor, owner, repo, "write"))
      return Result.err(
        new ForgeError({ message: "unauthorized", code: "unauthorized" }),
      );
    if (!this.store.getIssue(owner, repo, number))
      return Result.err(
        new ForgeError({ message: "issue not found", code: "not_found" }),
      );
    this.store.setIssueState(owner, repo, number, "closed");
    return Result.ok(undefined);
  }
}
