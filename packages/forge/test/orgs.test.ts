import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";

// argon2 hashing + git subprocesses per test — margin for loaded machines
setDefaultTimeout(60_000);
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, stateDir, type StateDir } from "@op/core";
import { Forge } from "@op/forge";
import { GitHost } from "@op/git";
import { Store } from "@op/store";

let tmpRoots: string[] = [];
function fresh(): { sd: StateDir; forge: Forge } {
  const root = mkdtempSync(join(tmpdir(), "op-orgs-"));
  tmpRoots.push(root);
  const sd = stateDir(root);
  return { sd, forge: new Forge(new Store(sd.dbFile), new GitHost(sd)) };
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots = [];
});

describe("orgs", () => {
  test("create org enrolls the creator as an owner-member", async () => {
    const { forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    const org = Result.unwrap(await forge.createOrg(ada, "acme", "Acme Inc"));
    expect(org.name).toBe("acme");
    expect(org.display_name).toBe("Acme Inc");
    expect(forge.store.isOrgMember("acme", ada.id)).toBe(true);
    expect(forge.store.listOrgsForUser(ada.id).map((o) => o.name)).toEqual([
      "acme",
    ]);
  });

  test("org names cannot shadow reserved names, usernames, or existing orgs", async () => {
    const { forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    Result.unwrap(await forge.createUser("bob", "pw"));
    expect((await forge.createOrg(ada, "plat")).status).toBe("error"); // reserved
    expect((await forge.createOrg(ada, "bob")).status).toBe("error"); // username
    Result.unwrap(await forge.createOrg(ada, "acme"));
    expect((await forge.createOrg(ada, "acme")).status).toBe("error"); // dup org
  });

  test("a username cannot shadow an existing org", async () => {
    const { forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    Result.unwrap(await forge.createOrg(ada, "acme"));
    const collide = await forge.createUser("acme", "pw");
    expect(collide.status).toBe("error");
  });

  test("members can create repos under the org; non-members cannot", async () => {
    const { forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    const bob = Result.unwrap(await forge.createUser("bob", "pw"));
    Result.unwrap(await forge.createOrg(ada, "acme"));

    // ada (member) can write under acme; bob (non-member) cannot.
    expect((await forge.createRepo(ada, "acme", "widget")).status).toBe("ok");
    expect((await forge.createRepo(bob, "acme", "sneak")).status).toBe("error");
    expect(forge.authorize(ada, "acme", "widget", "write")).toBe(true);
    expect(forge.authorize(bob, "acme", "widget", "write")).toBe(false);
    expect(forge.authorize(bob, "acme", "widget", "read")).toBe(true); // public read

    // invite bob → he can now write.
    Result.unwrap(forge.addOrgMember(ada, "acme", "bob"));
    expect(forge.authorize(bob, "acme", "widget", "write")).toBe(true);
  });

  test("only members may invite; unknown users/orgs are rejected", async () => {
    const { forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    const bob = Result.unwrap(await forge.createUser("bob", "pw"));
    Result.unwrap(await forge.createOrg(ada, "acme"));
    expect(forge.addOrgMember(bob, "acme", "ada").status).toBe("error"); // bob not a member
    expect(forge.addOrgMember(ada, "acme", "nobody").status).toBe("error"); // no such user
    expect(forge.addOrgMember(ada, "ghost", "bob").status).toBe("error"); // no such org
  });

  test("re-inviting a member never demotes an owner", async () => {
    const { forge } = fresh();
    const ada = Result.unwrap(await forge.createUser("ada", "pw"));
    const bob = Result.unwrap(await forge.createUser("bob", "pw"));
    Result.unwrap(await forge.createOrg(ada, "acme"));
    Result.unwrap(forge.addOrgMember(ada, "acme", "bob"));

    // bob (member) re-invites ada (creator/owner) — role must survive.
    Result.unwrap(forge.addOrgMember(bob, "acme", "ada"));
    const roles = new Map(
      forge.store.listOrgMembers("acme").map((m) => [m.username, m.role]),
    );
    expect(roles.get("ada")).toBe("owner");
    expect(roles.get("bob")).toBe("member");

    // explicit promotion via the store still works.
    forge.store.addOrgMember("acme", bob.id, "owner");
    expect(
      forge.store.listOrgMembers("acme").find((m) => m.username === "bob")
        ?.role,
    ).toBe("owner");
  });
});
