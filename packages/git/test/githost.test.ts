import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";

// many real git subprocesses per test — generous margin for loaded machines
setDefaultTimeout(60_000);
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath, Result, stateDir, type StateDir } from "@op/core";
import { GitHost, type PushEvent } from "@op/git";

let tmpRoots: string[] = [];
function freshHost(): { sd: StateDir; host: GitHost } {
  const root = mkdtempSync(join(tmpdir(), "op-githost-"));
  tmpRoots.push(root);
  const sd = stateDir(root);
  return { sd, host: new GitHost(sd) };
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "op-githost-scratch-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots = [];
});

const GIT_TEST_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function sh(
  cwd: string,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: GIT_TEST_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function seedSource(files: Record<string, string>): string {
  const dir = scratch();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("initBareRepo", () => {
  test("creates a bare repo with main HEAD, idempotently", async () => {
    const { sd, host } = freshHost();
    Result.unwrap(await host.initBareRepo("ada", "app"));
    Result.unwrap(await host.initBareRepo("ada", "app"));
    const dir = repoPath(sd, "ada", "app");
    expect(existsSync(join(dir, "HEAD"))).toBe(true);
    const head = await sh(dir, ["git", "symbolic-ref", "HEAD"]);
    expect(head.out.trim()).toBe("refs/heads/main");
  });

  test("rejects invalid names as a value, not a panic", async () => {
    const { host } = freshHost();
    const r = await host.initBareRepo("../evil", "app");
    expect(r.status).toBe("error");
  });
});

describe("seed + reads", () => {
  test("seedRepoFromDir then headSha/listFiles/readFile", async () => {
    const { host } = freshHost();
    const src = seedSource({
      "README.md": "hello platform\n",
      "src/index.ts": "export const x = 1;\n",
    });
    Result.unwrap(await host.seedRepoFromDir("ada", "app", src, "genesis"));

    const sha = Result.unwrap(await host.headSha("ada", "app"));
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Result.unwrap(await host.headSha("ada", "app", "main"))).toBe(sha);

    const files = Result.unwrap(await host.listFiles("ada", "app", "HEAD"));
    expect(files.sort()).toEqual(["README.md", "src/index.ts"]);

    const bytes = Result.unwrap(
      await host.readFile("ada", "app", "HEAD", "README.md"),
    );
    expect(new TextDecoder().decode(bytes)).toBe("hello platform\n");

    // the source dir is not mutated
    expect(existsSync(join(src, ".git"))).toBe(false);
  });

  test("reads fail as values on missing ref/path/repo", async () => {
    const { host } = freshHost();
    Result.unwrap(await host.initBareRepo("ada", "empty"));
    expect((await host.headSha("ada", "empty")).status).toBe("error");
    expect((await host.listFiles("ada", "empty", "HEAD")).status).toBe("error");
    expect((await host.readFile("ada", "nope", "HEAD", "x")).status).toBe(
      "error",
    );
    expect((await host.headSha("ada", "empty", "--help")).status).toBe("error");
  });
});

describe("createFromTemplate", () => {
  test("fresh single-commit history; template history never leaks", async () => {
    const { sd, host } = freshHost();
    const src = seedSource({ "app.ts": "v1\n" });
    Result.unwrap(await host.seedRepoFromDir("ada", "tpl", src, "tpl v1"));

    // grow the template to 2 commits so leak detection is meaningful
    const work = join(scratch(), "w");
    await sh(".", ["git", "clone", repoPath(sd, "ada", "tpl"), work]);
    writeFileSync(join(work, "app.ts"), "v2\n");
    await sh(work, [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-am",
      "v2",
    ]);
    await sh(work, ["git", "push", "origin", "main"]);
    const tplLog = await sh(repoPath(sd, "ada", "tpl"), [
      "git",
      "rev-list",
      "--count",
      "HEAD",
    ]);
    expect(tplLog.out.trim()).toBe("2");

    Result.unwrap(
      await host.createFromTemplate(
        { owner: "ada", name: "tpl" },
        "bob",
        "child",
      ),
    );

    const childDir = repoPath(sd, "bob", "child");
    const count = await sh(childDir, ["git", "rev-list", "--count", "HEAD"]);
    expect(count.out.trim()).toBe("1");
    const content = Result.unwrap(
      await host.readFile("bob", "child", "HEAD", "app.ts"),
    );
    expect(new TextDecoder().decode(content)).toBe("v2\n");
    const tplSha = Result.unwrap(await host.headSha("ada", "tpl"));
    const childSha = Result.unwrap(await host.headSha("bob", "child"));
    expect(childSha).not.toBe(tplSha);
  });

  test("missing template is an error value", async () => {
    const { host } = freshHost();
    const r = await host.createFromTemplate(
      { owner: "no", name: "pe" },
      "ada",
      "x",
    );
    expect(r.status).toBe("error");
  });
});

describe("bundle / restore", () => {
  test("roundtrip preserves head and content", async () => {
    const { host } = freshHost();
    const src = seedSource({ "data.txt": "precious\n" });
    Result.unwrap(await host.seedRepoFromDir("ada", "app", src));
    const sha = Result.unwrap(await host.headSha("ada", "app"));

    const out = join(scratch(), "app.bundle");
    Result.unwrap(await host.bundle("ada", "app", out));
    expect(existsSync(out)).toBe(true);

    Result.unwrap(await host.restoreFromBundle(out, "eve", "restored"));
    expect(Result.unwrap(await host.headSha("eve", "restored"))).toBe(sha);
    const bytes = Result.unwrap(
      await host.readFile("eve", "restored", "HEAD", "data.txt"),
    );
    expect(new TextDecoder().decode(bytes)).toBe("precious\n");
  });

  test("restore refuses to clobber an existing repo", async () => {
    const { host } = freshHost();
    const src = seedSource({ "a.txt": "a\n" });
    Result.unwrap(await host.seedRepoFromDir("ada", "app", src));
    const out = join(scratch(), "app.bundle");
    Result.unwrap(await host.bundle("ada", "app", out));
    expect((await host.restoreFromBundle(out, "ada", "app")).status).toBe(
      "error",
    );
  });
});

describe("cloneFromRemote", () => {
  // Build a real external repo (default branch "trunk") we can clone via file://
  async function makeRemote(): Promise<string> {
    const work = scratch();
    await sh(work, ["git", "init", "-q", "-b", "trunk"]);
    writeFileSync(join(work, "index.js"), "console.log('hi')\n");
    await sh(work, ["git", "add", "-A"]);
    await sh(work, [
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    return work;
  }

  test("imports an external repo and normalizes the default branch to main", async () => {
    const { host } = freshHost();
    const remote = await makeRemote();
    Result.unwrap(
      await host.cloneFromRemote(`file://${remote}`, "ada", "imported", {
        allowLocal: true,
      }),
    );
    const head = Result.unwrap(await host.headSha("ada", "imported"));
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const bytes = Result.unwrap(
      await host.readFile("ada", "imported", "main", "index.js"),
    );
    expect(new TextDecoder().decode(bytes)).toContain("hi");
  });

  test("rejects non-network schemes in production (no allowLocal)", async () => {
    const { host } = freshHost();
    const remote = await makeRemote();
    const r = await host.cloneFromRemote(`file://${remote}`, "ada", "x");
    expect(r.status).toBe("error");
  });

  test("rejects a bogus URL and refuses to clobber", async () => {
    const { host } = freshHost();
    const remote = await makeRemote();
    expect((await host.cloneFromRemote("not a url", "ada", "y")).status).toBe(
      "error",
    );
    Result.unwrap(
      await host.cloneFromRemote(`file://${remote}`, "ada", "z", {
        allowLocal: true,
      }),
    );
    expect(
      (
        await host.cloneFromRemote(`file://${remote}`, "ada", "z", {
          allowLocal: true,
        })
      ).status,
    ).toBe("error"); // already exists
  });
});

describe("handleSmartHttp", () => {
  const RW = { read: true, write: true };

  function pkt(payload: string): string {
    return (payload.length + 4).toString(16).padStart(4, "0") + payload;
  }

  test("GET info/refs advertises with service header pkt-line", async () => {
    const { host } = freshHost();
    const src = seedSource({ "f.txt": "x\n" });
    Result.unwrap(await host.seedRepoFromDir("ada", "app", src));

    const req = new Request(
      "http://op/ada/app.git/info/refs?service=git-upload-pack",
    );
    const res = await host.handleSmartHttp(req, "ada", "app", RW);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/x-git-upload-pack-advertisement",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const text = await res.text();
    expect(text.startsWith("001e# service=git-upload-pack\n0000")).toBe(true);
    expect(text).toContain("refs/heads/main");
  });

  test("info/refs without a smart service is 400; unknown repo 404", async () => {
    const { host } = freshHost();
    Result.unwrap(await host.initBareRepo("ada", "app"));
    const dumb = await host.handleSmartHttp(
      new Request("http://op/ada/app.git/info/refs"),
      "ada",
      "app",
      RW,
    );
    expect(dumb.status).toBe(400);
    const missing = await host.handleSmartHttp(
      new Request("http://op/x/y.git/info/refs?service=git-upload-pack"),
      "x",
      "y",
      RW,
    );
    expect(missing.status).toBe(404);
  });

  test("perms gate: read gates upload-pack, write gates receive-pack", async () => {
    const { host } = freshHost();
    Result.unwrap(await host.initBareRepo("ada", "app"));
    const up = await host.handleSmartHttp(
      new Request("http://op/ada/app.git/info/refs?service=git-upload-pack"),
      "ada",
      "app",
      { read: false, write: true },
    );
    expect(up.status).toBe(403);
    const rp = await host.handleSmartHttp(
      new Request("http://op/ada/app.git/info/refs?service=git-receive-pack"),
      "ada",
      "app",
      { read: true, write: false },
    );
    expect(rp.status).toBe(403);
    const post = await host.handleSmartHttp(
      new Request("http://op/ada/app.git/git-receive-pack", {
        method: "POST",
        body: "0000",
      }),
      "ada",
      "app",
      { read: true, write: false },
    );
    expect(post.status).toBe(403);
  });

  test("POST upload-pack serves a pack; gzip request bodies are decoded", async () => {
    const { host } = freshHost();
    const src = seedSource({ "f.txt": "x\n" });
    Result.unwrap(await host.seedRepoFromDir("ada", "app", src));
    const sha = Result.unwrap(await host.headSha("ada", "app"));

    // protocol v0 fetch: want, flush, done → NAK + packfile
    const negotiation = pkt(`want ${sha}\n`) + "0000" + pkt("done\n");

    for (const gzip of [false, true]) {
      const raw = new TextEncoder().encode(negotiation);
      const res = await host.handleSmartHttp(
        new Request("http://op/ada/app.git/git-upload-pack", {
          method: "POST",
          headers: gzip ? { "content-encoding": "gzip" } : {},
          body: gzip ? Bun.gzipSync(raw) : raw,
        }),
        "ada",
        "app",
        RW,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/x-git-upload-pack-result",
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder("latin1").decode(bytes);
      expect(text.startsWith("0008NAK\n")).toBe(true);
      expect(text).toContain("PACK");
    }
  });

  test("corrupt gzip body is a 400, not a crash", async () => {
    const { host } = freshHost();
    Result.unwrap(await host.initBareRepo("ada", "app"));
    const res = await host.handleSmartHttp(
      new Request("http://op/ada/app.git/git-upload-pack", {
        method: "POST",
        headers: { "content-encoding": "gzip" },
        body: new Uint8Array([1, 2, 3]),
      }),
      "ada",
      "app",
      RW,
    );
    expect(res.status).toBe(400);
  });

  test("push event fires after receive-pack exits 0", async () => {
    const { sd, host } = freshHost();
    Result.unwrap(await host.initBareRepo("ada", "app"));
    const events: PushEvent[] = [];
    host.onPush((e) => events.push(e));

    // real push via the git CLI straight at the bare dir is not receive-pack
    // over HTTP — drive the handler with git http-backend-shaped requests via
    // a local server.
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        host.handleSmartHttp(req, "ada", "app", { read: true, write: true }),
    });
    try {
      const work = join(scratch(), "w");
      mkdirSync(work, { recursive: true });
      await sh(work, ["git", "init", "-b", "main"]);
      writeFileSync(join(work, "f.txt"), "pushed\n");
      await sh(work, ["git", "add", "-A"]);
      await sh(work, [
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-m",
        "c1",
      ]);
      const push = await sh(work, [
        "git",
        "push",
        `http://127.0.0.1:${server.port}/ada/app.git`,
        "main:main",
      ]);
      expect(push.code).toBe(0);
      const deadline = Date.now() + 2000;
      while (events.length === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(events).toEqual([{ owner: "ada", name: "app" }]);
      const sha = await sh(repoPath(sd, "ada", "app"), [
        "git",
        "rev-parse",
        "HEAD",
      ]);
      expect(sha.code).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("mergeBranch is silent; firePushEvent announces the merge (after caller bookkeeping)", async () => {
    // Console merges land via a local-path push, bypassing receive-pack — the
    // event must fire anyway, or a merged plat/platform change never
    // hot-reloads and a merged plat/opd change never self-upgrades. But NOT
    // from inside mergeBranch: a plat/opd subscriber stops the daemon, so the
    // forge fires it only after its ledger writes are durable.
    const { sd, host } = freshHost();
    const src = join(scratch(), "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "f.txt"), "v1\n");
    Result.unwrap(await host.initBareRepo("ada", "app"));
    Result.unwrap(await host.seedRepoFromDir("ada", "app", src, "init"));

    // A feature branch in the bare repo, made the boring way: clone → commit
    // → push (local path — deliberately NOT the event-emitting HTTP path).
    const work = join(scratch(), "w");
    await sh(scratch(), ["git", "clone", repoPath(sd, "ada", "app"), work]);
    await sh(work, ["git", "checkout", "-b", "feature"]);
    writeFileSync(join(work, "f.txt"), "v2\n");
    await sh(work, ["git", "add", "-A"]);
    await sh(work, [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-m",
      "change",
    ]);
    await sh(work, ["git", "push", "-q", "origin", "feature:feature"]);

    const events: PushEvent[] = [];
    host.onPush((e) => events.push(e));
    Result.unwrap(
      await host.mergeBranch("ada", "app", "main", "feature", "merge it"),
    );
    expect(events).toEqual([]); // silent — the caller announces when ready
    host.firePushEvent("ada", "app");
    expect(events).toEqual([{ owner: "ada", name: "app" }]);
  });

  test("isAncestor: merged branch reads true, unmerged false, garbage false", async () => {
    const { sd, host } = freshHost();
    const src = join(scratch(), "asrc");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "f.txt"), "v1\n");
    Result.unwrap(await host.initBareRepo("ada", "anc"));
    Result.unwrap(await host.seedRepoFromDir("ada", "anc", src, "init"));
    const work = join(scratch(), "aw");
    await sh(scratch(), ["git", "clone", repoPath(sd, "ada", "anc"), work]);
    await sh(work, ["git", "checkout", "-b", "feature"]);
    writeFileSync(join(work, "f.txt"), "v2\n");
    await sh(work, ["git", "add", "-A"]);
    await sh(work, [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-m",
      "c",
    ]);
    await sh(work, ["git", "push", "-q", "origin", "feature:feature"]);

    expect(await host.isAncestor("ada", "anc", "feature", "main")).toBe(false);
    Result.unwrap(await host.mergeBranch("ada", "anc", "main", "feature", "m"));
    expect(await host.isAncestor("ada", "anc", "feature", "main")).toBe(true);
    expect(await host.isAncestor("ada", "anc", "no-such-ref", "main")).toBe(
      false,
    );
    expect(
      await host.isAncestor("ada", "missing-repo", "feature", "main"),
    ).toBe(false);
  });
});
