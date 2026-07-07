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

// Names the platform owns or that would shadow a platform route/host. Reserved
// for user/org names so self-serve signup can never impersonate the platform
// (e.g. a "plat" org) or claim a well-known host.
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "sys",
  "plat",
  "admin",
  "root",
  "api",
  "oauth",
  "login",
  "logout",
  "www",
  "mail",
  "internal",
  "well-known",
]);

export function isReservedName(s: string): boolean {
  return RESERVED_NAMES.has(s.toLowerCase());
}

// App names additionally must not collide with a preview host. A preview lives
// at pr-<n>-<app>-<owner>.<domain>; an app literally named "pr-1-shop" would
// produce an identical host, so the "pr-" + digits prefix is off-limits.
export function isReservedAppName(s: string): boolean {
  return isReservedName(s) || /^pr-\d/.test(s);
}
