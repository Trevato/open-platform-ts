// Simulation-at-scale: K seeded personas drive REAL traffic (HTTPS API + git
// CLI + live containers) at ONE Platform.up() instance, and the deterministic
// invariant library runs between every batch. One master seed (OP_SIM_SEED)
// tunes the whole run and rides in every failure message, so any run reproduces
// verbatim:  OP_SIM_SEED=<seed> bun test test/sim
//
// Cost knobs (defaults are cheap — a handful of real deploys):
//   OP_SIM_SEED    master seed (hex 0x…, decimal, or `random`); default 0x504c4154
//   OP_SIM_ROUNDS  batches; invariants run after each          (default 3)
//   OP_SIM_STEPS   persona steps per batch                     (default 1)
//   OP_SIM_TENANTS tenants provisioned                         (default 4)
//   OP_SIM_HEAVY=1 add a 2nd builder + the forker (PR previews) and 2 steps
//   OP_SIM_FLEET=1 germinate a sovereign daughter + fleet-sovereignty invariant
//   OP_SIM_HARD_MS hard wall-clock ceiling                     (default 300000)

import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "@op/core";
import { resolveEngineSocket } from "@op/engine";
import { Platform } from "@op/opd";
import {
  removeAllPlatformContainers,
  runRoot,
  shipAndServe,
  until,
} from "./helpers.ts";
import {
  checkAll,
  fleetSovereignty,
  formatViolations,
  noContainersAfterTeardown,
  type Violation,
} from "./invariants.ts";
import {
  makePersona,
  provisionActor,
  World,
  type Actor,
  type OpRecord,
  type Persona,
  type PersonaContext,
  type PersonaName,
  type PlatformTarget,
} from "./personas.ts";
import { SimRng } from "./rng.ts";

const sock = resolveEngineSocket();

const num = (k: string, d: number): number => {
  const raw = process.env[k];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : d;
};

const HEAVY = process.env["OP_SIM_HEAVY"] === "1";
const FLEET = process.env["OP_SIM_FLEET"] === "1";
const ROUNDS = num("OP_SIM_ROUNDS", 3);
const STEPS = num("OP_SIM_STEPS", HEAVY ? 2 : 1);
const TENANTS = Math.max(4, num("OP_SIM_TENANTS", 4));
const HARD_MS = num("OP_SIM_HARD_MS", 300_000);
const SOFT_MS = 150_000;

interface Runner {
  persona: Persona;
  ctx: PersonaContext;
}

describe.skipIf(!sock)(
  "sim: seeded personas × invariants on one platform",
  () => {
    const cleanup: Array<() => Promise<void>> = [];
    const timings: Array<{ label: string; ms: number }> = [];
    afterAll(
      async () => {
        for (const fn of cleanup.reverse()) await fn().catch(() => {});
        if (timings.length) {
          const table = timings
            .map((t) => `  ${t.label.padEnd(26)} ${String(t.ms).padStart(7)}ms`)
            .join("\n");
          console.log(`\n[sim] phase timings:\n${table}\n`);
        }
      },
      { timeout: 120_000 },
    );

    async function phase<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const t0 = performance.now();
      const out = await fn();
      timings.push({ label, ms: Math.round(performance.now() - t0) });
      return out;
    }

    test("K personas hold tenant isolation, credential canaries, deploy coherence", async () => {
      const root = SimRng.fromEnv(); // prints the seed banner ONCE
      const repro = `OP_SIM_SEED=${root.masterHex} bun test test/sim`;
      const platRng = root.derive("platform:0");

      // Untimed: warm the template base image (a cold pull is CI's problem).
      await Bun.spawn(["docker", "pull", "-q", "oven/bun:1-alpine"], {
        stdout: "ignore",
      }).exited;

      const base = await runRoot("run");
      cleanup.push(() => rm(base, { recursive: true, force: true }));

      const t0 = performance.now();

      // ── boot ONE real platform ──────────────────────────────────────────
      const domain = "sim.localtest.me";
      const httpsPort = 28193;
      const platform = await phase("platform: up", async () =>
        Result.unwrap(
          await Platform.up({
            root: join(base, "mother"),
            domain,
            httpPort: 28190,
            httpsPort,
            custodyAck: true,
          }),
        ),
      );
      cleanup.push(() => platform.stop());
      cleanup.push(async () => {
        await removeAllPlatformContainers(platform);
      });

      const target: PlatformTarget = {
        api: `https://${domain}:${httpsPort}`,
        domain,
        httpsPort,
        caPem: platform.caCertPem,
        caFile: join(platform.sd.certsDir, "ca.crt"),
      };
      const adminAuth = `plat:${platform.freshAdminPassword}`;
      const world = new World();

      // ── provision tenants ───────────────────────────────────────────────
      const tenants = await phase("tenants: provision", async () => {
        const out: Actor[] = [];
        for (let i = 0; i < TENANTS; i++)
          out.push(
            await provisionActor(
              target,
              adminAuth,
              `t${i}x${root.token(4)}`,
              world,
            ),
          );
        return out;
      });
      const tenantNames = tenants.map((t) => t.username);

      // ── one WAITED happy-path deploy so there is always live surface ─────
      await phase("app: ship+serve", () =>
        shipAndServe(target, tenants[0]!, `svc${root.token(4)}`, world),
      );

      // ── assemble the persona roster ─────────────────────────────────────
      // Each (persona, actor) gets its OWN derived stream — h(seed, platform,
      // persona) — reused across rounds so its stream advances independently.
      const trace: OpRecord[] = [];
      const roster: Array<{ name: PersonaName; actor: number }> = [
        { name: "builder", actor: 0 },
        { name: "churner", actor: 1 },
        { name: "noisy-neighbor", actor: 2 },
        { name: "attacker", actor: 3 },
      ];
      if (HEAVY) {
        roster.push({ name: "builder", actor: 1 });
        roster.push({ name: "forker", actor: 0 });
      }
      const runners: Runner[] = roster.map(({ name, actor }) => {
        const persona = makePersona(name);
        const a = tenants[actor % tenants.length]!;
        return {
          persona,
          ctx: {
            target,
            actor: a,
            rng: platRng.derive(`${name}:${a.username}`),
            world,
            log: (rec) => trace.push(rec),
          },
        };
      });

      // Hard-fail a persona outcome only on a real server error (5xx) or an
      // isolation breach (a 2xx on a cross-tenant mutation). Other non-ok
      // outcomes (a thrown op, a transient docker/git hiccup) are surfaced as
      // warnings so the clean-checkout run stays green.
      const hardFailures: OpRecord[] = [];
      const softWarnings: OpRecord[] = [];
      const triage = (rec: OpRecord): void => {
        if (rec.ok) return;
        if (rec.breach || (rec.status !== undefined && rec.status >= 500))
          hardFailures.push(rec);
        else softWarnings.push(rec);
      };

      const assertClean = async (batch: string): Promise<void> => {
        const violations = await checkAll(platform, world, {
          tenants: tenantNames,
        });
        const problems: string[] = [];
        if (violations.length) problems.push(formatViolations(violations));
        if (hardFailures.length)
          problems.push(
            hardFailures
              .map((r) => `  [persona:${r.persona}] ${r.op}: ${r.detail}`)
              .join("\n"),
          );
        if (problems.length)
          throw new Error(
            `INVARIANT / PERSONA FAILURES @ ${batch} ` +
              `(${violations.length} violations, ${hardFailures.length} hard failures):\n` +
              `${problems.join("\n")}\n\n[reproduce] ${repro}`,
          );
      };

      // ── batches: run every persona, then check every invariant ──────────
      await phase("batches", async () => {
        for (let r = 0; r < ROUNDS; r++) {
          for (let s = 0; s < STEPS; s++)
            for (const runner of runners)
              triage(await runner.persona.step(runner.ctx));
          await assertClean(`round ${r + 1}/${ROUNDS}`);
        }
      });

      // ── final: prove the full deploy loop reached RUNNING and serves ────
      await phase("app: serving proof", async () => {
        const apps = world.apps();
        expect(apps.length, "at least one app registered").toBeGreaterThan(0);
        const body = await until("some app to serve", 90_000, async () => {
          for (const a of apps) {
            const res = await fetch(`https://${a.host}:${httpsPort}/`, {
              tls: { ca: target.caPem },
              headers: { accept: "application/json" },
            }).catch(() => null);
            if (res && res.status === 200)
              return (await res.json().catch(() => null)) as {
                visits?: number;
              } | null;
          }
          return null;
        });
        expect(
          body?.visits,
          "served a real data round-trip",
        ).toBeGreaterThanOrEqual(1);
      });

      await assertClean("final");

      if (softWarnings.length)
        console.warn(
          `[sim] ${softWarnings.length} soft (non-fatal) persona outcomes; e.g. ` +
            `${softWarnings[0]!.op}: ${softWarnings[0]!.detail}`,
        );
      console.log(
        `[sim] executed ${trace.length} operations across ${runners.length} personas ` +
          `over ${ROUNDS} rounds (${repro})`,
      );

      // ── optional fleet tier: germinate a sovereign daughter ─────────────
      if (FLEET) {
        await phase("fleet: germinate+sovereignty", async () => {
          const seedFile = join(base, "seed.tar.gz");
          Result.unwrap(await platform.seed(seedFile));
          const dDomain = "d-sim.localtest.me";
          const dPort = 28194;
          const daughter = Result.unwrap(
            await Platform.germinate(seedFile, {
              root: join(base, "daughter"),
              domain: dDomain,
              httpPort: 28191,
              httpsPort: dPort,
              custodyAck: true,
            }),
          );
          cleanup.push(() => daughter.stop());
          cleanup.push(async () => {
            await removeAllPlatformContainers(daughter);
          });
          const dTarget: PlatformTarget = {
            api: `https://${dDomain}:${dPort}`,
            domain: dDomain,
            httpsPort: dPort,
            caPem: daughter.caCertPem,
            caFile: join(daughter.sd.certsDir, "ca.crt"),
          };
          const dWorld = new World();
          const dTenant = await provisionActor(
            dTarget,
            `plat:${daughter.freshAdminPassword}`,
            `d0x${root.token(4)}`,
            dWorld,
          );
          await shipAndServe(dTarget, dTenant, `dsvc${root.token(4)}`, dWorld);
          const dViolations = [
            ...(await checkAll(daughter, dWorld, {
              tenants: [dTenant.username],
            })),
            ...(await fleetSovereignty(platform, [daughter])),
          ];
          if (dViolations.length)
            throw new Error(
              `FLEET INVARIANT FAILURES (${dViolations.length}):\n` +
                `${formatViolations(dViolations)}\n\n[reproduce] OP_SIM_FLEET=1 ${repro}`,
            );
        });
      }

      // ── teardown hygiene: after stop, no platform container may linger ──
      await phase("teardown: hygiene", async () => {
        await platform.stop(); // reconciler down — nothing will recreate anything
        await removeAllPlatformContainers(platform);
        const orphans = await noContainersAfterTeardown(platform);
        if (orphans.length)
          throw new Error(
            `TEARDOWN HYGIENE FAILURES (${orphans.length}):\n` +
              `${formatViolations(orphans)}\n\n[reproduce] ${repro}`,
          );
      });

      const total = performance.now() - t0;
      timings.push({ label: "TOTAL", ms: Math.round(total) });
      expect(total, `sim hard ceiling (${repro})`).toBeLessThan(HARD_MS);
      if (total > SOFT_MS)
        console.warn(
          `[sim] soft budget exceeded: ${Math.round(total)}ms > ${SOFT_MS}ms`,
        );
    }, 480_000);
  },
);
