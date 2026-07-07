import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, repoPath, Result, stateDir, type StateDir } from "@op/core";
import { GitHost } from "@op/git";
import { Store } from "@op/store";
import { Forge } from "../src/forge.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await p.exited) !== 0)
    throw new Error(
      `git ${args.join(" ")}: ${await new Response(p.stderr).text()}`,
    );
}

// Push a feature branch to the bare repo with one changed file.
async function pushBranch(
  sd: StateDir,
  owner: string,
  repo: string,
  branch: string,
  file: string,
) {
  const work = await mkdtemp(join(tmpdir(), "op-pr-"));
  dirs.push(work);
  const bare = repoPath(sd, owner, repo);
  await git(work, "clone", bare, "w");
  const w = join(work, "w");
  await git(w, "checkout", "-b", branch);
  await writeFile(join(w, file), `change on ${branch}\n`);
  await git(w, "add", "-A");
  await git(
    w,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    `add ${file}`,
  );
  await git(w, "push", "origin", `${branch}:${branch}`);
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "op-pr-h-"));
  dirs.push(dir);
  const sd = stateDir(dir);
  const store = new Store(sd.dbFile);
  const gitHost = new GitHost(sd, { log: createLog("t") });
  const forge = new Forge(store, gitHost);
  const ada = Result.unwrap(
    await forge.createUser("ada", "pw-123456", { admin: false }),
  );
  const bob = Result.unwrap(await forge.createUser("bob", "pw-123456"));
  // ada owns a repo with an initial commit on main.
  const seed = await mkdtemp(join(tmpdir(), "op-pr-seed-"));
  dirs.push(seed);
  await writeFile(join(seed, "README.md"), "# app\n");
  Result.unwrap(await forge.createRepo(ada, "ada", "app"));
  Result.unwrap(await gitHost.seedRepoFromDir("ada", "app", seed, "init"));
  return { sd, store, gitHost, forge, ada, bob };
}

describe("pull requests", () => {
  test("create → diff → merge lands the change on base", async () => {
    const h = await harness();
    await pushBranch(h.sd, "ada", "app", "feat", "FEATURE.md");

    const pr = Result.unwrap(
      await h.forge.createPr(h.ada, "ada", "app", {
        title: "add feature",
        head: "feat",
      }),
    );
    expect(pr.number).toBe(1);
    expect(pr.base_ref).toBe("main");
    expect(pr.state).toBe("open");

    const diff = Result.unwrap(
      await h.gitHost.diffStat("ada", "app", "main", "feat"),
    );
    expect(diff.files).toContain("FEATURE.md");

    // Not on main yet.
    expect(
      (await h.gitHost.readFile("ada", "app", "main", "FEATURE.md")).status,
    ).toBe("error");

    const merged = Result.unwrap(await h.forge.mergePr(h.ada, "ada", "app", 1));
    expect(merged.state).toBe("merged");
    // Now it is.
    expect(
      (await h.gitHost.readFile("ada", "app", "main", "FEATURE.md")).status,
    ).toBe("ok");
    // A merged PR can't be merged again.
    expect((await h.forge.mergePr(h.ada, "ada", "app", 1)).status).toBe(
      "error",
    );
  });

  test("PR numbers increment per repo", async () => {
    const h = await harness();
    await pushBranch(h.sd, "ada", "app", "a", "A.md");
    await pushBranch(h.sd, "ada", "app", "b", "B.md");
    const p1 = Result.unwrap(
      await h.forge.createPr(h.ada, "ada", "app", { title: "a", head: "a" }),
    );
    const p2 = Result.unwrap(
      await h.forge.createPr(h.ada, "ada", "app", { title: "b", head: "b" }),
    );
    expect([p1.number, p2.number]).toEqual([1, 2]);
    expect(h.store.listPrs("ada", "app", "open").length).toBe(2);
  });

  test("fails closed on bad input and unauthorized actors", async () => {
    const h = await harness();
    await pushBranch(h.sd, "ada", "app", "feat", "F.md");
    // non-owner, non-admin can't open a PR
    expect(
      (
        await h.forge.createPr(h.bob, "ada", "app", {
          title: "x",
          head: "feat",
        })
      ).status,
    ).toBe("error");
    // nonexistent branch
    expect(
      (
        await h.forge.createPr(h.ada, "ada", "app", {
          title: "x",
          head: "ghost",
        })
      ).status,
    ).toBe("error");
    // head == base
    expect(
      (
        await h.forge.createPr(h.ada, "ada", "app", {
          title: "x",
          head: "main",
        })
      ).status,
    ).toBe("error");
    // bob can't merge ada's PR
    const pr = Result.unwrap(
      await h.forge.createPr(h.ada, "ada", "app", {
        title: "ok",
        head: "feat",
      }),
    );
    expect((await h.forge.mergePr(h.bob, "ada", "app", pr.number)).status).toBe(
      "error",
    );
  });

  test("close moves a PR out of open", async () => {
    const h = await harness();
    await pushBranch(h.sd, "ada", "app", "feat", "F.md");
    const pr = Result.unwrap(
      await h.forge.createPr(h.ada, "ada", "app", { title: "x", head: "feat" }),
    );
    expect(
      Result.unwrap(h.forge.closePr(h.ada, "ada", "app", pr.number)),
    ).toBeUndefined();
    expect(h.store.listPrs("ada", "app", "open").length).toBe(0);
    expect(h.store.getPr("ada", "app", pr.number)?.state).toBe("closed");
  });
});
