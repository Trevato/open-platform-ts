import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "@op/core";
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { GateError } from "./errors.ts";

const EC_P256: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_ALG: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

async function newKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(EC_P256, true, ["sign", "verify"]);
}

async function privateKeyPem(key: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key);
  return PemConverter.encode(pkcs8, "PRIVATE KEY");
}

// Key files hold the platform's TLS identity — never group/world readable.
async function writeKeyFile(path: string, pem: string): Promise<void> {
  await writeFile(path, pem, { mode: 0o600 });
  await chmod(path, 0o600); // mode above only applies on create; enforce on overwrite too
}

export interface CaFiles {
  caCert: string;
  cert: string;
  key: string;
}

export async function ensureCa(
  certsDir: string,
  domain: string,
): Promise<Result<CaFiles, GateError>> {
  return Result.tryPromise({
    try: async () => {
      const caCrtPath = join(certsDir, "ca.crt");
      const caKeyPath = join(certsDir, "ca.key");
      const crtPath = join(certsDir, "wildcard.crt");
      const keyPath = join(certsDir, "wildcard.key");

      const exists = await Promise.all(
        [caCrtPath, caKeyPath, crtPath, keyPath].map((p) =>
          Bun.file(p).exists(),
        ),
      );
      if (exists.every(Boolean)) {
        const [caCert, cert, key] = await Promise.all([
          Bun.file(caCrtPath).text(),
          Bun.file(crtPath).text(),
          Bun.file(keyPath).text(),
        ]);
        return { caCert, cert, key };
      }

      await mkdir(certsDir, { recursive: true });
      const notBefore = new Date(Date.now() - 5 * 60_000); // clock-skew guard

      const caKeys = await newKeyPair();
      const ca = await X509CertificateGenerator.createSelfSigned(
        {
          name: [{ CN: [`Open Platform CA ${domain}`] }],
          notBefore,
          notAfter: new Date(Date.now() + 10 * YEAR_MS),
          signingAlgorithm: SIGN_ALG,
          keys: caKeys,
          extensions: [
            new BasicConstraintsExtension(true, undefined, true),
            new KeyUsagesExtension(
              KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
              true,
            ),
            await SubjectKeyIdentifierExtension.create(caKeys.publicKey),
          ],
        },
        crypto,
      );

      const leafKeys = await newKeyPair();
      const leaf = await X509CertificateGenerator.create(
        {
          subject: [{ CN: [domain] }],
          issuer: ca.subjectName,
          notBefore,
          notAfter: new Date(Date.now() + 2 * YEAR_MS),
          signingAlgorithm: SIGN_ALG,
          publicKey: leafKeys.publicKey,
          signingKey: caKeys.privateKey,
          extensions: [
            new BasicConstraintsExtension(false, undefined, true),
            new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
            new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
            new SubjectAlternativeNameExtension([
              { type: "dns", value: domain },
              { type: "dns", value: `*.${domain}` },
            ]),
            await SubjectKeyIdentifierExtension.create(leafKeys.publicKey),
            await AuthorityKeyIdentifierExtension.create(ca.publicKey),
          ],
        },
        crypto,
      );

      const out: CaFiles = {
        caCert: ca.toString("pem"),
        cert: leaf.toString("pem"),
        key: await privateKeyPem(leafKeys.privateKey),
      };
      await writeFile(caCrtPath, out.caCert);
      await writeFile(crtPath, out.cert);
      await writeKeyFile(caKeyPath, await privateKeyPem(caKeys.privateKey));
      await writeKeyFile(keyPath, out.key);
      return out;
    },
    catch: (cause) => new GateError({ message: `ensureCa: ${String(cause)}` }),
  });
}
