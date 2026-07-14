import { join, normalize } from "node:path";
import { isValidName, Result } from "@op/core";
import { PolicyViolation } from "./policy.ts";

// An app's own requirements, declared in `op.json` at the app REPO root —
// beside its Dockerfile, authored by whoever writes the app (human or crew).
// This is deliberately separate from app.json in sys/gitops: the operator spec
// says WHERE an app runs (owner, repo, ref); the manifest says what the app
// NEEDS (resources, raw TCP ports, assets). Living in the app repo means it
// travels with the code — through forks, previews, and mitosis — and the
// platform can derive facts about every app by reading repo heads.
export interface AppManifest {
  resources: { memoryMb?: number; cpus?: number };
  /** Container-side raw TCP ports to expose publicly (e.g. 25565). Each gets
   *  a stable public port from the platform's range, relayed by the TCP gate. */
  tcpPorts: number[];
  /** Files fetched into the app's data dir before the container starts. */
  assets: AppAsset[];
  /** What this app offers peers — documentation-grade, non-binding. Labels
   *  for the integration map, the composer, and runtime discovery. */
  provides: Array<{ name: string; path: string; description: string }>;
  /** Concrete peer apps this app calls. Drives wiring: each peer's URL is
   *  injected as OP_PEER_<APP>_URL and its host resolves in-container. */
  consumes: Array<{ owner: string | null; app: string }>;
}

export interface AppAsset {
  url: string; // https only
  dest: string; // relative path inside /data, jailed
  sha256?: string; // optional integrity pin; computed + recorded either way
}

/** Platform-operator bounds for what any manifest may request. Lives in
 *  plat/platform platform.json (hot-reloadable), enforced at admission. */
export interface AppPolicy {
  maxMemoryMb: number;
  maxCpus: number;
  tcpPortRange: [number, number];
  maxTcpPortsPerApp: number;
  maxAssetMb: number;
  /** Hosts the daemon may fetch assets from. Empty = assets denied — platform-
   *  side egress must be opted into by a sovereign commit to platform.json. */
  assetHosts: string[];
}

export const DEFAULT_APP_POLICY: AppPolicy = {
  maxMemoryMb: 2048,
  maxCpus: 2,
  tcpPortRange: [25500, 25599],
  maxTcpPortsPerApp: 4,
  maxAssetMb: 512,
  assetHosts: [],
};

export const EMPTY_MANIFEST: AppManifest = {
  resources: {},
  tcpPorts: [],
  assets: [],
  provides: [],
  consumes: [],
};

/** The env var a consumer reads a peer's URL from: OP_PEER_<APP>_URL. */
export function envNameFor(app: string): string {
  return `OP_PEER_${app.toUpperCase().replaceAll("-", "_")}_URL`;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** True when `dest` stays inside the data dir: relative, normalized, no
 *  escapes. The jail is the whole security story for asset placement. */
export function isSafeDest(dest: string): boolean {
  if (dest.length === 0 || dest.length > 200) return false;
  if (dest.startsWith("/") || dest.includes("\\") || dest.includes("\0"))
    return false;
  const norm = normalize(dest);
  return !norm.startsWith("..") && !norm.startsWith("/") && norm !== ".";
}

// The admitSpec analog for op.json — fail closed. A manifest that doesn't
// parse cleanly or exceeds platform policy never deploys; the violation is
// surfaced as the app's error status so the author sees exactly why.
export function admitManifest(
  raw: unknown,
  policy: AppPolicy,
): Result<AppManifest, PolicyViolation> {
  const deny = (reason: string) =>
    Result.err(new PolicyViolation({ reason, subject: "op.json" }));

  if (raw === undefined || raw === null) return Result.ok(EMPTY_MANIFEST);
  if (typeof raw !== "object") return deny("manifest is not an object");
  const m = raw as Record<string, unknown>;

  const resources: AppManifest["resources"] = {};
  if (m["resources"] !== undefined) {
    if (typeof m["resources"] !== "object" || m["resources"] === null)
      return deny("resources must be an object");
    const r = m["resources"] as Record<string, unknown>;
    if (r["memoryMb"] !== undefined) {
      const mem = r["memoryMb"];
      if (typeof mem !== "number" || !Number.isInteger(mem) || mem < 64)
        return deny("resources.memoryMb must be an integer ≥ 64");
      if (mem > policy.maxMemoryMb)
        return deny(
          `resources.memoryMb ${mem} exceeds platform max ${policy.maxMemoryMb}`,
        );
      resources.memoryMb = mem;
    }
    if (r["cpus"] !== undefined) {
      const cpus = r["cpus"];
      if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus < 0.1)
        return deny("resources.cpus must be a number ≥ 0.1");
      if (cpus > policy.maxCpus)
        return deny(
          `resources.cpus ${cpus} exceeds platform max ${policy.maxCpus}`,
        );
      resources.cpus = cpus;
    }
  }

  const tcpPorts: number[] = [];
  if (m["tcpPorts"] !== undefined) {
    if (!Array.isArray(m["tcpPorts"])) return deny("tcpPorts must be an array");
    if (m["tcpPorts"].length > policy.maxTcpPortsPerApp)
      return deny(
        `tcpPorts: at most ${policy.maxTcpPortsPerApp} ports per app`,
      );
    for (const p of m["tcpPorts"]) {
      if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535)
        return deny("tcpPorts entries must be ports 1..65535");
      if (tcpPorts.includes(p)) return deny(`tcpPorts: duplicate port ${p}`);
      tcpPorts.push(p);
    }
  }

  const assets: AppAsset[] = [];
  if (m["assets"] !== undefined) {
    if (!Array.isArray(m["assets"])) return deny("assets must be an array");
    if (m["assets"].length > 8) return deny("assets: at most 8 per app");
    for (const a of m["assets"]) {
      if (typeof a !== "object" || a === null)
        return deny("assets entries must be objects");
      const asset = a as Record<string, unknown>;
      const url = asset["url"];
      if (typeof url !== "string") return deny("asset url must be a string");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return deny(`asset url does not parse: ${url}`);
      }
      if (parsed.protocol !== "https:")
        return deny(`asset url must be https: ${url}`);
      if (!policy.assetHosts.includes(parsed.hostname.toLowerCase()))
        return deny(
          `asset host ${parsed.hostname} is not in the platform's assetHosts allowlist`,
        );
      const dest = asset["dest"];
      if (typeof dest !== "string" || !isSafeDest(dest))
        return deny(`asset dest must be a safe relative path: ${String(dest)}`);
      if (assets.some((x) => x.dest === normalize(dest)))
        return deny(`assets: duplicate dest ${dest}`);
      const sha256 = asset["sha256"];
      if (sha256 !== undefined) {
        if (typeof sha256 !== "string" || !SHA256_RE.test(sha256))
          return deny("asset sha256 must be 64 lowercase hex chars");
      }
      assets.push({
        url,
        dest: normalize(dest),
        ...(typeof sha256 === "string" ? { sha256 } : {}),
      });
    }
  }

  const provides: AppManifest["provides"] = [];
  if (m["provides"] !== undefined) {
    if (!Array.isArray(m["provides"])) return deny("provides must be an array");
    if (m["provides"].length > 8) return deny("provides: at most 8 entries");
    for (const p of m["provides"]) {
      if (typeof p !== "object" || p === null)
        return deny("provides entries must be objects");
      const cap = p as Record<string, unknown>;
      const name = cap["name"];
      if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name))
        return deny("provides name must be lowercase kebab, ≤ 32 chars");
      const path = cap["path"];
      if (
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.length > 200
      )
        return deny(`provides path must start with /: ${String(path)}`);
      const description = cap["description"];
      if (typeof description !== "string" || description.length > 200)
        return deny("provides description must be a string ≤ 200 chars");
      if (provides.some((x) => x.name === name))
        return deny(`provides: duplicate name ${name}`);
      provides.push({ name, path, description });
    }
  }

  const consumes: AppManifest["consumes"] = [];
  if (m["consumes"] !== undefined) {
    if (!Array.isArray(m["consumes"])) return deny("consumes must be an array");
    if (m["consumes"].length > 16) return deny("consumes: at most 16 entries");
    const envNames = new Set<string>();
    for (const c of m["consumes"]) {
      if (typeof c !== "object" || c === null)
        return deny("consumes entries must be objects");
      const peer = c as Record<string, unknown>;
      const app = peer["app"];
      if (typeof app !== "string" || !isValidName(app))
        return deny(`consumes app must be a valid name: ${String(app)}`);
      const owner = peer["owner"];
      if (
        owner !== undefined &&
        (typeof owner !== "string" || !isValidName(owner))
      )
        return deny(`consumes owner must be a valid name: ${String(owner)}`);
      // One env name, one peer: OP_PEER_<APP>_URL collides across owners.
      const env = envNameFor(app);
      if (envNames.has(env))
        return deny(`consumes: duplicate peer env name ${env}`);
      envNames.add(env);
      consumes.push({ owner: typeof owner === "string" ? owner : null, app });
    }
  }

  return Result.ok({ resources, tcpPorts, assets, provides, consumes });
}

/** Read + admit op.json from a checked-out app repo. Absent file → the empty
 *  manifest (an app need not declare anything). Malformed → PolicyViolation. */
export async function readManifest(
  srcDir: string,
  policy: AppPolicy,
): Promise<Result<AppManifest, PolicyViolation>> {
  const file = Bun.file(join(srcDir, "op.json"));
  if (!(await file.exists())) return Result.ok(EMPTY_MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (cause) {
    return Result.err(
      new PolicyViolation({
        reason: `op.json is not valid JSON: ${String(cause)}`,
        subject: "op.json",
      }),
    );
  }
  return admitManifest(raw, policy);
}
