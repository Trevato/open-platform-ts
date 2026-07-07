import { describe, expect, test } from "bun:test";
import {
  isReservedAppName,
  isReservedName,
  isValidName,
  newId,
  newToken,
  randomHex,
  sha256Hex,
} from "@op/core";

describe("ids", () => {
  test("newId shape and uniqueness", () => {
    const a = newId("usr");
    const b = newId("usr");
    expect(a).toMatch(/^usr_[0-9a-z]{20}$/);
    expect(a).not.toBe(b);
  });

  test("newToken carries ≥160 bits", () => {
    expect(newToken("op_pat")).toMatch(/^op_pat_[0-9a-z]{32}$/);
  });

  test("randomHex length", () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("sha256Hex is stable", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("name validation (fs path / DNS label / git path safety)", () => {
  test.each(["hello", "my-app", "a", "user1", "a1-b2"])("accepts %s", (s) => {
    expect(isValidName(s)).toBe(true);
  });

  test.each([
    "",
    "-lead",
    "trail-",
    "UPPER",
    "under_score",
    "dot.dot",
    "a..b",
    "../etc",
    "double--dash", // reserved: '--' is the env separator in namespace names
    "way-too-long-name-that-goes-past-the-thirty-eight-char-limit",
    "a/b",
  ])("rejects %s", (s) => {
    expect(isValidName(s)).toBe(false);
  });
});

describe("reserved names", () => {
  test.each(["sys", "plat", "admin", "api", "oauth", "PLAT"])(
    "reserves %s",
    (s) => {
      expect(isReservedName(s)).toBe(true);
    },
  );

  test.each(["ada", "hello", "my-app"])("allows %s", (s) => {
    expect(isReservedName(s)).toBe(false);
  });

  test("app names can't collide with preview hosts (pr-<n> prefix)", () => {
    expect(isReservedAppName("pr-1-shop")).toBe(true);
    expect(isReservedAppName("pr-42")).toBe(true);
    expect(isReservedAppName("plat")).toBe(true); // reserved names too
    expect(isReservedAppName("preview")).toBe(false); // "pr" not followed by a digit is fine
    expect(isReservedAppName("printer")).toBe(false);
    expect(isReservedAppName("hello")).toBe(false);
  });
});
