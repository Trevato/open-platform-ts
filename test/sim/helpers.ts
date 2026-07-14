// Shared harness plumbing: polling, one waited happy-path ship, and teardown
// hygiene. Factored out of test/m1.e2e.test.ts's patterns (phase budgets,
// until() polling, the create-app→serve loop) so the sim runner reuses them
// without touching m1. Nothing here judges correctness — that is invariants.ts.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Platform } from "@op/opd";
import type {
  Actor,
  PlatformTarget,
  RegisteredApp,
  World,
} from "./personas.ts";

/** Poll `fn` until it returns non-null or the deadline passes. */
export async function until<T>(
  what: string,
  deadlineMs: number,
  fn: () => Promise<T | null>,
): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const out = await fn().catch(() => null);
    if (out !== null) return out;
    if (performance.now() - t0 > deadlineMs)
      throw new Error(`timeout waiting for ${what} (${deadlineMs}ms)`);
    await Bun.sleep(200);
  }
}

/** A per-run state root under $HOME — VM-backed engines (colima, Docker
 *  Desktop) only bind-mount paths under $HOME, so app data dirs must live here
 *  (a /var/folders tmpdir mounts empty and the app crash-loops). Mirrors m1. */
export async function runRoot(prefix: string): Promise<string> {
  const parent = join(homedir(), ".op-sim");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, `${prefix}-`));
}

/**
 * The one WAITED happy-path deploy the runner does up front: create an app via
 * the API, then poll its public host until it serves a JSON data round-trip.
 * Guarantees the workload always has ≥1 running app (real deploy events, a live
 * container, a public subdomain) before personas and invariants start. Registers
 * the app in the shared world so cross-tenant personas can target it.
 */
export async function shipAndServe(
  target: PlatformTarget,
  actor: Actor,
  appName: string,
  world: World,
  deadlineMs = 90_000,
): Promise<RegisteredApp> {
  const created = await fetch(`${target.api}/api/v1/apps`, {
    method: "POST",
    tls: { ca: target.caPem },
    headers: {
      authorization: `Basic ${btoa(actor.auth)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: appName }),
  });
  if (created.status !== 201)
    throw new Error(
      `shipAndServe(${appName}): create -> ${created.status} ${await created.text()}`,
    );
  const host = `${appName}-${actor.username}.${target.domain}`;
  const app: RegisteredApp = { owner: actor.username, app: appName, host };
  world.recordApp(app);
  await until(`${host} to serve`, deadlineMs, async () => {
    const res = await fetch(`https://${host}:${target.httpsPort}/`, {
      tls: { ca: target.caPem },
      headers: { accept: "application/json" },
    });
    if (res.status !== 200) return null;
    const body = (await res.json().catch(() => null)) as {
      visits?: number;
    } | null;
    return body?.visits !== undefined ? body : null;
  });
  return app;
}

/** Remove every container this platform launched. Idempotent; safe in cleanup. */
export async function removeAllPlatformContainers(
  platform: Platform,
): Promise<number> {
  const list = await platform.engine.listPlatformContainers(
    platform.platformId,
  );
  if (list.status !== "ok") return 0;
  let n = 0;
  for (const c of list.value) {
    const r = await platform.engine.stopAndRemove(c.id);
    if (r.status === "ok") n++;
  }
  return n;
}
