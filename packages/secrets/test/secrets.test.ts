import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import {
  countRecipientStanzas,
  loadKeyFile,
  mintKey,
  openAll,
  openValue,
  PLATFORM_SECRETS,
  regenerateAll,
  saveKeyFile,
  sealAll,
  sealValue,
  verifyAllSealed,
} from "@op/secrets";
import { Encrypter } from "age-encryption";

describe("sovereign key", () => {
  test("mint → save → load roundtrip, age-keygen-compatible format", async () => {
    const key = await mintKey();
    expect(key.identity).toStartWith("AGE-SECRET-KEY-1");
    expect(key.recipient).toStartWith("age1");

    const path = join(mkdtempSync(join(tmpdir(), "op-key-")), "key.age");
    Result.unwrap(await saveKeyFile(path, key));
    const loaded = Result.unwrap(await loadKeyFile(path));
    expect(loaded.identity).toBe(key.identity);
    expect(loaded.recipient).toBe(key.recipient);

    const mode =
      (await import("node:fs/promises").then((fs) => fs.stat(path))).mode &
      0o777;
    expect(mode).toBe(0o600);
  });

  test("refuses to clobber an existing key file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "op-key-")), "key.age");
    Result.unwrap(await saveKeyFile(path, await mintKey()));
    const second = await saveKeyFile(path, await mintKey());
    expect(second.status).toBe("error");
  });
});

describe("sealing", () => {
  test("seal → open roundtrip", async () => {
    const key = await mintKey();
    const sealed = Result.unwrap(
      await sealValue(key.recipient, "X", "hunter2"),
    );
    expect(Result.unwrap(await openValue(key.identity, "X", sealed))).toBe(
      "hunter2",
    );
  });

  test("sealAll/openAll preserve every value", async () => {
    const key = await mintKey();
    const plain = { A: "1", B: "two", C: "🔐 unicode too" };
    const file = Result.unwrap(await sealAll(key.recipient, plain));
    expect(file.recipient).toBe(key.recipient);
    expect(Result.unwrap(await openAll(key.identity, file))).toEqual(plain);
  });

  test("SOVEREIGNTY: a different key cannot decrypt", async () => {
    const mother = await mintKey();
    const stranger = await mintKey();
    const sealed = Result.unwrap(
      await sealValue(mother.recipient, "X", "secret"),
    );
    const attempt = await openValue(stranger.identity, "X", sealed);
    expect(attempt.status).toBe("error");
  });

  test("verifyAllSealed passes for a well-sealed file", async () => {
    const key = await mintKey();
    const file = Result.unwrap(
      await sealAll(key.recipient, { A: "1", B: "2" }),
    );
    expect((await verifyAllSealed(key.identity, file)).status).toBe("ok");
  });

  test("verifyAllSealed rejects a value sealed to a DIFFERENT key", async () => {
    const mother = await mintKey();
    const daughter = await mintKey();
    const file = Result.unwrap(await sealAll(daughter.recipient, { A: "1" }));
    // Sneak in a mother-sealed value — the classic fork leak.
    file.values["LEAK"] = Result.unwrap(
      await sealValue(mother.recipient, "LEAK", "parent-owned"),
    );
    const verdict = await verifyAllSealed(daughter.identity, file);
    expect(verdict.status).toBe("error");
    if (verdict.status === "error") expect(verdict.error.secret).toBe("LEAK");
  });

  test("verifyAllSealed rejects multi-recipient ciphertext (escrow attempt)", async () => {
    const key = await mintKey();
    const second = await mintKey();
    const enc = new Encrypter();
    enc.addRecipient(key.recipient);
    enc.addRecipient(second.recipient); // escrow: a second decryptor
    const ct = Buffer.from(await enc.encrypt("v")).toString("base64");
    expect(countRecipientStanzas(ct)).toBe(2);
    const file = {
      version: 1 as const,
      recipient: key.recipient,
      values: { E: ct },
    };
    const verdict = await verifyAllSealed(key.identity, file);
    expect(verdict.status).toBe("error");
  });
});

describe("regeneration (fork semantics)", () => {
  test("regenerateAll mints fresh values sealed to the given recipient", async () => {
    const key = await mintKey();
    const { file, plain } = Result.unwrap(await regenerateAll(key.recipient));
    expect(Object.keys(file.values).sort()).toEqual(
      Object.keys(PLATFORM_SECRETS).sort(),
    );
    expect((await verifyAllSealed(key.identity, file)).status).toBe("ok");
    expect(Result.unwrap(await openAll(key.identity, file))).toEqual(plain);
  });

  test("two regenerations share NOTHING", async () => {
    const a = Result.unwrap(await regenerateAll((await mintKey()).recipient));
    const b = Result.unwrap(await regenerateAll((await mintKey()).recipient));
    for (const name of Object.keys(a.plain)) {
      expect(a.plain[name]).not.toBe(b.plain[name]);
    }
  });
});
