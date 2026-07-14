import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAssetsCached, placeAssets } from "../src/assets.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function stubFetch(routes: Record<string, () => Response>): typeof fetch {
  let calls = 0;
  const impl = (async (input: string | URL | Request) => {
    calls++;
    const url = String(input);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  }) as typeof fetch;
  (impl as unknown as { calls: () => number }).calls = () => calls;
  return impl;
}

async function dirs(): Promise<{ cache: string; data: string }> {
  return {
    cache: await mkdtemp(join(tmpdir(), "op-assets-cache-")),
    data: await mkdtemp(join(tmpdir(), "op-assets-data-")),
  };
}

const OPTS = (fetchImpl: typeof fetch, hosts = ["example.com"]) => ({
  maxBytes: 1024 * 1024,
  allowedHosts: hosts,
  fetchImpl,
});

describe("ensureAssetsCached", () => {
  test("fetches once, then serves pinned re-deploys from cache", async () => {
    const { cache } = await dirs();
    const body = "jar-bytes";
    const fetchImpl = stubFetch({
      "https://example.com/server.jar": () => new Response(body),
    });
    const asset = {
      url: "https://example.com/server.jar",
      dest: "server.jar",
      sha256: sha(body),
    };

    const first = await ensureAssetsCached(cache, [asset], OPTS(fetchImpl));
    expect(first.status).toBe("ok");
    if (first.status === "ok") {
      expect(first.value[0]?.downloaded).toBe(true);
      expect(first.value[0]?.sha256).toBe(sha(body));
    }
    const second = await ensureAssetsCached(cache, [asset], OPTS(fetchImpl));
    expect(second.status).toBe("ok");
    if (second.status === "ok") expect(second.value[0]?.downloaded).toBe(false);
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(1);
  });

  test("unpinned assets fetch once via the URL index (TOFU)", async () => {
    const { cache } = await dirs();
    const fetchImpl = stubFetch({
      "https://example.com/x.bin": () => new Response("content"),
    });
    const asset = { url: "https://example.com/x.bin", dest: "x.bin" };

    const first = await ensureAssetsCached(cache, [asset], OPTS(fetchImpl));
    expect(first.status).toBe("ok");
    const second = await ensureAssetsCached(cache, [asset], OPTS(fetchImpl));
    expect(second.status).toBe("ok");
    if (second.status === "ok") expect(second.value[0]?.downloaded).toBe(false);
    expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(1);
  });

  test("sha mismatch fails the deploy and caches nothing", async () => {
    const { cache } = await dirs();
    const fetchImpl = stubFetch({
      "https://example.com/evil.jar": () => new Response("tampered"),
    });
    const bad = await ensureAssetsCached(
      cache,
      [
        {
          url: "https://example.com/evil.jar",
          dest: "evil.jar",
          sha256: sha("expected"),
        },
      ],
      OPTS(fetchImpl),
    );
    expect(bad.status).toBe("error");
    if (bad.status === "error")
      expect(bad.error.message).toContain("sha256 mismatch");
  });

  test("every redirect hop must stay inside the allowlist", async () => {
    const { cache } = await dirs();
    const fetchImpl = stubFetch({
      "https://example.com/hop": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.org/x" },
        }),
    });
    const escaped = await ensureAssetsCached(
      cache,
      [{ url: "https://example.com/hop", dest: "x" }],
      OPTS(fetchImpl),
    );
    expect(escaped.status).toBe("error");
    if (escaped.status === "error")
      expect(escaped.error.message).toContain("allowlist");
  });

  test("size cap aborts the download", async () => {
    const { cache } = await dirs();
    const fetchImpl = stubFetch({
      "https://example.com/big": () => new Response("x".repeat(2048)),
    });
    const over = await ensureAssetsCached(
      cache,
      [{ url: "https://example.com/big", dest: "big" }],
      { maxBytes: 1024, allowedHosts: ["example.com"], fetchImpl },
    );
    expect(over.status).toBe("error");
    if (over.status === "error")
      expect(over.error.message).toContain("size cap");
  });
});

describe("placeAssets", () => {
  test("places into /data, skips when content already matches", async () => {
    const { cache, data } = await dirs();
    const body = "world-seed";
    const fetchImpl = stubFetch({
      "https://example.com/seed": () => new Response(body),
    });
    const cached = await ensureAssetsCached(
      cache,
      [{ url: "https://example.com/seed", dest: "mc/seed.bin" }],
      OPTS(fetchImpl),
    );
    expect(cached.status).toBe("ok");
    if (cached.status !== "ok") return;

    const placed = await placeAssets(data, cached.value);
    expect(placed.status).toBe("ok");
    if (placed.status === "ok") expect(placed.value).toEqual(["mc/seed.bin"]);
    expect(await Bun.file(join(data, "mc/seed.bin")).text()).toBe(body);

    const again = await placeAssets(data, cached.value);
    expect(again.status).toBe("ok");
    if (again.status === "ok") expect(again.value).toEqual([]); // no-op

    // The placed copy is independent: rewriting it never poisons the cache.
    await Bun.write(join(data, "mc/seed.bin"), "corrupted");
    expect(await Bun.file(cached.value[0]!.cached).text()).toBe(body);
  });
});
