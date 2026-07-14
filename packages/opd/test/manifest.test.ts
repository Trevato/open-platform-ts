import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitManifest,
  DEFAULT_APP_POLICY,
  EMPTY_MANIFEST,
  envNameFor,
  isSafeDest,
  readManifest,
} from "../src/manifest.ts";

// Assets are denied by default (assetHosts: []); tests opt example.com in.
const P = { ...DEFAULT_APP_POLICY, assetHosts: ["example.com"] };

describe("admitManifest", () => {
  test("absent / empty manifests admit to the empty manifest", () => {
    expect(admitManifest(undefined, P)).toEqual(
      expect.objectContaining({ status: "ok" }),
    );
    const admitted = admitManifest({}, P);
    expect(admitted.status).toBe("ok");
    if (admitted.status === "ok")
      expect(admitted.value).toEqual(EMPTY_MANIFEST);
  });

  test("resources are bounded by policy", () => {
    const ok = admitManifest({ resources: { memoryMb: 1536, cpus: 1.5 } }, P);
    expect(ok.status).toBe("ok");
    if (ok.status === "ok")
      expect(ok.value.resources).toEqual({ memoryMb: 1536, cpus: 1.5 });

    expect(admitManifest({ resources: { memoryMb: 4096 } }, P).status).toBe(
      "error",
    ); // over max
    expect(admitManifest({ resources: { memoryMb: 32 } }, P).status).toBe(
      "error",
    ); // under floor
    expect(admitManifest({ resources: { cpus: 99 } }, P).status).toBe("error");
    expect(admitManifest({ resources: { memoryMb: "big" } }, P).status).toBe(
      "error",
    );
  });

  test("tcpPorts: valid ports, no dups, capped per app", () => {
    const ok = admitManifest({ tcpPorts: [25565, 25566] }, P);
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.value.tcpPorts).toEqual([25565, 25566]);

    expect(admitManifest({ tcpPorts: [0] }, P).status).toBe("error");
    expect(admitManifest({ tcpPorts: [70000] }, P).status).toBe("error");
    expect(admitManifest({ tcpPorts: [25565, 25565] }, P).status).toBe("error");
    expect(admitManifest({ tcpPorts: [1, 2, 3, 4, 5] }, P).status).toBe(
      "error",
    ); // over maxTcpPortsPerApp=4
  });

  test("assets: https-only, jailed dest, sha256 shape", () => {
    const good = {
      assets: [
        {
          url: "https://example.com/server.jar",
          dest: "server.jar",
          sha256: "a".repeat(64),
        },
      ],
    };
    expect(admitManifest(good, P).status).toBe("ok");

    const httpUrl = {
      assets: [{ url: "http://example.com/x", dest: "x" }],
    };
    expect(admitManifest(httpUrl, P).status).toBe("error");

    const escape = {
      assets: [{ url: "https://example.com/x", dest: "../x" }],
    };
    expect(admitManifest(escape, P).status).toBe("error");

    const absolute = {
      assets: [{ url: "https://example.com/x", dest: "/etc/passwd" }],
    };
    expect(admitManifest(absolute, P).status).toBe("error");

    const badSha = {
      assets: [{ url: "https://example.com/x", dest: "x", sha256: "nope" }],
    };
    expect(admitManifest(badSha, P).status).toBe("error");

    const dupDest = {
      assets: [
        { url: "https://example.com/a", dest: "x" },
        { url: "https://example.com/b", dest: "sub/../x" },
      ],
    };
    expect(admitManifest(dupDest, P).status).toBe("error");
  });

  test("assets are denied by default — assetHosts is an explicit opt-in", () => {
    const manifest = {
      assets: [{ url: "https://example.com/x", dest: "x" }],
    };
    expect(admitManifest(manifest, DEFAULT_APP_POLICY).status).toBe("error");
    const offList = {
      assets: [{ url: "https://evil.example.org/x", dest: "x" }],
    };
    expect(admitManifest(offList, P).status).toBe("error");
  });

  test("provides: kebab names, leading-slash paths, no dups", () => {
    const good = {
      provides: [
        { name: "server-status", path: "/api/status", description: "players" },
      ],
    };
    const admitted = admitManifest(good, P);
    expect(admitted.status).toBe("ok");
    if (admitted.status === "ok")
      expect(admitted.value.provides[0]?.name).toBe("server-status");

    expect(
      admitManifest(
        { provides: [{ name: "Bad Name", path: "/x", description: "" }] },
        P,
      ).status,
    ).toBe("error");
    expect(
      admitManifest(
        { provides: [{ name: "x", path: "no-slash", description: "" }] },
        P,
      ).status,
    ).toBe("error");
    expect(
      admitManifest(
        {
          provides: [
            { name: "x", path: "/a", description: "" },
            { name: "x", path: "/b", description: "" },
          ],
        },
        P,
      ).status,
    ).toBe("error");
  });

  test("consumes: valid names, owner optional, env-name collisions denied", () => {
    const good = {
      consumes: [{ app: "shop" }, { owner: "greener", app: "mc-alpha" }],
    };
    const admitted = admitManifest(good, P);
    expect(admitted.status).toBe("ok");
    if (admitted.status === "ok") {
      expect(admitted.value.consumes).toEqual([
        { owner: null, app: "shop" },
        { owner: "greener", app: "mc-alpha" },
      ]);
    }

    // Same derived env name across two owners — one name, one peer.
    const collide = {
      consumes: [
        { owner: "a", app: "shop" },
        { owner: "b", app: "shop" },
      ],
    };
    expect(admitManifest(collide, P).status).toBe("error");
    expect(admitManifest({ consumes: [{ app: "Not Valid" }] }, P).status).toBe(
      "error",
    );
  });

  test("envNameFor derivation", () => {
    expect(envNameFor("shop")).toBe("OP_PEER_SHOP_URL");
    expect(envNameFor("mc-alpha")).toBe("OP_PEER_MC_ALPHA_URL");
  });

  test("unknown top-level keys are ignored (forward-compatible)", () => {
    const admitted = admitManifest({ future: { anything: true } }, P);
    expect(admitted.status).toBe("ok");
  });
});

describe("isSafeDest", () => {
  test("accepts nested relative paths, rejects escapes", () => {
    expect(isSafeDest("server.jar")).toBe(true);
    expect(isSafeDest("mc-servers/1/server.jar")).toBe(true);
    expect(isSafeDest("a/./b")).toBe(true);
    expect(isSafeDest("..")).toBe(false);
    expect(isSafeDest("a/../../b")).toBe(false);
    expect(isSafeDest("/abs")).toBe(false);
    expect(isSafeDest("a\\b")).toBe(false);
    expect(isSafeDest("")).toBe(false);
    expect(isSafeDest(".")).toBe(false);
  });
});

describe("readManifest", () => {
  test("no op.json → empty manifest; malformed JSON → violation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "op-manifest-"));
    const none = await readManifest(dir, P);
    expect(none.status).toBe("ok");
    if (none.status === "ok") expect(none.value).toEqual(EMPTY_MANIFEST);

    await writeFile(join(dir, "op.json"), "{not json");
    const bad = await readManifest(dir, P);
    expect(bad.status).toBe("error");

    await writeFile(
      join(dir, "op.json"),
      JSON.stringify({ tcpPorts: [25565], resources: { memoryMb: 1024 } }),
    );
    const good = await readManifest(dir, P);
    expect(good.status).toBe("ok");
    if (good.status === "ok") {
      expect(good.value.tcpPorts).toEqual([25565]);
      expect(good.value.resources.memoryMb).toBe(1024);
    }
  });
});
