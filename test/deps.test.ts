// The minimalism regression gate: every external runtime dependency must be
// on this allowlist. Adding one is an architecture decision (docs/plan.md
// "Not building" table), not an npm install.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set([
  "better-result", // errors-as-values (core)
  "age-encryption", // typage — sovereign sealing (secrets)
  "jose", // token/OIDC crypto (identity, gate/ACME later)
  "@peculiar/x509", // CA + cert minting (gate)
  // M2/M3, pre-approved by the plan: "ai", "zod", "@modelcontextprotocol/sdk", "playwright"
]);

describe("dependency budget", () => {
  test("all external runtime deps are allowlisted", async () => {
    const root = join(import.meta.dir, "..");
    const external = new Set<string>();
    for (const pkg of readdirSync(join(root, "packages"))) {
      const file = Bun.file(join(root, "packages", pkg, "package.json"));
      if (!(await file.exists())) continue;
      const manifest = (await file.json()) as {
        dependencies?: Record<string, string>;
      };
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (!dep.startsWith("@op/")) external.add(dep);
      }
    }
    const offenders = [...external].filter((d) => !ALLOWED.has(d));
    expect(offenders).toEqual([]);
    expect(external.size).toBeLessThanOrEqual(ALLOWED.size);
  });
});
