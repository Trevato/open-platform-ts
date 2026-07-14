// SimRng — the single source of entropy for the simulation harness.
//
// Deterministic-simulation-testing canon (FoundationDB → TigerBeetle's VOPR →
// Antithesis): ONE master seed tunes every workload and fault decision, and
// `seed + commit` replays the exact run. This is that seed.
//
//   - splitmix64 core: a 64-bit state advanced by the golden-ratio constant,
//     finalized through the standard mix. Tiny, fast, well-distributed, and
//     trivially reproducible across machines (pure BigInt, no platform floats).
//   - derive(key): a per-actor / per-platform child stream whose seed is a pure
//     function of (masterSeed, key) — NOT of how far the parent has advanced —
//     so `rng.derive("platform:0").derive("builder:ada")` is stable no matter
//     what any sibling stream did. This is the h(masterSeed, platformIdx,
//     personaIdx) the scout report calls for.
//   - the master seed is printed once at run start and rides in `.label`, which
//     every failure message embeds: paste `OP_SIM_SEED=0x…` back to reproduce.
//
// Set OP_SIM_SEED=0x<hex> | <decimal> | random to steer a run.

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const TWO53 = 9007199254740992; // 2**53

// splitmix64 finalizer.
function mix64(z0: bigint): bigint {
  let z = z0 & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

// FNV-1a (64-bit) over a key string — decorrelates derive() child seeds.
function fnv1a64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) & MASK64;
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

// A recognizable, fixed default so an unconfigured run is still reproducible:
// 0x504c4154 == "PLAT".
const DEFAULT_SEED = 0x504c4154n;

// Crockford-ish base32 (matches @op/core ids): URL/filename/DNS-safe.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function parseSeed(raw: string): bigint {
  // BigInt() parses both "0x…" hex and plain decimal.
  return BigInt(raw.trim()) & MASK64;
}

function randomSeed(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v & MASK64;
}

let bannerPrinted = false;

export interface WeightedEntry<T> {
  value: T;
  weight: number;
}

export class SimRng {
  private state: bigint;

  /** Seed of THIS stream (derived streams differ from the master). */
  readonly seed: bigint;
  /** The run's master seed — what you set as OP_SIM_SEED to reproduce. */
  readonly master: bigint;
  /** Derivation path, e.g. "root/platform:0/builder:ada". */
  readonly path: string;

  constructor(seed: bigint, path = "root", master?: bigint) {
    this.seed = seed & MASK64;
    this.state = this.seed;
    this.master = (master ?? seed) & MASK64;
    this.path = path;
  }

  /**
   * Resolve the master seed from OP_SIM_SEED (hex `0x…`, decimal, or `random`)
   * or fall back to the fixed default, and print the banner ONCE so the seed is
   * on the record before anything can fail. Every run starts here.
   */
  static fromEnv(opts?: { silent?: boolean }): SimRng {
    const raw = process.env["OP_SIM_SEED"];
    let seed: bigint;
    let origin: string;
    if (raw === undefined || raw.trim() === "") {
      seed = DEFAULT_SEED;
      origin = "default";
    } else if (raw.trim().toLowerCase() === "random") {
      seed = randomSeed();
      origin = "random";
    } else {
      seed = parseSeed(raw);
      origin = "env";
    }
    const rng = new SimRng(seed, "root");
    if (!opts?.silent && !bannerPrinted) {
      bannerPrinted = true;
      // eslint-disable-next-line no-console
      console.log(
        `\n[sim] master seed OP_SIM_SEED=0x${seed.toString(16)} (${origin}) — ` +
          `re-run with this to reproduce\n`,
      );
    }
    return rng;
  }

  /** Hex form of the master seed, ready to paste as OP_SIM_SEED. */
  get masterHex(): string {
    return `0x${this.master.toString(16)}`;
  }

  /** The reproduction handle carried into every failure message. */
  get label(): string {
    return `OP_SIM_SEED=${this.masterHex} path=${this.path}`;
  }

  /**
   * An independent child stream seeded from (masterSeed, key). Deterministic and
   * order-independent: sibling derivations never influence each other, and the
   * parent's own draws do not shift the child. This is how each platform / actor
   * / persona gets its own repeatable entropy.
   */
  derive(key: string): SimRng {
    const childSeed = mix64(this.seed + fnv1a64(key));
    const childPath = this.path === "root" ? key : `${this.path}/${key}`;
    return new SimRng(childSeed, childPath, this.master);
  }

  /** Next raw 64-bit value. */
  u64(): bigint {
    this.state = (this.state + GOLDEN) & MASK64;
    return mix64(this.state);
  }

  /** Next 32-bit unsigned integer. */
  u32(): number {
    return Number(this.u64() >> 32n);
  }

  /** Uniform float in [0, 1) with full 53-bit mantissa. */
  float(): number {
    return Number(this.u64() >> 11n) / TWO53;
  }

  /** Uniform integer in [0, nExclusive). Returns 0 for n <= 0. */
  int(nExclusive: number): number {
    if (nExclusive <= 1) return 0;
    return Number(this.u64() % BigInt(nExclusive));
  }

  /** Uniform integer in [min, max] inclusive. */
  between(min: number, max: number): number {
    if (max <= min) return min;
    return min + this.int(max - min + 1);
  }

  /** True with probability p (default 0.5). */
  bool(p = 0.5): boolean {
    return this.float() < p;
  }

  /** A uniformly chosen element. Throws (with the seed) on an empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0)
      throw new Error(`pick() on empty array [${this.label}]`);
    return items[this.int(items.length)] as T;
  }

  /** Weighted choice. Entries with weight <= 0 are ignored. */
  weighted<T>(entries: readonly WeightedEntry<T>[]): T {
    const live = entries.filter((e) => e.weight > 0);
    if (live.length === 0)
      throw new Error(`weighted() with no positive weights [${this.label}]`);
    const total = live.reduce((s, e) => s + e.weight, 0);
    let t = this.float() * total;
    for (const e of live) {
      t -= e.weight;
      if (t < 0) return e.value;
    }
    return live[live.length - 1]!.value;
  }

  /** A new array, Fisher-Yates shuffled. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** A deterministic base32 token — reproducible ids for apps/branches/etc. */
  token(len = 8): string {
    let out = "";
    let bits = 0n;
    let have = 0;
    while (out.length < len) {
      if (have < 5) {
        bits = (bits << 64n) | this.u64();
        have += 64;
      }
      have -= 5;
      out += ALPHABET[Number((bits >> BigInt(have)) & 31n)];
    }
    return out;
  }

  /** A deterministic name like `app-7k3q9m`. */
  name(prefix: string): string {
    return `${prefix}-${this.token(6)}`;
  }

  /** Throw with the reproduction handle appended — for callers that assert. */
  fail(message: string): never {
    throw new Error(`${message} [${this.label}]`);
  }
}
