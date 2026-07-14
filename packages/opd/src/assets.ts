import { createHash } from "node:crypto";
import { constants, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Result, TaggedError } from "@op/core";
import type { AppAsset } from "./manifest.ts";

export class AssetError extends TaggedError("AssetError")<{
  message: string;
  asset: string;
}>() {}

export interface ResolvedAsset {
  asset: AppAsset;
  /** Content-addressed cache path. */
  cached: string;
  sha256: string;
  bytes: number;
  downloaded: boolean;
}

// Assets are fetched into a content-addressed cache (<assetsDir>/sha256/<hash>)
// BEFORE the build, so a slow download never happens while the app is down,
// and one download serves every app, preview, and redeploy that names it.
// Unpinned assets are resolved through a URL index (trust-on-first-use): the
// first fetch records the hash; later deploys reuse it. The recorded hash in
// the deploy event is what an author copies into op.json to pin.
export async function ensureAssetsCached(
  assetsDir: string,
  assets: AppAsset[],
  opts: {
    maxBytes: number;
    allowedHosts: string[];
    fetchImpl?: typeof fetch;
    onEvent?: (message: string) => void;
  },
): Promise<Result<ResolvedAsset[], AssetError>> {
  const resolved: ResolvedAsset[] = [];
  for (const asset of assets) {
    const one = await ensureCached(assetsDir, asset, opts);
    if (one.status === "error") return one;
    resolved.push(one.value);
  }
  return Result.ok(resolved);
}

async function ensureCached(
  assetsDir: string,
  asset: AppAsset,
  opts: {
    maxBytes: number;
    allowedHosts: string[];
    fetchImpl?: typeof fetch;
    onEvent?: (message: string) => void;
  },
): Promise<Result<ResolvedAsset, AssetError>> {
  const err = (message: string) =>
    Result.err(new AssetError({ message, asset: asset.dest }));
  const byHash = (hash: string) => join(assetsDir, "sha256", hash);
  const urlIndex = join(
    assetsDir,
    "url",
    createHash("sha256").update(asset.url).digest("hex"),
  );

  // Pinned and already cached → done. Unpinned but seen before → the URL
  // index remembers which content this URL resolved to.
  let expected = asset.sha256 ?? null;
  if (!expected) {
    const remembered = await Bun.file(urlIndex)
      .text()
      .catch(() => null);
    if (remembered && /^[0-9a-f]{64}$/.test(remembered.trim()))
      expected = remembered.trim();
  }
  if (expected) {
    const cached = byHash(expected);
    const st = await stat(cached).catch(() => null);
    if (st?.isFile())
      return Result.ok({
        asset,
        cached,
        sha256: expected,
        bytes: st.size,
        downloaded: false,
      });
  }

  // Fetch, following redirects manually so EVERY hop stays inside the
  // operator's allowlist — the daemon is privileged; this is SSRF surface.
  const doFetch = opts.fetchImpl ?? fetch;
  let url = asset.url;
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return err(`redirect target does not parse: ${url}`);
    }
    if (parsed.protocol !== "https:") return err(`redirect left https: ${url}`);
    if (!opts.allowedHosts.includes(parsed.hostname.toLowerCase()))
      return err(`host ${parsed.hostname} is not in the assetHosts allowlist`);
    opts.onEvent?.(`fetching ${asset.dest} from ${parsed.hostname}`);
    let hopRes: Response;
    try {
      hopRes = await doFetch(url, { redirect: "manual" });
    } catch (cause) {
      return err(`fetch failed: ${String(cause)}`);
    }
    if ([301, 302, 303, 307, 308].includes(hopRes.status)) {
      const location = hopRes.headers.get("location");
      if (!location) return err(`redirect with no location from ${url}`);
      url = new URL(location, url).toString();
      continue;
    }
    res = hopRes;
    break;
  }
  if (res === null) return err("too many redirects");
  if (!res.ok || res.body === null)
    return err(`fetch failed: HTTP ${res.status}`);

  const tmp = join(
    assetsDir,
    `fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(assetsDir, { recursive: true });
  const hash = createHash("sha256");
  let bytes = 0;
  const failed = async (message: string) => {
    await rm(tmp, { force: true });
    return err(message);
  };
  try {
    const sink = Bun.file(tmp).writer();
    for await (const chunk of res.body) {
      bytes += chunk.byteLength;
      if (bytes > opts.maxBytes) {
        await sink.end();
        return await failed(
          `exceeds asset size cap (${Math.round(opts.maxBytes / 1048576)} MB)`,
        );
      }
      hash.update(chunk);
      sink.write(chunk);
    }
    await sink.end();
  } catch (cause) {
    return await failed(`download failed: ${String(cause)}`);
  }
  if (bytes === 0) return await failed("empty response body");

  const sum = hash.digest("hex");
  if (asset.sha256 && sum !== asset.sha256)
    return await failed(
      `sha256 mismatch: expected ${asset.sha256}, got ${sum}`,
    );

  const cached = byHash(sum);
  await mkdir(dirname(cached), { recursive: true });
  try {
    await rename(tmp, cached);
  } catch (cause) {
    return await failed(`cache rename failed: ${String(cause)}`);
  }
  await mkdir(dirname(urlIndex), { recursive: true });
  await Bun.write(urlIndex, sum);
  opts.onEvent?.(
    `fetched ${asset.dest} (${(bytes / 1048576).toFixed(1)} MB) sha256=${sum}`,
  );
  return Result.ok({ asset, cached, sha256: sum, bytes, downloaded: true });
}

/** Place cached assets into the app's data dir. Copy-on-write clones where the
 *  filesystem supports them (APFS/btrfs/XFS), real copies elsewhere — never
 *  hardlinks, so an app rewriting its /data copy can't poison the cache.
 *  Skips a dest whose content already matches. */
export async function placeAssets(
  dataDir: string,
  resolved: ResolvedAsset[],
): Promise<Result<string[], AssetError>> {
  const root = resolve(dataDir);
  const placed: string[] = [];
  for (const r of resolved) {
    const err = (message: string) =>
      Result.err(new AssetError({ message, asset: r.asset.dest }));
    // Admission validated dest, but the jail must hold on its own here too.
    const target = resolve(join(root, r.asset.dest));
    if (target !== root && !target.startsWith(root + sep))
      return err(`dest escapes data dir: ${r.asset.dest}`);

    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && existing.size === r.bytes) {
      const sum = await sha256File(target);
      if (sum === r.sha256) continue; // already in place
    }
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.op-place`;
    try {
      await copyFile(r.cached, tmp, constants.COPYFILE_FICLONE);
      await rename(tmp, target);
    } catch (cause) {
      await rm(tmp, { force: true });
      return err(`place failed: ${String(cause)}`);
    }
    placed.push(r.asset.dest);
  }
  return Result.ok(placed);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}
