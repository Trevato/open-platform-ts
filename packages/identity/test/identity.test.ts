import { describe, expect, test } from "bun:test";
import { Result } from "@op/core";
import {
  discoveryDocument,
  jwksDocument,
  loadSigningKey,
  mintSigningKey,
  randomOauthCode,
  signAccessToken,
  signIdToken,
  verifyAccessToken,
  verifyPkceS256,
} from "@op/identity";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";

const ISS = "https://plat.localtest.me:18443";

describe("signing key", () => {
  test("mint → persist → load yields the same kid and public JWK", async () => {
    const { privateJwk, key } = await mintSigningKey();
    const reloaded = await loadSigningKey(privateJwk);
    expect(reloaded.kid).toBe(key.kid);
    expect(reloaded.publicJwk.n).toBe(key.publicJwk.n);
    expect(key.publicJwk).not.toHaveProperty("d"); // never leak the private component
  });

  test("jwks exposes exactly the public key with sig use", async () => {
    const { key } = await mintSigningKey();
    const jwks = jwksDocument(key);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]!.use).toBe("sig");
    expect(jwks.keys[0]!.alg).toBe("RS256");
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });
});

describe("discovery", () => {
  test("endpoints derive from the issuer", () => {
    const d = discoveryDocument(ISS);
    expect(d["issuer"]).toBe(ISS);
    expect(d["authorization_endpoint"]).toBe(`${ISS}/oauth/authorize`);
    expect(d["token_endpoint"]).toBe(`${ISS}/oauth/token`);
    expect(d["jwks_uri"]).toBe(`${ISS}/oauth/jwks`);
    expect(d["code_challenge_methods_supported"]).toEqual(["S256"]);
  });
});

describe("id_token", () => {
  test("verifies against the public JWK with correct iss/aud/sub/nonce", async () => {
    const { key } = await mintSigningKey();
    const jwt = await signIdToken(key, {
      issuer: ISS,
      clientId: "app_ada_blog",
      sub: "usr_123",
      username: "ada",
      nonce: "n-once",
      ttlSec: 300,
    });
    const { payload, protectedHeader } = await jwtVerify(jwt, key.publicKey, {
      issuer: ISS,
      audience: "app_ada_blog",
    });
    expect(protectedHeader.kid).toBe(key.kid);
    expect(payload.sub).toBe("usr_123");
    expect(payload["preferred_username"]).toBe("ada");
    expect(payload["nonce"]).toBe("n-once");
  });

  test("a DIFFERENT platform key cannot mint a token this key accepts", async () => {
    const { key: mine } = await mintSigningKey();
    const stranger = await generateKeyPair("RS256", { extractable: true });
    const forged = await signIdToken(
      {
        privateKey: stranger.privateKey,
        publicKey: stranger.publicKey,
        publicJwk: await exportJWK(stranger.publicKey),
        kid: "x",
      },
      {
        issuer: ISS,
        clientId: "c",
        sub: "usr_1",
        username: "ada",
        ttlSec: 300,
      },
    );
    await expect(
      jwtVerify(forged, mine.publicKey, { issuer: ISS }),
    ).rejects.toThrow();
  });
});

describe("access_token + userinfo", () => {
  test("roundtrips through verifyAccessToken", async () => {
    const { key } = await mintSigningKey();
    const at = await signAccessToken(key, {
      issuer: ISS,
      sub: "usr_9",
      username: "bob",
      scope: "openid profile",
      ttlSec: 300,
    });
    const v = await verifyAccessToken(at, key, ISS);
    expect(v.status).toBe("ok");
    expect(Result.unwrap(v)).toMatchObject({ sub: "usr_9", username: "bob" });
  });

  test("a tampered/foreign token is rejected", async () => {
    const { key } = await mintSigningKey();
    const other = (await mintSigningKey()).key;
    const at = await signAccessToken(other, {
      issuer: ISS,
      sub: "x",
      username: "x",
      scope: "openid",
      ttlSec: 300,
    });
    expect((await verifyAccessToken(at, key, ISS)).status).toBe("error");
    expect((await verifyAccessToken("not.a.jwt", key, ISS)).status).toBe(
      "error",
    );
  });
});

describe("PKCE S256", () => {
  test("accepts the matching verifier, rejects others", async () => {
    // A known RFC 7636 vector.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkceS256(challenge, verifier)).toBe(true);
    expect(await verifyPkceS256(challenge, "wrong-verifier")).toBe(false);
  });
});

describe("codes", () => {
  test("randomOauthCode is long and unique", () => {
    const a = randomOauthCode();
    expect(a).toHaveLength(32);
    expect(a).not.toBe(randomOauthCode());
  });
});
