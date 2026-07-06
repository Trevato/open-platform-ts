import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { ensureCa } from "@op/gate";
import {
  BasicConstraintsExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
} from "@peculiar/x509";

const DOMAIN = "op-test.localtest.me";

describe("ensureCa", () => {
  test("generates CA + wildcard leaf, persists PEM files, keys 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "op-certs-"));
    const out = Result.unwrap(await ensureCa(dir, DOMAIN));
    expect(out.caCert).toInclude("BEGIN CERTIFICATE");
    expect(out.cert).toInclude("BEGIN CERTIFICATE");
    expect(out.key).toInclude("BEGIN PRIVATE KEY");

    for (const f of ["ca.crt", "ca.key", "wildcard.crt", "wildcard.key"]) {
      expect(await Bun.file(join(dir, f)).exists()).toBe(true);
    }
    for (const f of ["ca.key", "wildcard.key"]) {
      expect((await stat(join(dir, f))).mode & 0o777).toBe(0o600);
    }
  });

  test("CA is a CA; leaf carries both SANs and validates against the CA", async () => {
    const dir = mkdtempSync(join(tmpdir(), "op-certs-"));
    const out = Result.unwrap(await ensureCa(dir, DOMAIN));

    const ca = new X509Certificate(out.caCert);
    const leaf = new X509Certificate(out.cert);
    expect(ca.subject).toBe(`CN=Open Platform CA ${DOMAIN}`);
    expect(ca.getExtension(BasicConstraintsExtension)?.ca).toBe(true);
    expect(await ca.isSelfSigned()).toBe(true);

    expect(leaf.issuer).toBe(ca.subject);
    expect(await leaf.verify({ publicKey: ca })).toBe(true);
    const san = leaf.getExtension(SubjectAlternativeNameExtension);
    const dns = (san?.names.toJSON() ?? [])
      .filter((n) => n.type === "dns")
      .map((n) => n.value)
      .sort();
    expect(dns).toEqual([`*.${DOMAIN}`, DOMAIN].sort());

    const years = (d: X509Certificate) =>
      (d.notAfter.getTime() - d.notBefore.getTime()) / (365 * 86400_000);
    expect(years(ca)).toBeGreaterThanOrEqual(9.9);
    expect(years(leaf)).toBeGreaterThanOrEqual(1.9);
    expect(years(leaf)).toBeLessThan(3);
  });

  test("idempotent: second call returns the exact same PEMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "op-certs-"));
    const first = Result.unwrap(await ensureCa(dir, DOMAIN));
    const second = Result.unwrap(await ensureCa(dir, DOMAIN));
    expect(second.caCert).toBe(first.caCert);
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });
});
