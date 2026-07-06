import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";

// argon2 hashing + git subprocesses per test — margin for loaded machines
setDefaultTimeout(60_000);
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath, Result, stateDir, type StateDir } from "@op/core";
import { Forge } from "@op/forge";
import { GitHost } from "@op/git";
import { Store, type UserRow } from "@op/store";

let tmpRoots: string[] = [];
function fresh(): { sd: StateDir; forge: Forge } {
  const root = mkdtempSync(join(tmpdir(), "op-forge-"));
  tmpRoots.push(root);
  const sd = stateDir(root);
  return { sd, forge: new Forge(new Store(sd.dbFile), new GitHost(sd)) };
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots = [];
});

function basic(user: string, secret: string): Request {
  return new Request("http://op/", {
    headers: { authorization: `Basic ${btoa(`${user}:${secret}`)}` },
  });
}

describe("users + passwords", () => {
  test("createUser hashes with argon2id; verifyPassword roundtrips", async () => {
    const { forge } = fresh();
    const user = Result.unwrap(await forge.createUser("ada", "hunter2"));
    expect(user.username).toBe("ada");
    expect(user.password_hash).toStartWith("$argon2id$");
    expect((await forge.verifyPassword("ada", "hunter2"))?.id).toBe(user.id);
    expect(await forge.verifyPassword("ada", "wrong")).toBeNull();
    expect(await forge.verifyPassword("ghost", "hunter2")).toBeNull();
  });

  test("duplicate username → conflict; invalid name/empty password → invalid", async () => {
    const { forge } = fresh();
    Result.unwrap(await forge.createUser("ada", "pw"));
    const dup = await forge.createUser("ada", "pw2");
    expect(dup.status === "error" && dup.error.code).toBe("conflict");
    const bad = await forge.createUser("Not Valid!", "pw");
    expect(bad.status === "error" && bad.error.code).toBe("invalid");
    const empty = await forge.createUser("bob", "");
    expect(empty.status === "error" && empty.error.code).toBe("invalid");
  });
});

describe("authenticate", () => {
  async function seeded(): Promise<{
    forge: Forge;
    user: UserRow;
    pat: string;
  }> {
    const { forge } = fresh();
    const user = Result.unwrap(await forge.createUser("ada", "hunter2"));
    const pat = Result.unwrap(await forge.createPat(user.id, "ci")).token;
    return { forge, user, pat };
  }

  test("PAT is returned once, prefixed, and never stored in plaintext", async () => {
    const { forge, pat } = await seeded();
    expect(pat).toStartWith("op_pat_");
    const stored = forge.store.db
      .query<{ token_hash: string }, []>("SELECT token_hash FROM tokens")
      .all();
    expect(stored.length).toBe(1);
    expect(stored[0]!.token_hash).not.toContain(pat);
  });

  test("Basic user:pat", async () => {
    const { forge, user, pat } = await seeded();
    expect((await forge.authenticate(basic("ada", pat)))?.id).toBe(user.id);
  });

  test("Basic user:password", async () => {
    const { forge, user } = await seeded();
    expect((await forge.authenticate(basic("ada", "hunter2")))?.id).toBe(
      user.id,
    );
  });

  test("Bearer pat", async () => {
    const { forge, user, pat } = await seeded();
    const req = new Request("http://op/", {
      headers: { authorization: `Bearer ${pat}` },
    });
    expect((await forge.authenticate(req))?.id).toBe(user.id);
  });

  test("op_session cookie", async () => {
    const { forge, user } = await seeded();
    const session = forge.createSession(user.id);
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    const req = new Request("http://op/", {
      headers: { cookie: `theme=dark; op_session=${session.id}` },
    });
    expect((await forge.authenticate(req))?.id).toBe(user.id);
  });

  test("bad credentials → null", async () => {
    const { forge, pat } = await seeded();
    expect(await forge.authenticate(basic("ada", "nope"))).toBeNull();
    expect(await forge.authenticate(basic("bob", pat))).toBeNull(); // pat under wrong username
    expect(
      await forge.authenticate(
        new Request("http://op/", {
          headers: { authorization: "Bearer op_pat_bogus" },
        }),
      ),
    ).toBeNull();
    expect(
      await forge.authenticate(
        new Request("http://op/", {
          headers: { authorization: "Basic %%%not-b64%%%" },
        }),
      ),
    ).toBeNull();
    expect(
      await forge.authenticate(
        new Request("http://op/", {
          headers: { cookie: "op_session=ses_bogus" },
        }),
      ),
    ).toBeNull();
    expect(await forge.authenticate(new Request("http://op/"))).toBeNull();
  });
});

describe("authorize (fail-closed)", () => {
  test("matrix", async () => {
    const { forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    const bob = Result.unwrap(await forge.createUser("bob", "pw"));
    const root = Result.unwrap(
      await forge.createUser("root", "pw", { admin: true }),
    );
    Result.unwrap(await forge.createRepo(ada, "ada", "app"));

    // unknown repo: false for everyone, even reads, even admin
    expect(forge.authorize(null, "ada", "ghost", "read")).toBe(false);
    expect(forge.authorize(root, "ada", "ghost", "write")).toBe(false);

    // known repo: public read
    expect(forge.authorize(null, "ada", "app", "read")).toBe(true);
    expect(forge.authorize(bob, "ada", "app", "read")).toBe(true);

    // write: owner or admin only
    expect(forge.authorize(null, "ada", "app", "write")).toBe(false);
    expect(forge.authorize(bob, "ada", "app", "write")).toBe(false);
    expect(forge.authorize(ada, "ada", "app", "write")).toBe(true);
    expect(forge.authorize(root, "ada", "app", "write")).toBe(true);
  });
});

describe("repos", () => {
  test("createRepo writes row + bare repo; duplicate → conflict", async () => {
    const { sd, forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    const row = Result.unwrap(await forge.createRepo(ada, "ada", "app"));
    expect(row.default_branch).toBe("main");
    expect(existsSync(join(repoPath(sd, "ada", "app"), "HEAD"))).toBe(true);

    const dup = await forge.createRepo(ada, "ada", "app");
    expect(dup.status === "error" && dup.error.code).toBe("conflict");
    const bad = await forge.createRepo(ada, "ada", "Bad Name");
    expect(bad.status === "error" && bad.error.code).toBe("invalid");
  });

  test("non-admin cannot create under another owner; admin can", async () => {
    const { forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    const root = Result.unwrap(
      await forge.createUser("root", "pw", { admin: true }),
    );
    const denied = await forge.createRepo(ada, "root", "x");
    expect(denied.status === "error" && denied.error.code).toBe("unauthorized");
    expect((await forge.createRepo(root, "ada", "granted")).status).toBe("ok");
  });

  test("createFromTemplate requires an existing template repo", async () => {
    const { forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    const missing = await forge.createFromTemplate(
      ada,
      { owner: "x", name: "y" },
      "child",
    );
    expect(missing.status === "error" && missing.error.code).toBe("not_found");

    Result.unwrap(await forge.createRepo(ada, "ada", "plain"));
    const notTpl = await forge.createFromTemplate(
      ada,
      { owner: "ada", name: "plain" },
      "child",
    );
    expect(notTpl.status === "error" && notTpl.error.code).toBe("invalid");
  });
});
