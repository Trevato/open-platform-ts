import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { Result } from "@op/core";
import { KeyFileError } from "./errors.ts";

export interface SovereignKey {
  /** AGE-SECRET-KEY-1… — the sole decryptor of everything this platform seals. */
  readonly identity: string;
  /** age1… — what values are sealed to. */
  readonly recipient: string;
}

// X25519 (not the post-quantum hybrid): byte-for-byte the format `age-keygen`
// mints, so existing age CLI tooling and fork-<domain>.age muscle memory carry over.
export async function mintKey(): Promise<SovereignKey> {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient };
}

// age-keygen file format: comment lines + the secret key line. 0600.
export async function saveKeyFile(
  path: string,
  key: SovereignKey,
): Promise<Result<void, KeyFileError>> {
  return Result.tryPromise({
    try: async () => {
      if (await Bun.file(path).exists()) {
        throw new Error(
          "key file already exists — refusing to clobber a sovereign key",
        );
      }
      await mkdir(dirname(path), { recursive: true });
      const body =
        `# created: ${new Date().toISOString()}\n` +
        `# public key: ${key.recipient}\n` +
        `${key.identity}\n`;
      await writeFile(path, body, { mode: 0o600 });
      await chmod(path, 0o600);
    },
    catch: (cause) => new KeyFileError({ message: String(cause), path }),
  });
}

export async function loadKeyFile(
  path: string,
): Promise<Result<SovereignKey, KeyFileError>> {
  return Result.tryPromise({
    try: async () => {
      const text = await Bun.file(path).text();
      const identity = text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("AGE-SECRET-KEY-"));
      if (!identity) throw new Error("no AGE-SECRET-KEY line found");
      const recipient = await identityToRecipient(identity);
      return { identity, recipient };
    },
    catch: (cause) => new KeyFileError({ message: String(cause), path }),
  });
}
