// The M1 proof: a REAL `git` CLI speaking smart HTTP to forgeRouter on a live
// Bun.serve — clone/push/fetch/force-push/authz, template instantiation, and
// the push event, end to end.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

// real git CLI over live HTTP — generous margin for loaded machines
setDefaultTimeout(60_000);
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, stateDir } from "@op/core";
import { Forge, forgeRouter } from "@op/forge";
import { GitHost, type PushEvent } from "@op/git";
import { Store } from "@op/store";

let tmpRoots: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

const sd = stateDir(scratch("op-conf-state-"));
const git = new GitHost(sd);
const forge = new Forge(new Store(sd.dbFile), git);
const router = forgeRouter(forge, git);
const pushEvents: PushEvent[] = [];
git.onPush((e) => pushEvents.push(e));

const server = Bun.serve({
  port: 0,
  fetch: async (req) =>
    (await router(req)) ?? new Response("no route", { status: 404 }),
});
const base = `http://127.0.0.1:${server.port}`;

// Isolate the git CLI from the operator's config (signing, helpers, prompts).
const gitConfig = join(scratch("op-conf-gitcfg-"), "gitconfig");
writeFileSync(
  gitConfig,
  "[init]\n\tdefaultBranch = main\n[user]\n\tname = tester\n\temail = tester@example.com\n[commit]\n\tgpgsign = false\n",
);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function sh(
  cwd: string,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: GIT_ENV,
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

async function mustSh(cwd: string, argv: string[]): Promise<string> {
  const r = await sh(cwd, argv);
  if (r.code !== 0) throw new Error(`${argv.join(" ")} failed: ${r.err}`);
  return r.out;
}

async function api(
  path: string,
  init?: RequestInit,
): Promise<{
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

let adaPat = "";
let bobPat = "";

afterAll(() => {
  server.stop(true);
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots = [];
});

beforeAll(async () => {
  // first boot: unauthenticated user creation mints the admin
  const first = await api("/api/v1/users", {
    method: "POST",
    body: JSON.stringify({ username: "ada", password: "ada-pw" }),
  });
  expect(first.status).toBe(201);
  expect(first.body["is_admin"]).toBe(1);
  expect(first.body["password_hash"]).toBeUndefined();

  // after first boot, anonymous user creation is refused
  const anon = await api("/api/v1/users", {
    method: "POST",
    body: JSON.stringify({ username: "eve", password: "x" }),
  });
  expect(anon.status).toBe(401);
  expect(anon.headers.get("www-authenticate")).toBe('Basic realm="op"');

  // admin creates bob (password basic auth), both mint PATs
  const adaBasic = `Basic ${btoa("ada:ada-pw")}`;
  const bob = await api("/api/v1/users", {
    method: "POST",
    headers: { authorization: adaBasic },
    body: JSON.stringify({ username: "bob", password: "bob-pw" }),
  });
  expect(bob.status).toBe(201);
  expect(bob.body["is_admin"]).toBe(0);

  const adaTok = await api("/api/v1/users/ada/tokens", {
    method: "POST",
    headers: { authorization: adaBasic },
    body: JSON.stringify({ name: "ci" }),
  });
  expect(adaTok.status).toBe(201);
  adaPat = adaTok.body["token"] as string;
  expect(adaPat).toStartWith("op_pat_");

  const bobTok = await api("/api/v1/users/bob/tokens", {
    method: "POST",
    headers: { authorization: `Basic ${btoa("bob:bob-pw")}` },
    body: JSON.stringify({ name: "ci" }),
  });
  bobPat = bobTok.body["token"] as string;

  // bob cannot mint tokens for ada
  const forbidden = await api("/api/v1/users/ada/tokens", {
    method: "POST",
    headers: { authorization: `Basic ${btoa("bob:bob-pw")}` },
    body: JSON.stringify({ name: "sneaky" }),
  });
  expect(forbidden.status).toBe(403);
});

describe("repo API", () => {
  test("create with Bearer PAT, fetch row, conflict on duplicate", async () => {
    const created = await api("/api/v1/repos", {
      method: "POST",
      headers: { authorization: `Bearer ${adaPat}` },
      body: JSON.stringify({ name: "app" }),
    });
    expect(created.status).toBe(201);
    expect(created.body["owner"]).toBe("ada");
    expect(created.body["default_branch"]).toBe("main");

    const got = await api("/api/v1/repos/ada/app");
    expect(got.status).toBe(200);
    expect(got.body["name"]).toBe("app");
    expect(await api("/api/v1/repos/ada/ghost").then((r) => r.status)).toBe(
      404,
    );

    const dup = await api("/api/v1/repos", {
      method: "POST",
      headers: { authorization: `Bearer ${adaPat}` },
      body: JSON.stringify({ name: "app" }),
    });
    expect(dup.status).toBe(409);

    const anon = await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "nope" }),
    });
    expect(anon.status).toBe(401);
  });

  test("non-forge routes return null → 404 passthrough", async () => {
    expect((await fetch(`${base}/definitely/not/a/route`)).status).toBe(404);
  });
});

describe("git conformance over smart HTTP", () => {
  const work = () => join(scratch("op-conf-work-"), "w");

  test("clone empty → commit → authed push → anonymous clone verifies content", async () => {
    const w1 = work();
    await mustSh(".", ["git", "clone", `${base}/ada/app.git`, w1]);

    writeFileSync(join(w1, "README.md"), "release 1\n");
    mkdirSync(join(w1, "src"), { recursive: true });
    writeFileSync(join(w1, "src", "main.ts"), "console.log(1);\n");
    await mustSh(w1, ["git", "add", "-A"]);
    await mustSh(w1, ["git", "commit", "-m", "c1"]);
    await mustSh(w1, [
      "git",
      "push",
      `http://ada:${adaPat}@127.0.0.1:${server.port}/ada/app.git`,
      "main",
    ]);

    const w2 = work();
    await mustSh(".", ["git", "clone", `${base}/ada/app.git`, w2]);
    expect(readFileSync(join(w2, "README.md"), "utf8")).toBe("release 1\n");
    expect(readFileSync(join(w2, "src", "main.ts"), "utf8")).toBe(
      "console.log(1);\n",
    );

    // server-side reads agree with the clone
    const sha = Result.unwrap(await git.headSha("ada", "app"));
    expect((await mustSh(w2, ["git", "rev-parse", "HEAD"])).trim()).toBe(sha);
  });

  test("push event fired with owner/name", () => {
    expect(pushEvents).toContainEqual({ owner: "ada", name: "app" });
  });

  test("fetch sees new commits; force-push rewrites history", async () => {
    const w1 = work();
    const authed = `http://ada:${adaPat}@127.0.0.1:${server.port}/ada/app.git`;
    await mustSh(".", ["git", "clone", authed, w1]);

    writeFileSync(join(w1, "README.md"), "release 2\n");
    await mustSh(w1, ["git", "commit", "-am", "c2"]);
    await mustSh(w1, ["git", "push", "origin", "main"]);

    // a stale clone fetches the new commit
    const w2 = work();
    await mustSh(".", ["git", "clone", `${base}/ada/app.git`, w2]);
    expect(
      (await mustSh(w2, ["git", "rev-list", "--count", "HEAD"])).trim(),
    ).toBe("2");

    // rewrite: amend + force push
    writeFileSync(join(w1, "README.md"), "release 2 (rewritten)\n");
    await mustSh(w1, ["git", "commit", "--amend", "-am", "c2-rewritten"]);
    const plain = await sh(w1, ["git", "push", "origin", "main"]);
    expect(plain.code).not.toBe(0); // non-fast-forward is refused
    await mustSh(w1, ["git", "push", "--force", "origin", "main"]);

    const w3 = work();
    await mustSh(".", ["git", "clone", `${base}/ada/app.git`, w3]);
    expect(readFileSync(join(w3, "README.md"), "utf8")).toBe(
      "release 2 (rewritten)\n",
    );
  });

  test("push without write perm fails; repo is untouched", async () => {
    const before = Result.unwrap(await git.headSha("ada", "app"));
    const w1 = work();
    await mustSh(".", ["git", "clone", `${base}/ada/app.git`, w1]);
    writeFileSync(join(w1, "evil.txt"), "muahaha\n");
    await mustSh(w1, ["git", "add", "-A"]);
    await mustSh(w1, ["git", "commit", "-m", "evil"]);

    // anonymous → 401 challenge
    const anon = await sh(w1, ["git", "push", "origin", "main"]);
    expect(anon.code).not.toBe(0);
    const challenge = await fetch(
      `${base}/ada/app.git/info/refs?service=git-receive-pack`,
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe('Basic realm="op"');

    // authenticated non-owner → 403
    const asBob = await sh(w1, [
      "git",
      "push",
      `http://bob:${bobPat}@127.0.0.1:${server.port}/ada/app.git`,
      "main",
    ]);
    expect(asBob.code).not.toBe(0);

    // bad credentials → still refused
    const badCreds = await sh(w1, [
      "git",
      "push",
      `http://ada:op_pat_wrong@127.0.0.1:${server.port}/ada/app.git`,
      "main",
    ]);
    expect(badCreds.code).not.toBe(0);

    expect(Result.unwrap(await git.headSha("ada", "app"))).toBe(before);
  });

  test("clone of a repo missing from the store is refused (fail-closed)", async () => {
    const w1 = work();
    const r = await sh(".", ["git", "clone", `${base}/ada/ghost.git`, w1]);
    expect(r.code).not.toBe(0);
  });

  test("template instantiation over the API → fresh single-commit history", async () => {
    const created = await api("/api/v1/repos", {
      method: "POST",
      headers: { authorization: `Bearer ${adaPat}` },
      body: JSON.stringify({ name: "tpl", isTemplate: true }),
    });
    expect(created.status).toBe(201);
    expect(created.body["is_template"]).toBe(1);

    // give the template two commits so leaked history would be visible
    const w1 = work();
    const authed = `http://ada:${adaPat}@127.0.0.1:${server.port}/ada/tpl.git`;
    await mustSh(".", ["git", "clone", authed, w1]);
    writeFileSync(join(w1, "app.ts"), "v1\n");
    await mustSh(w1, ["git", "add", "-A"]);
    await mustSh(w1, ["git", "commit", "-m", "v1"]);
    writeFileSync(join(w1, "app.ts"), "v2\n");
    await mustSh(w1, ["git", "commit", "-am", "v2"]);
    await mustSh(w1, ["git", "push", "origin", "main"]);

    // bob instantiates it — child lands under bob, not ada
    const child = await api("/api/v1/repos", {
      method: "POST",
      headers: { authorization: `Bearer ${bobPat}` },
      body: JSON.stringify({ name: "child", template: "ada/tpl" }),
    });
    expect(child.status).toBe(201);
    expect(child.body["owner"]).toBe("bob");

    const w2 = work();
    await mustSh(".", ["git", "clone", `${base}/bob/child.git`, w2]);
    expect(readFileSync(join(w2, "app.ts"), "utf8")).toBe("v2\n");
    expect(
      (await mustSh(w2, ["git", "rev-list", "--count", "HEAD"])).trim(),
    ).toBe("1");

    // template's commits are not reachable in the child
    const tplSha = Result.unwrap(await git.headSha("ada", "tpl"));
    const inChild = await sh(w2, ["git", "cat-file", "-e", tplSha]);
    expect(inChild.code).not.toBe(0);

    // instantiating from a non-template is refused
    const notTpl = await api("/api/v1/repos", {
      method: "POST",
      headers: { authorization: `Bearer ${bobPat}` },
      body: JSON.stringify({ name: "child2", template: "ada/app" }),
    });
    expect(notTpl.status).toBe(400);
  });
});
