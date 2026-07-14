import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type KeyLike,
} from "jose";
import { Result, TaggedError } from "@op/core";

export class OidcError extends TaggedError("OidcError")<{
  message: string;
  code: string;
}>() {}

const ALG = "RS256";

export interface SigningKey {
  privateKey: KeyLike;
  publicKey: KeyLike; // verification key (jose refuses to verify with a private key)
  publicJwk: JWK; // includes kid, alg, use — this is what /jwks serves
  kid: string;
}

// A stable key id from the public key material, so a rotated key gets a new kid
// and old tokens can still be validated against the JWKS during overlap.
async function kidOf(publicJwk: JWK): Promise<string> {
  const material = JSON.stringify([publicJwk.n, publicJwk.e]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return Buffer.from(digest).toString("base64url").slice(0, 16);
}

export async function mintSigningKey(): Promise<{
  privateJwk: JWK;
  key: SigningKey;
}> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  const kid = await kidOf(publicJwk);
  return {
    privateJwk,
    key: {
      privateKey,
      publicKey,
      publicJwk: { ...publicJwk, kid, alg: ALG, use: "sig" },
      kid,
    },
  };
}

export async function loadSigningKey(privateJwk: JWK): Promise<SigningKey> {
  const privateKey = (await importJWK(privateJwk, ALG)) as KeyLike;
  // Public JWK = the private one minus every private RSA component.
  const {
    d: _d,
    p: _p,
    q: _q,
    dp: _dp,
    dq: _dq,
    qi: _qi,
    ...publicJwk
  } = privateJwk;
  const publicKey = (await importJWK(publicJwk, ALG)) as KeyLike;
  const kid = await kidOf(publicJwk);
  return {
    privateKey,
    publicKey,
    publicJwk: { ...publicJwk, kid, alg: ALG, use: "sig" },
    kid,
  };
}

export function jwksDocument(key: SigningKey): { keys: JWK[] } {
  return { keys: [key.publicJwk] };
}

export function discoveryDocument(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/oauth/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [ALG],
    scopes_supported: ["openid", "profile"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
    claims_supported: ["sub", "preferred_username", "name"],
  };
}

const now = () => Math.floor(Date.now() / 1000);

export async function signIdToken(
  key: SigningKey,
  claims: {
    issuer: string;
    clientId: string;
    sub: string;
    username: string;
    nonce?: string;
    ttlSec: number;
  },
): Promise<string> {
  const jwt = new SignJWT({
    preferred_username: claims.username,
    name: claims.username,
    ...(claims.nonce ? { nonce: claims.nonce } : {}),
  })
    .setProtectedHeader({ alg: ALG, kid: key.kid })
    .setIssuer(claims.issuer)
    .setSubject(claims.sub)
    .setAudience(claims.clientId)
    .setIssuedAt()
    .setExpirationTime(now() + claims.ttlSec);
  return jwt.sign(key.privateKey);
}

export async function signAccessToken(
  key: SigningKey,
  claims: {
    issuer: string;
    sub: string;
    username: string;
    scope: string;
    ttlSec: number;
    /** Defaults to the userinfo endpoint (user tokens). App-to-app tokens
     *  carry the TARGET app's origin instead — disjoint audiences are the
     *  invariant that keeps the two families from ever cross-authenticating. */
    aud?: string;
  },
): Promise<string> {
  return new SignJWT({
    scope: claims.scope,
    preferred_username: claims.username,
  })
    .setProtectedHeader({ alg: ALG, kid: key.kid })
    .setIssuer(claims.issuer)
    .setSubject(claims.sub)
    .setAudience(claims.aud ?? `${claims.issuer}/userinfo`)
    .setIssuedAt()
    .setExpirationTime(now() + claims.ttlSec)
    .sign(key.privateKey);
}

// Verify an id_token's signature + iss/aud (for tests and any RP embedded in
// the platform). Returns the claims or an error — never throws.
export async function verifyIdToken(
  token: string,
  key: SigningKey,
  opts: { issuer: string; audience: string },
): Promise<
  Result<{ sub: string; username: string; nonce?: string }, OidcError>
> {
  try {
    const { payload } = await jwtVerify(token, key.publicKey, {
      issuer: opts.issuer,
      audience: opts.audience,
    });
    return Result.ok({
      sub: String(payload.sub),
      username: String(payload["preferred_username"] ?? ""),
      ...(payload["nonce"] ? { nonce: String(payload["nonce"]) } : {}),
    });
  } catch (cause) {
    return Result.err(
      new OidcError({ message: String(cause), code: "invalid_token" }),
    );
  }
}

export async function verifyAccessToken(
  token: string,
  key: SigningKey,
  issuer: string,
  audience?: string,
): Promise<
  Result<{ sub: string; username: string; scope: string }, OidcError>
> {
  try {
    const { payload } = await jwtVerify(token, key.publicKey, {
      issuer,
      audience: audience ?? `${issuer}/userinfo`,
    });
    return Result.ok({
      sub: String(payload.sub),
      username: String(payload["preferred_username"] ?? ""),
      scope: String(payload["scope"] ?? ""),
    });
  } catch (cause) {
    return Result.err(
      new OidcError({ message: String(cause), code: "invalid_token" }),
    );
  }
}

// PKCE S256: the verifier, sha256'd and base64url-encoded, must equal the
// challenge presented at /authorize. Constant work, no secret storage needed.
export async function verifyPkceS256(
  challenge: string,
  verifier: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const computed = Buffer.from(digest).toString("base64url");
  return computed === challenge;
}

const CODE_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function randomOauthCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
