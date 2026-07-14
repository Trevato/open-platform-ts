import type { GitHost } from "@op/git";
import type { Store } from "@op/store";
import { readAppSpecs } from "./gitops.ts";
import {
  admitManifest,
  EMPTY_MANIFEST,
  type AppManifest,
  type AppPolicy,
} from "./manifest.ts";
import { hostFor } from "./policy.ts";

// The integration map is DERIVED, never stored: a pure function of the app
// specs in sys/gitops and each app repo's op.json at its deployed ref, joined
// with live status. It survives mitosis for free — both inputs travel (specs
// are re-created, manifests ride the app repos) — and it can never go stale,
// because there is nothing to invalidate.
export interface IntegrationMap {
  apps: Array<{
    owner: string;
    app: string;
    host: string;
    state: string | null;
    manifestError: string | null;
    provides: AppManifest["provides"];
    consumes: Array<{ owner: string; app: string; satisfied: boolean }>;
    tcp: Array<{ containerPort: number; publicPort: number }>;
  }>;
  edges: Array<{
    from: { owner: string; app: string };
    to: { owner: string; app: string };
    satisfied: boolean;
  }>;
}

/** Read + admit an app repo's op.json at a ref — bare-repo read, no clone. */
export async function readManifestAt(
  git: GitHost,
  repo: { owner: string; name: string },
  ref: string,
  policy: AppPolicy,
): Promise<{ manifest: AppManifest; error: string | null }> {
  const bytes = await git.readFile(repo.owner, repo.name, ref, "op.json");
  if (bytes.status === "error")
    return { manifest: EMPTY_MANIFEST, error: null }; // absent = no needs
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes.value));
  } catch (cause) {
    return { manifest: EMPTY_MANIFEST, error: `op.json: ${String(cause)}` };
  }
  const admitted = admitManifest(raw, policy);
  if (admitted.status === "error")
    return { manifest: EMPTY_MANIFEST, error: admitted.error.reason };
  return { manifest: admitted.value, error: null };
}

export async function computeIntegrationMap(deps: {
  git: GitHost;
  store: Store;
  domain: string;
  policy: AppPolicy;
  owner?: string;
}): Promise<IntegrationMap> {
  const specs = await readAppSpecs(deps.git, deps.domain);
  const all = specs.status === "ok" ? specs.value : [];
  const deployed = new Set(all.map((s) => `${s.owner}/${s.app}`));

  const apps: IntegrationMap["apps"] = [];
  const edges: IntegrationMap["edges"] = [];
  for (const spec of all) {
    const { manifest, error } = await readManifestAt(
      deps.git,
      spec.repo,
      spec.ref,
      deps.policy,
    );
    const consumes = manifest.consumes.map((c) => {
      const owner = c.owner ?? spec.owner;
      return {
        owner,
        app: c.app,
        satisfied: deployed.has(`${owner}/${c.app}`),
      };
    });
    for (const c of consumes)
      edges.push({
        from: { owner: spec.owner, app: spec.app },
        to: { owner: c.owner, app: c.app },
        satisfied: c.satisfied,
      });
    apps.push({
      owner: spec.owner,
      app: spec.app,
      host: hostFor(spec, deps.domain),
      state: deps.store.getAppStatus(spec.owner, spec.app)?.state ?? null,
      manifestError: error,
      provides: manifest.provides,
      consumes,
      tcp: deps.store.listAppPortsFor(spec.owner, spec.app).map((p) => ({
        containerPort: p.container_port,
        publicPort: p.public_port,
      })),
    });
  }

  if (deps.owner) {
    const mine = (x: { owner: string }) => x.owner === deps.owner;
    return {
      apps: apps.filter(mine),
      edges: edges.filter((e) => e.from.owner === deps.owner || mine(e.to)),
    };
  }
  return { apps, edges };
}
