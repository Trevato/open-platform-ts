import { Result, TaggedError, type Log } from "@op/core";
import { type AgentDef, CrewError } from "@op/crew";
import type { GitHost } from "@op/git";
import { DEFAULT_APP_POLICY, type AppPolicy } from "./manifest.ts";

// The platform's OWN config lives in git — repo `plat/platform` — so the running
// platform can be modified by committing to it (the Flux concept), and every
// change is an auditable, revertible commit. This is SEPARATE from `sys/gitops`
// (app desired-state, reconciled by container converge): plat/platform is the
// daemon's behavior, reconciled by re-reading an in-memory cache on push.
//
// Fail-closed by construction: a malformed/invalid commit keeps the last-good
// value in memory and logs it — a bad config degrades to prior behavior, never
// to a dead daemon. Only HOT-reloadable behavior lives here (crew prompts, crew
// tunables). Restart-only items (domain, ports, sovereign key, the reconciler
// itself) are frozen in the binary and are NOT in this repo — structurally
// unreachable by self-modification.
export const PLAT = { owner: "plat", name: "platform" } as const;
// The platform's own SOURCE (the opd monorepo), hosted on itself so the crew
// can author code changes to the daemon — applied by `op upgrade` (self-upgrade)
// or a restart, unlike the hot-reloadable config in plat/platform.
export const OPD = { owner: "plat", name: "opd" } as const;

/** True for a repo that is the platform ITSELF (config or source) rather than a
 *  deployed app — these are proposed to a human, never auto-merged/previewed. */
export function isSelfRepo(owner: string, repo: string): boolean {
  return (
    (owner === PLAT.owner && repo === PLAT.name) ||
    (owner === OPD.owner && repo === OPD.name)
  );
}

export class PlatformConfigError extends TaggedError("PlatformConfigError")<{
  message: string;
}>() {}

export interface PlatformSettings {
  crew: { maxRework: number; sweepMs: number; model: string };
  /** Operator bounds on what any app's op.json may request. */
  apps: AppPolicy;
}

const DEFAULTS: PlatformSettings = {
  crew: { maxRework: 2, sweepMs: 30_000, model: "claude-sonnet-5" },
  apps: DEFAULT_APP_POLICY,
};

// Model IDs/aliases only ("claude-sonnet-5", "opus", "us.anthropic.claude-…") —
// must not start with "-" so a config commit can never smuggle a CLI flag.
const MODEL_RE = /^[a-z0-9][a-z0-9.:-]{0,63}$/;

// Fail-closed validator (the admitSpec analog): reject out-of-range so a bad
// commit can't brick the crew (e.g. maxRework:9999 or sweepMs:1).
export function admitPlatformConfig(
  raw: unknown,
): Result<PlatformSettings, PlatformConfigError> {
  const err = (message: string) =>
    Result.err(new PlatformConfigError({ message }));
  try {
    const o = (raw ?? {}) as {
      crew?: { maxRework?: unknown; sweepMs?: unknown; model?: unknown };
    };
    const crew = o.crew ?? {};
    const maxRework = Number(crew.maxRework ?? DEFAULTS.crew.maxRework);
    const sweepMs = Number(crew.sweepMs ?? DEFAULTS.crew.sweepMs);
    const model = crew.model ?? DEFAULTS.crew.model;
    if (!Number.isInteger(maxRework) || maxRework < 0 || maxRework > 5)
      return err("crew.maxRework must be an integer in 0..5");
    if (!Number.isFinite(sweepMs) || sweepMs < 5_000 || sweepMs > 600_000)
      return err("crew.sweepMs must be a number in 5000..600000");
    if (typeof model !== "string" || !MODEL_RE.test(model))
      return err("crew.model must be a model id like claude-sonnet-5");

    const a = (o as { apps?: Record<string, unknown> }).apps ?? {};
    const d = DEFAULTS.apps;
    const maxMemoryMb = Number(a["maxMemoryMb"] ?? d.maxMemoryMb);
    const maxCpus = Number(a["maxCpus"] ?? d.maxCpus);
    const maxTcpPortsPerApp = Number(
      a["maxTcpPortsPerApp"] ?? d.maxTcpPortsPerApp,
    );
    const maxAssetMb = Number(a["maxAssetMb"] ?? d.maxAssetMb);
    const rawRange = a["tcpPortRange"] ?? d.tcpPortRange;
    if (
      !Number.isInteger(maxMemoryMb) ||
      maxMemoryMb < 64 ||
      maxMemoryMb > 65536
    )
      return err("apps.maxMemoryMb must be an integer in 64..65536");
    if (!Number.isFinite(maxCpus) || maxCpus < 0.1 || maxCpus > 64)
      return err("apps.maxCpus must be a number in 0.1..64");
    if (
      !Number.isInteger(maxTcpPortsPerApp) ||
      maxTcpPortsPerApp < 0 ||
      maxTcpPortsPerApp > 16
    )
      return err("apps.maxTcpPortsPerApp must be an integer in 0..16");
    if (!Number.isInteger(maxAssetMb) || maxAssetMb < 1 || maxAssetMb > 10240)
      return err("apps.maxAssetMb must be an integer in 1..10240");
    if (
      !Array.isArray(rawRange) ||
      rawRange.length !== 2 ||
      !rawRange.every(
        (p) =>
          Number.isInteger(p) &&
          (p as number) >= 1024 &&
          (p as number) <= 65535,
      ) ||
      (rawRange[0] as number) > (rawRange[1] as number)
    )
      return err("apps.tcpPortRange must be [from, to] within 1024..65535");

    const rawHosts = a["assetHosts"] ?? d.assetHosts;
    if (
      !Array.isArray(rawHosts) ||
      rawHosts.length > 32 ||
      !rawHosts.every(
        (h) => typeof h === "string" && /^[a-z0-9.-]{1,253}$/.test(h),
      )
    )
      return err("apps.assetHosts must be ≤ 32 lowercase hostnames");

    return Result.ok({
      crew: { maxRework, sweepMs, model },
      apps: {
        maxMemoryMb,
        maxCpus,
        tcpPortRange: [rawRange[0] as number, rawRange[1] as number],
        maxTcpPortsPerApp,
        maxAssetMb,
        assetHosts: rawHosts as string[],
      },
    });
  } catch (cause) {
    return err(String(cause));
  }
}

export class PlatformConfig {
  private cache: PlatformSettings = DEFAULTS;
  constructor(
    private readonly git: GitHost,
    private readonly log: Log,
  ) {}

  get(): PlatformSettings {
    return this.cache;
  }

  /** Re-read platform.json from git; keep the last-good cache on any error. */
  async reload(): Promise<void> {
    const bytes = await this.git.readFile(
      PLAT.owner,
      PLAT.name,
      "main",
      "platform.json",
    );
    if (bytes.status === "error") {
      this.log.warn("platform.json unreadable — keeping last-good config");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes.value));
    } catch (e) {
      this.log.error("platform.json is not valid JSON — keeping last-good", {
        err: String(e),
      });
      return;
    }
    const admitted = admitPlatformConfig(parsed);
    if (admitted.status === "error") {
      this.log.error("platform.json rejected — keeping last-good", {
        err: admitted.error.message,
      });
      return;
    }
    this.cache = admitted.value;
    this.log.info("platform config reloaded", { crew: this.cache.crew });
  }

  /** Git-backed agent loader (replaces the disk one). Reads the role fresh from
   *  plat/platform on each call, so a prompt edit applies to the next job with
   *  no restart — this is the hot-reload seam for crew behavior. */
  async loadAgent(role: string): Promise<Result<AgentDef, CrewError>> {
    const instr = await this.git.readFile(
      PLAT.owner,
      PLAT.name,
      "main",
      `crew/${role}/instructions.md`,
    );
    if (instr.status === "error")
      return Result.err(
        new CrewError({
          message: `load ${role} instructions: ${instr.error.message}`,
          op: "loadAgent",
        }),
      );
    const files = await this.git.listFiles(PLAT.owner, PLAT.name, "main");
    const skillPaths =
      files.status === "ok"
        ? files.value.filter(
            (p) => p.startsWith(`crew/${role}/skills/`) && p.endsWith(".md"),
          )
        : [];
    const skills: string[] = [];
    for (const p of skillPaths) {
      const s = await this.git.readFile(PLAT.owner, PLAT.name, "main", p);
      if (s.status === "ok") skills.push(new TextDecoder().decode(s.value));
    }
    return Result.ok({
      role,
      instructions: new TextDecoder().decode(instr.value),
      skills,
    });
  }
}

/** The loader signature the crew builder/reviewer accept — production uses
 *  PlatformConfig.loadAgent (git); tests inject a stub. */
export type LoadAgent = (role: string) => Promise<Result<AgentDef, CrewError>>;
