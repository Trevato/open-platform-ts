import { randomHex, Result } from "@op/core";
import type { SealError } from "./errors.ts";
import { sealAll, type SecretsFile } from "./seal.ts";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function generatePassword(chars = 24): string {
  const bytes = new Uint8Array(chars);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

export type SecretSpec = Record<string, () => string>;

// The platform's own secret inventory. Germination calls regenerateAll with
// this spec — every value is minted FRESH for the daughter; nothing sealed by
// a parent ever survives a fork (the ciphertext in a seed is inert).
export const PLATFORM_SECRETS: SecretSpec = {
  ADMIN_PASSWORD: () => generatePassword(24),
  SESSION_KEY: () => randomHex(32),
  WEBHOOK_HMAC: () => randomHex(32),
};

export async function regenerateAll(
  recipient: string,
  spec: SecretSpec = PLATFORM_SECRETS,
): Promise<
  Result<{ file: SecretsFile; plain: Record<string, string> }, SealError>
> {
  const plain: Record<string, string> = {};
  for (const [name, gen] of Object.entries(spec)) plain[name] = gen();
  const sealed = await sealAll(recipient, plain);
  return Result.map(sealed, (file) => ({ file, plain }));
}
