// Crockford-ish base32, lowercase, no i/l/o/u — safe in URLs, filenames, and to read aloud.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomChars(20)}`;
}

// Secret-bearing token. 32 chars of base32 ≈ 160 bits of entropy.
export function newToken(prefix: string): string {
  return `${prefix}_${randomChars(32)}`;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

// Owner and app names become fs path segments, git paths, and DNS labels
// (<app>-<owner>.<domain>), so the grammar is the strictest of the three:
// lowercase alphanumeric + inner hyphens, max 38 chars (two names + a hyphen
// stay under the 63-char DNS label limit with room for pr-<n>- prefixes).
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,36}[a-z0-9])?$/;

export function isValidName(s: string): boolean {
  return NAME_RE.test(s) && !s.includes("--");
}
