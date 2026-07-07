import { readFile, writeFile, chmod } from "node:fs/promises";
import { randomHex, sha256Hex, type StateDir } from "@op/core";
import { loadSigningKey, mintSigningKey, type SigningKey } from "@op/identity";
import type { Store } from "@op/store";
import { join } from "node:path";

// The platform's OIDC signing key. Generated once per platform (a daughter gets
// its own at germination, since its state dir is fresh); persisted at 0600
// beside the sovereign key — same custody as the age key it lives next to.
export async function ensureSigningKey(sd: StateDir): Promise<SigningKey> {
  const file = join(sd.root, "oidc.key.json");
  if (await Bun.file(file).exists()) {
    return loadSigningKey(JSON.parse(await readFile(file, "utf8")));
  }
  const { privateJwk, key } = await mintSigningKey();
  await writeFile(file, JSON.stringify(privateJwk), { mode: 0o600 });
  await chmod(file, 0o600);
  return key;
}

export interface AppClientCreds {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// One client per deployment target: stable id, one redirect URI (its callback).
// Called only on an actual deploy, so minting a fresh secret and injecting it
// into the new container's env in the same converge keeps the two in lockstep —
// a running app never holds a secret the store has rotated out from under it.
// A preview gets a DISTINCT client id so its redirect never clobbers prod's.
export async function provisionAppClient(
  store: Store,
  owner: string,
  app: string,
  appOrigin: string,
  preview?: string,
): Promise<AppClientCreds> {
  const clientId = preview
    ? `app-${owner}-${app}-${preview}`
    : `app-${owner}-${app}`;
  const redirectUri = `${appOrigin}/auth/callback`;
  const clientSecret = `op_cs_${randomHex(24)}`;
  store.upsertClient({
    client_id: clientId,
    secret_hash: await sha256Hex(clientSecret),
    owner,
    app,
    redirect_uris: JSON.stringify([redirectUri]),
  });
  return { clientId, clientSecret, redirectUri };
}
