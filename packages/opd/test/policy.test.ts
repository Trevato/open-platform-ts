import { describe, expect, test } from "bun:test";
import {
  admitImageTag,
  admitSpec,
  hostFor,
  type AppSpec,
} from "../src/policy.ts";

const good = {
  owner: "ada",
  app: "hello",
  repo: { owner: "ada", name: "hello" },
  ref: "main",
  containerPort: 8080,
  data: true,
};

describe("admitSpec (fail-closed)", () => {
  test("admits a well-formed spec", () => {
    const r = admitSpec(good, { domain: "plat.localtest.me" });
    expect(r.status).toBe("ok");
  });

  test.each([
    ["not an object", null],
    ["bad owner", { ...good, owner: "../etc" }],
    ["bad app", { ...good, app: "UPPER" }],
    ["missing repo", { ...good, repo: undefined }],
    ["bad repo name", { ...good, repo: { owner: "ada", name: "a/b" } }],
    ["traversal ref", { ...good, ref: "../main" }],
    ["port 0", { ...good, containerPort: 0 }],
    ["port float", { ...good, containerPort: 80.5 }],
    ["port high", { ...good, containerPort: 70000 }],
    ["data string", { ...good, data: "yes" }],
  ])("denies %s", (_label, raw) => {
    expect(admitSpec(raw, { domain: "d" }).status).toBe("error");
  });
});

describe("host + image provenance", () => {
  const spec = good as AppSpec;

  test("host is derived, never chosen", () => {
    expect(hostFor(spec, "plat.localtest.me")).toBe(
      "hello-ada.plat.localtest.me",
    );
  });

  test("only platform-built tags are admitted", () => {
    expect(admitImageTag("op/ada-hello:abc123def456", spec).status).toBe("ok");
    expect(admitImageTag("docker.io/evil/image:latest", spec).status).toBe(
      "error",
    );
    expect(admitImageTag("op/bob-hello:abc", spec).status).toBe("error");
  });
});
