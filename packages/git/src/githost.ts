import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isValidName, repoPath, Result } from "@op/core";
import type { Log, StateDir } from "@op/core";
import { GitError } from "./errors.ts";

export interface PushEvent {
  owner: string;
  name: string;
}

// Server-side git must be deterministic: never inherit operator config
// (signing, hooks, credential helpers) from the host machine.
const GIT_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

// Commits minted by the platform (template instantiation, seeding).
const AUTHOR_FLAGS = [
  "-c",
  "user.name=op",
  "-c",
  "user.email=op@platform",
  "-c",
  "commit.gpgsign=false",
];

const NO_CACHE = { "cache-control": "no-cache" } as const;

function pktLine(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

// Bun 1.3's Response(stream).bytes() can hand back views over recycled spawn
// pipe buffers (observed as an all-zero advertisement). Copy every chunk.
async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk.slice());
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export class GitHost {
  private readonly sd: StateDir;
  private readonly log: Log | undefined;
  private readonly pushSubs: Array<(evt: PushEvent) => void> = [];

  constructor(sd: StateDir, opts?: { log?: Log }) {
    this.sd = sd;
    this.log = opts?.log;
  }

  onPush(cb: (evt: PushEvent) => void): void {
    this.pushSubs.push(cb);
  }

  private emitPush(evt: PushEvent): void {
    for (const cb of this.pushSubs) {
      try {
        cb(evt);
      } catch (cause) {
        this.log?.warn("push subscriber threw", { cause: String(cause) });
      }
    }
  }

  private async git(
    op: string,
    args: string[],
    opts?: {
      cwd?: string;
      stdin?: Uint8Array;
      env?: Record<string, string | undefined>;
    },
  ): Promise<Result<Uint8Array, GitError>> {
    try {
      const proc = Bun.spawn(["git", ...args], {
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
        stdout: "pipe",
        stderr: "pipe",
        env: opts?.env ?? GIT_ENV,
      });
      const [stdout, stderrBytes, code] = await Promise.all([
        collect(proc.stdout as ReadableStream<Uint8Array>),
        collect(proc.stderr as ReadableStream<Uint8Array>),
        proc.exited,
      ]);
      const stderr = new TextDecoder().decode(stderrBytes);
      if (code !== 0) {
        return Result.err(
          new GitError({
            message: `git ${args.filter((a) => a !== "-c" && !a.includes("=")).join(" ")} exited ${code}: ${stderr.trim()}`,
            op,
          }),
        );
      }
      return Result.ok(stdout);
    } catch (cause) {
      return Result.err(new GitError({ message: String(cause), op }));
    }
  }

  // Names are validated here (not just in repoPath, which panics) so callers
  // get a GitError value instead of a crash on hostile input.
  private dir(
    op: string,
    owner: string,
    name: string,
  ): Result<string, GitError> {
    if (!isValidName(owner) || !isValidName(name)) {
      return Result.err(
        new GitError({ message: `invalid repo name: ${owner}/${name}`, op }),
      );
    }
    return Result.ok(repoPath(this.sd, owner, name));
  }

  async initBareRepo(
    owner: string,
    name: string,
  ): Promise<Result<void, GitError>> {
    const dir = this.dir("initBareRepo", owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    if (existsSync(dir.value)) return Result.ok(undefined);
    try {
      await mkdir(dirname(dir.value), { recursive: true });
    } catch (cause) {
      return Result.err(
        new GitError({ message: String(cause), op: "initBareRepo" }),
      );
    }
    const r = await this.git("initBareRepo", [
      "init",
      "--bare",
      "-b",
      "main",
      dir.value,
    ]);
    return r.map(() => undefined);
  }

  async handleSmartHttp(
    req: Request,
    owner: string,
    name: string,
    perms: { read: boolean; write: boolean },
  ): Promise<Response> {
    const dir = this.dir("handleSmartHttp", owner, name);
    if (dir.status === "error" || !existsSync(dir.value)) {
      return new Response("repository not found", {
        status: 404,
        headers: NO_CACHE,
      });
    }
    const url = new URL(req.url);
    // Protocol v2 negotiation rides an env var, not argv.
    const gitProtocol = req.headers.get("git-protocol");
    const env =
      gitProtocol !== null
        ? { ...GIT_ENV, GIT_PROTOCOL: gitProtocol }
        : GIT_ENV;

    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      const service = url.searchParams.get("service");
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        return new Response("smart HTTP only", {
          status: 400,
          headers: NO_CACHE,
        });
      }
      if (!(service === "git-upload-pack" ? perms.read : perms.write)) {
        return new Response("forbidden", { status: 403, headers: NO_CACHE });
      }
      const adv = await this.git(
        "handleSmartHttp",
        [service.slice(4), "--stateless-rpc", "--advertise-refs", dir.value],
        { env },
      );
      if (adv.status === "error") {
        this.log?.error("advertise-refs failed", {
          owner,
          name,
          error: adv.error.message,
        });
        return new Response("git error", { status: 500, headers: NO_CACHE });
      }
      const header = new TextEncoder().encode(
        pktLine(`# service=${service}\n`) + "0000",
      );
      const body = new Uint8Array(header.byteLength + adv.value.byteLength);
      body.set(header);
      body.set(adv.value, header.byteLength);
      return new Response(body, {
        headers: {
          "content-type": `application/x-${service}-advertisement`,
          ...NO_CACHE,
        },
      });
    }

    if (
      req.method === "POST" &&
      (url.pathname.endsWith("/git-upload-pack") ||
        url.pathname.endsWith("/git-receive-pack"))
    ) {
      const service = url.pathname.endsWith("/git-receive-pack")
        ? "git-receive-pack"
        : "git-upload-pack";
      if (!(service === "git-upload-pack" ? perms.read : perms.write)) {
        return new Response("forbidden", { status: 403, headers: NO_CACHE });
      }
      let body = new Uint8Array(await req.arrayBuffer());
      if (req.headers.get("content-encoding") === "gzip") {
        try {
          body = Bun.gunzipSync(body);
        } catch {
          return new Response("bad gzip body", {
            status: 400,
            headers: NO_CACHE,
          });
        }
      }
      const proc = Bun.spawn(
        ["git", service.slice(4), "--stateless-rpc", dir.value],
        {
          stdin: body,
          stdout: "pipe",
          stderr: "ignore",
          env,
        },
      );
      if (service === "git-receive-pack") {
        void proc.exited.then((code) => {
          if (code === 0) this.emitPush({ owner, name });
        });
      }
      return new Response(proc.stdout as ReadableStream, {
        headers: {
          "content-type": `application/x-${service}-result`,
          ...NO_CACHE,
        },
      });
    }

    return new Response("not found", { status: 404, headers: NO_CACHE });
  }

  async headSha(
    owner: string,
    name: string,
    ref = "HEAD",
  ): Promise<Result<string, GitError>> {
    const dir = this.dir("headSha", owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    if (ref.startsWith("-")) {
      return Result.err(
        new GitError({ message: `invalid ref: ${ref}`, op: "headSha" }),
      );
    }
    const r = await this.git("headSha", ["rev-parse", "--verify", ref], {
      cwd: dir.value,
    });
    return r.map((b) => new TextDecoder().decode(b).trim());
  }

  async readFile(
    owner: string,
    name: string,
    ref: string,
    path: string,
  ): Promise<Result<Uint8Array, GitError>> {
    const dir = this.dir("readFile", owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    if (ref.startsWith("-")) {
      return Result.err(
        new GitError({ message: `invalid ref: ${ref}`, op: "readFile" }),
      );
    }
    return this.git("readFile", ["cat-file", "blob", `${ref}:${path}`], {
      cwd: dir.value,
    });
  }

  async listFiles(
    owner: string,
    name: string,
    ref: string,
  ): Promise<Result<string[], GitError>> {
    const dir = this.dir("listFiles", owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    if (ref.startsWith("-")) {
      return Result.err(
        new GitError({ message: `invalid ref: ${ref}`, op: "listFiles" }),
      );
    }
    const r = await this.git(
      "listFiles",
      ["ls-tree", "-r", "--name-only", "-z", ref],
      {
        cwd: dir.value,
      },
    );
    return r.map((b) =>
      new TextDecoder()
        .decode(b)
        .split("\0")
        .filter((p) => p.length > 0),
    );
  }

  async listBranches(
    owner: string,
    name: string,
  ): Promise<Result<string[], GitError>> {
    const dir = this.dir("listBranches", owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    const r = await this.git(
      "listBranches",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
      { cwd: dir.value },
    );
    return r.map((b) =>
      new TextDecoder()
        .decode(b)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  // Changed files between base and head (the three-dot form: changes on head
  // since it diverged from base — exactly what a PR shows).
  async diffStat(
    owner: string,
    name: string,
    base: string,
    head: string,
  ): Promise<Result<{ files: string[]; patch: string }, GitError>> {
    const op = "diffStat";
    const dir = this.dir(op, owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    for (const ref of [base, head]) {
      if (ref.startsWith("-") || ref.includes(".."))
        return Result.err(new GitError({ message: `invalid ref: ${ref}`, op }));
    }
    const range = `${base}...${head}`;
    const names = await this.git(op, ["diff", "--name-only", range], {
      cwd: dir.value,
    });
    if (names.status === "error") return names as Result<never, GitError>;
    const patch = await this.git(op, ["diff", "--stat", range], {
      cwd: dir.value,
    });
    if (patch.status === "error") return patch as Result<never, GitError>;
    return Result.ok({
      files: new TextDecoder().decode(names.value).split("\n").filter(Boolean),
      patch: new TextDecoder().decode(patch.value),
    });
  }

  // Merge head into base and push. Temp clone (local, ms) → merge → push; a
  // conflict returns an error and leaves the bare repo untouched.
  async mergeBranch(
    owner: string,
    name: string,
    base: string,
    head: string,
    message: string,
  ): Promise<Result<void, GitError>> {
    const op = "mergeBranch";
    const dir = this.dir(op, owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    const tmp = await mkdtemp(join(tmpdir(), "op-merge-"));
    try {
      const work = join(tmp, "work");
      const steps: string[][] = [
        ["clone", dir.value, work],
        [...AUTHOR_FLAGS, "-C", work, "checkout", base],
        [
          ...AUTHOR_FLAGS,
          "-C",
          work,
          "merge",
          "--no-ff",
          "-m",
          message,
          `origin/${head}`,
        ],
        ["-C", work, "push", "origin", `${base}:${base}`],
      ];
      for (const args of steps) {
        const r = await this.git(op, args);
        if (r.status === "error") return r as Result<never, GitError>;
      }
      return Result.ok(undefined);
    } catch (cause) {
      return Result.err(new GitError({ message: String(cause), op }));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async createFromTemplate(
    tpl: { owner: string; name: string },
    owner: string,
    name: string,
  ): Promise<Result<void, GitError>> {
    const op = "createFromTemplate";
    const tplDir = this.dir(op, tpl.owner, tpl.name);
    if (tplDir.status === "error") return tplDir as Result<never, GitError>;
    const dir = this.dir(op, owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    if (!existsSync(tplDir.value)) {
      return Result.err(
        new GitError({
          message: `template not found: ${tpl.owner}/${tpl.name}`,
          op,
        }),
      );
    }
    const init = await this.initBareRepo(owner, name);
    if (init.status === "error") return init;
    const tmp = await mkdtemp(join(tmpdir(), "op-git-"));
    try {
      const work = join(tmp, "work");
      const clone = await this.git(op, [
        "clone",
        "--depth",
        "1",
        tplDir.value,
        work,
      ]);
      if (clone.status === "error") return clone as Result<never, GitError>;
      // Template history must never leak into the child — orphan the tree.
      await rm(join(work, ".git"), { recursive: true, force: true });
      return await this.commitAndPush(
        work,
        dir.value,
        `instantiate from template ${tpl.owner}/${tpl.name}`,
        op,
      );
    } catch (cause) {
      return Result.err(new GitError({ message: String(cause), op }));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async seedRepoFromDir(
    owner: string,
    name: string,
    dir: string,
    message = "seed",
  ): Promise<Result<void, GitError>> {
    const op = "seedRepoFromDir";
    const target = this.dir(op, owner, name);
    if (target.status === "error") return target as Result<never, GitError>;
    const init = await this.initBareRepo(owner, name);
    if (init.status === "error") return init;
    const tmp = await mkdtemp(join(tmpdir(), "op-seed-"));
    try {
      // Copy so the caller's directory is never mutated (no .git left behind).
      const work = join(tmp, "work");
      await cp(dir, work, { recursive: true });
      return await this.commitAndPush(work, target.value, message, op);
    } catch (cause) {
      return Result.err(new GitError({ message: String(cause), op }));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async commitAndPush(
    work: string,
    targetBareDir: string,
    message: string,
    op: string,
  ): Promise<Result<void, GitError>> {
    const steps: string[][] = [
      ["init", "-b", "main"],
      ["add", "-A"],
      [...AUTHOR_FLAGS, "commit", "-m", message, "--author=op <op@platform>"],
      ["push", targetBareDir, "main:main"],
    ];
    for (const args of steps) {
      const r = await this.git(op, args, { cwd: work });
      if (r.status === "error") return r as Result<never, GitError>;
    }
    return Result.ok(undefined);
  }

  async bundle(
    owner: string,
    name: string,
    outFile: string,
  ): Promise<Result<void, GitError>> {
    const dir = this.dir("bundle", owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    if (!existsSync(dir.value)) {
      return Result.err(
        new GitError({
          message: `repo not found: ${owner}/${name}`,
          op: "bundle",
        }),
      );
    }
    const out = resolve(outFile);
    try {
      await mkdir(dirname(out), { recursive: true });
    } catch (cause) {
      return Result.err(new GitError({ message: String(cause), op: "bundle" }));
    }
    const r = await this.git("bundle", ["bundle", "create", out, "--all"], {
      cwd: dir.value,
    });
    return r.map(() => undefined);
  }

  async restoreFromBundle(
    bundleFile: string,
    owner: string,
    name: string,
  ): Promise<Result<void, GitError>> {
    const op = "restoreFromBundle";
    const dir = this.dir(op, owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    if (existsSync(dir.value)) {
      return Result.err(
        new GitError({ message: `repo already exists: ${owner}/${name}`, op }),
      );
    }
    try {
      await mkdir(dirname(dir.value), { recursive: true });
    } catch (cause) {
      return Result.err(new GitError({ message: String(cause), op }));
    }
    const clone = await this.git(op, [
      "clone",
      "--bare",
      resolve(bundleFile),
      dir.value,
    ]);
    if (clone.status === "error") return clone as Result<never, GitError>;
    const head = await this.git(
      op,
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      {
        cwd: dir.value,
      },
    );
    return head.map(() => undefined);
  }

  /**
   * Import an EXTERNAL repo (e.g. a public GitHub URL) into the host as a fresh
   * bare repo owned by owner/name. Hardened: only http(s)/git(+ssh) URLs, a
   * hard wall-clock cap, single-branch shallow-ish history to bound size, and
   * the repo's default branch renamed to `main` so the reconciler + preview
   * pipeline treat it like any platform repo. The clone runs with terminal
   * prompts disabled, so a private/auth-required URL fails fast rather than
   * hanging. History is REWRITTEN to a single orphan-free import (kept as-is:
   * the app's own history is legitimately theirs, unlike a template).
   */
  async cloneFromRemote(
    url: string,
    owner: string,
    name: string,
    opts: { timeoutMs?: number; depth?: number; allowLocal?: boolean } = {},
  ): Promise<Result<void, GitError>> {
    const op = "cloneFromRemote";
    const dir = this.dir(op, owner, name);
    if (dir.status === "error") return dir as Result<never, GitError>;
    if (existsSync(dir.value))
      return Result.err(
        new GitError({ message: `repo already exists: ${owner}/${name}`, op }),
      );
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Result.err(new GitError({ message: `invalid URL: ${url}`, op }));
    }
    // Production accepts only network transports — never `file:`, which would
    // let a member clone any git repo on the host. Tests opt into local repos.
    const schemes = opts.allowLocal
      ? ["https:", "http:", "git:", "file:"]
      : ["https:", "http:", "git:"];
    if (!schemes.includes(parsed.protocol))
      return Result.err(
        new GitError({
          message: `unsupported scheme '${parsed.protocol}' (use https)`,
          op,
        }),
      );
    try {
      await mkdir(dirname(dir.value), { recursive: true });
    } catch (cause) {
      return Result.err(new GitError({ message: String(cause), op }));
    }

    const timeoutMs = opts.timeoutMs ?? 120_000;
    const depth = opts.depth ?? 0; // 0 = full history (a real app needs it)
    const args = [
      "clone",
      "--bare",
      "--single-branch",
      ...(depth > 0 ? ["--depth", String(depth)] : []),
      parsed.toString(),
      dir.value,
    ];
    const clone = await this.gitWithTimeout(op, args, timeoutMs);
    if (clone.status === "error") {
      // Leave no half-written bare repo behind on failure.
      await rm(dir.value, { recursive: true, force: true }).catch(() => {});
      return clone as Result<never, GitError>;
    }
    // Normalize the default branch to main so downstream (specs, previews,
    // crew branches off origin/main) is uniform regardless of the source repo.
    const branch = await this.git(op, ["symbolic-ref", "--short", "HEAD"], {
      cwd: dir.value,
    });
    const current =
      branch.status === "ok"
        ? new TextDecoder().decode(branch.value).trim()
        : "";
    if (current && current !== "main") {
      await this.git(op, ["branch", "-m", current, "main"], {
        cwd: dir.value,
      });
    }
    const head = await this.git(
      op,
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      { cwd: dir.value },
    );
    return head.map(() => undefined);
  }

  // A git subprocess with a hard wall-clock kill — a hostile/slow remote must
  // never hang the daemon. Mirrors git() but adds a timeout abort.
  private async gitWithTimeout(
    op: string,
    args: string[],
    timeoutMs: number,
  ): Promise<Result<Uint8Array, GitError>> {
    try {
      const proc = Bun.spawn(["git", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: GIT_ENV,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
      try {
        const [stdout, stderrBytes, code] = await Promise.all([
          collect(proc.stdout as ReadableStream<Uint8Array>),
          collect(proc.stderr as ReadableStream<Uint8Array>),
          proc.exited,
        ]);
        const stderr = new TextDecoder().decode(stderrBytes);
        if (timedOut)
          return Result.err(
            new GitError({
              message: `clone exceeded ${Math.round(timeoutMs / 1000)}s and was killed`,
              op,
            }),
          );
        if (code !== 0)
          return Result.err(
            new GitError({
              message: `git clone exited ${code}: ${stderr.trim()}`,
              op,
            }),
          );
        return Result.ok(stdout);
      } finally {
        clearTimeout(timer);
      }
    } catch (cause) {
      return Result.err(new GitError({ message: String(cause), op }));
    }
  }
}
