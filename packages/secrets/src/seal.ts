import { Decrypter, Encrypter } from "age-encryption";
import { Result } from "@op/core";
import { SealError, SovereigntyViolation, UnsealError } from "./errors.ts";

// One sealed store: named values, each independently age-encrypted to exactly
// one recipient. JSON so the file is diffable in git; values are base64 of the
// age binary format (age CLI can decrypt them after base64 -d).
export interface SecretsFile {
  version: 1;
  recipient: string;
  values: Record<string, string>;
}

export async function sealValue(
  recipient: string,
  name: string,
  plaintext: string,
): Promise<Result<string, SealError>> {
  return Result.tryPromise({
    try: async () => {
      const enc = new Encrypter();
      enc.addRecipient(recipient);
      const ct = await enc.encrypt(plaintext);
      return Buffer.from(ct).toString("base64");
    },
    catch: (cause) => new SealError({ message: String(cause), secret: name }),
  });
}

export async function openValue(
  identity: string,
  name: string,
  sealed: string,
): Promise<Result<string, UnsealError>> {
  return Result.tryPromise({
    try: async () => {
      const dec = new Decrypter();
      dec.addIdentity(identity);
      return await dec.decrypt(Buffer.from(sealed, "base64"), "text");
    },
    catch: (cause) => new UnsealError({ message: String(cause), secret: name }),
  });
}

export async function sealAll(
  recipient: string,
  plain: Record<string, string>,
): Promise<Result<SecretsFile, SealError>> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(plain)) {
    const sealed = await sealValue(recipient, name, value);
    if (sealed.status === "error") return sealed as Result<never, SealError>;
    values[name] = sealed.value;
  }
  return Result.ok({ version: 1, recipient, values });
}

export async function openAll(
  identity: string,
  file: SecretsFile,
): Promise<Result<Record<string, string>, UnsealError>> {
  const out: Record<string, string> = {};
  for (const [name, sealed] of Object.entries(file.values)) {
    const opened = await openValue(identity, name, sealed);
    if (opened.status === "error") return opened as Result<never, UnsealError>;
    out[name] = opened.value;
  }
  return Result.ok(out);
}

// The age v1 header is ASCII: stanza lines start "-> ", terminated by the
// "---" MAC line. Counting stanzas counts recipients — no parser dependency.
export function countRecipientStanzas(sealedBase64: string): number {
  const bytes = Buffer.from(sealedBase64, "base64");
  const headerEnd = bytes.indexOf("\n---");
  const header = bytes
    .subarray(0, headerEnd === -1 ? bytes.length : headerEnd)
    .toString("latin1");
  return header.split("\n").filter((l) => l.startsWith("-> ")).length;
}

/**
 * The sovereignty gate, verified EMPIRICALLY (never by trusting metadata):
 * every value (a) decrypts with this identity, and (b) names exactly ONE
 * recipient stanza — no escrow, no second recipient, no parent copy.
 * Ported from mitosis fork_verify_all_sealed; germination aborts on failure.
 */
export async function verifyAllSealed(
  identity: string,
  file: SecretsFile,
): Promise<Result<void, SovereigntyViolation>> {
  for (const [name, sealed] of Object.entries(file.values)) {
    const stanzas = countRecipientStanzas(sealed);
    if (stanzas !== 1) {
      return Result.err(
        new SovereigntyViolation({
          message: `sealed to ${stanzas} recipients — must be exactly 1`,
                    secret: name,
        }),
      );
    }
    const opened = await openValue(identity, name, sealed);
    if (opened.status === "error") {
      return Result.err(
        new SovereigntyViolation({
          message: "does not decrypt with the sovereign key",
                    secret: name,
        }),
      );
    }
  }
  return Result.ok(undefined);
}
