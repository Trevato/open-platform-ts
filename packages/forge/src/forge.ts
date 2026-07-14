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
    // createRepo enforces canWriteOwner(actor, owner) — an org owner is allowed
    // only for members. Keep the git-side owner in lock-step with the repo row.
    const created = await this.createRepo(actor, owner, name);
    if (created.status === "error") return created as Result<never, ForgeError>;
    const gen = await this.git.createFromTemplate(tpl, owner, name);
    if (gen.status === "error") {
      return Result.err(
        new ForgeError({ message: gen.error.message, code: "invalid" }),
      );
    }
    return created;
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
      }),
    );
  }

  /** Label changes are a write intent (they can trigger the crew). */
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
    return Result.ok({ ...issue, labels: clean.join(",") });
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
