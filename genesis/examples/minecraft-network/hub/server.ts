// A Velocity proxy, run as a platform app — the single front door for a
// Minecraft network. The Bun process is the HTTP control plane; velocity.jar
// (placed by the platform from op.json assets) is the java child.
//
// The network wires itself from the platform's integration graph:
//   - This app `consumes` its backend servers, so the platform injects an
//     OP_PEER_<APP>_URL for each. We discover their live Minecraft addresses
//     over the app-to-app channel (peerFetch → each backend's /api/status)
//     and write them into velocity.toml.
//   - This app OWNS the modern-forwarding secret (generated once, persisted).
//     Backends fetch it from /api/forwarding-secret over the same authenticated
//     channel — so the network's trust root never travels by hand, and a
//     direct connection that skipped the proxy is rejected by Paper.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const PORT = Number(process.env["PORT"] ?? 8080);
const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const APP = process.env["OP_APP"] ?? "hub";
const OWNER = process.env["OP_OWNER"] ?? "";
const HOST = process.env["OP_HOST"] ?? "localhost";
const PUBLIC_PORT = process.env["OP_TCP_PORT_25565"] ?? "";
const DOMAIN = HOST.split(".").slice(1).join(".") || HOST;
const JOIN_ADDRESS = PUBLIC_PORT
  ? `${DOMAIN}:${PUBLIC_PORT}`
  : "(no public port)";
const VELOCITY_PORT = 25565;
const JAR = join(DATA_DIR, "velocity.jar");

const ISSUER = process.env["OIDC_ISSUER"];
const CLIENT_ID = process.env["OIDC_CLIENT_ID"];
const CLIENT_SECRET = process.env["OIDC_CLIENT_SECRET"];
const CA_FILE = process.env["OP_CA_FILE"];
const tls = CA_FILE ? { tls: { ca: Bun.file(CA_FILE) } } : {};

// Backends = every consumed peer the platform injected (OP_PEER_<APP>_URL).
// The name is the app name lowercased with _ → - (the reverse of envNameFor).
const backends: Array<{ app: string; url: string }> = Object.entries(
  process.env,
)
  .filter(([k]) => k.startsWith("OP_PEER_") && k.endsWith("_URL"))
  .map(([k, v]) => ({
    app: k
      .slice("OP_PEER_".length, -"_URL".length)
      .toLowerCase()
      .replaceAll("_", "-"),
    url: v as string,
  }));

const db = new Database(join(DATA_DIR, "app.db"), { create: true });
db.exec(
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
);
const raw = (k: string): string | null =>
  db
    .query<
      { value: string },
      [string]
    >("SELECT value FROM settings WHERE key = ?")
    .get(k)?.value ?? null;
const setRaw = (k: string, v: string): void =>
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [k, v],
  );

/** The forwarding secret is minted once and lives for the network's lifetime;
 *  rotating it would desync every backend. */
function forwardingSecret(): string {
  let s = raw("forwarding_secret");
  if (!s) {
    s = randomBytes(24).toString("hex");
    setRaw("forwarding_secret", s);
  }
  return s;
}

/** Which backend is the default landing server (the hub). Defaults to a peer
 *  named "mc-lobby" if present, else the first consumed backend. */
function defaultServer(): string | null {
  const configured = raw("default_server");
  if (configured && backends.some((b) => b.app === configured))
    return configured;
  const lobby = backends.find((b) => b.app.includes("lobby"));
  return lobby?.app ?? backends[0]?.app ?? null;
}

// ── the java child ─────────────────────────────────────────────────────────
let proc: ReturnType<typeof Bun.spawn> | null = null;
let procState: "stopped" | "starting" | "running" | "stopping" = "stopped";
let startedAt = 0;
const logLines: string[] = [];
const pushLog = (line: string) => {
  logLines.push(line);
  if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  if (procState === "starting" && /Done \(|Listening on/.test(line))
    procState = "running";
};

async function peerToken(origin: string): Promise<string | null> {
  if (!ISSUER || !CLIENT_ID || !CLIENT_SECRET) return null;
  try {
    const res = await fetch(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        resource: origin,
      }),
      ...tls,
    });
    if (!res.ok) return null;
    return ((await res.json()) as { access_token: string }).access_token;
  } catch {
    return null;
  }
}

/** Ask a backend for its live status (join address, players, motd). */
async function backendStatus(b: { app: string; url: string }): Promise<{
  app: string;
  address: string | null;
  online: boolean;
  players?: unknown;
  motd?: string;
}> {
  try {
    const origin = new URL(b.url).origin;
    const token = await peerToken(origin);
    const res = await fetch(`${origin}/api/status`, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...tls,
    });
    if (!res.ok) return { app: b.app, address: null, online: false };
    const s = (await res.json()) as {
      directAddress?: string;
      players?: unknown;
      motd?: string;
      state?: string;
    };
    return {
      app: b.app,
      address: s.directAddress || null,
      online: s.state === "running",
      players: s.players,
      motd: s.motd,
    };
  } catch {
    return { app: b.app, address: null, online: false };
  }
}

/** Build velocity.toml + forwarding.secret from live backend discovery. Only
 *  backends that currently advertise an address are registered; the default
 *  (hub) landing server leads the `try` list. Returns the registered set. */
async function writeVelocityConfig(): Promise<{ registered: string[] }> {
  const statuses = await Promise.all(backends.map(backendStatus));
  const withAddr = statuses.filter((s) => s.address);
  const def = defaultServer();
  const order = withAddr
    .map((s) => s.app)
    .sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));

  const servers = withAddr
    .map((s) => `${tomlKey(s.app)} = "${s.address}"`)
    .join("\n");
  const tryList = order.map((a) => `    "${tomlKey(a)}"`).join(",\n");
  // Velocity MOTD honors legacy & color codes (&b = aqua). Escape any quote
  // in a custom MOTD so it can't break out of the toml string.
  const motd = (raw("motd") || `&b${OWNER || "Minecraft"} Network`).replace(
    /"/g,
    "'",
  );

  const toml = `# Generated by the platform from consumed backends. Do not hand-edit.
config-version = "2.8"
bind = "0.0.0.0:${VELOCITY_PORT}"
motd = "${motd}"
show-max-players = 500
online-mode = true
player-info-forwarding-mode = "modern"
forwarding-secret-file = "forwarding.secret"

[servers]
${servers}
try = [
${tryList}
]

# Explicit + empty: Velocity injects its example forced-hosts (factions/…) for
# an OMITTED section, which then fail validation. An empty section clears them.
[forced-hosts]

[advanced]
compression-threshold = 256
connection-timeout = 5000
read-timeout = 30000
`;
  await Bun.write(join(DATA_DIR, "velocity.toml"), toml);
  await Bun.write(join(DATA_DIR, "forwarding.secret"), forwardingSecret());
  return { registered: order };
}

// Velocity server names + the modern config keys allow [a-z0-9_-]; app names
// already fit, but be defensive.
const tomlKey = (app: string) => app.replace(/[^a-z0-9_-]/g, "-");

async function startProxy(): Promise<{ ok: boolean; error?: string }> {
  if (proc) return { ok: true };
  if (!(await Bun.file(JAR).exists()))
    return {
      ok: false,
      error:
        "velocity.jar missing — the platform places it from op.json assets",
    };
  await mkdir(DATA_DIR, { recursive: true });
  const { registered } = await writeVelocityConfig();
  if (registered.length === 0)
    return {
      ok: false,
      error:
        "no backends are up yet — start the mc-* servers, then start the hub",
    };
  procState = "starting";
  startedAt = Date.now();
  pushLog(`[hub] starting Velocity, fronting: ${registered.join(", ")}`);
  proc = Bun.spawn(["java", "-Xms256M", "-Xmx768M", "-jar", JAR], {
    cwd: DATA_DIR,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  setRaw("desired", "running");
  void pipeLogs(proc.stdout);
  void pipeLogs(proc.stderr);
  void proc.exited.then((code) => {
    pushLog(`[hub] velocity exited (code ${code})`);
    proc = null;
    const crashed = procState !== "stopping";
    procState = "stopped";
    if (crashed && raw("desired") === "running") {
      pushLog("[hub] unexpected exit — restarting in 10s");
      setTimeout(() => void startProxy(), 10_000);
    }
  });
  return { ok: true };
}

async function pipeLogs(
  stream: ReadableStream<Uint8Array> | number | undefined,
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  let buf = "";
  for await (const chunk of stream) {
    buf += new TextDecoder().decode(chunk);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) pushLog(line);
  }
}

async function stopProxy(): Promise<void> {
  setRaw("desired", "stopped");
  if (!proc) return;
  procState = "stopping";
  if (proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write("shutdown\n");
    proc.stdin.flush();
  }
  const exited = await Promise.race([
    proc.exited,
    Bun.sleep(12_000).then(() => null),
  ]);
  if (exited === null && proc) proc.kill();
}

// A backend belongs to this network iff we were told to consume it.
const isMyBackend = (actor: string | null): boolean =>
  !!actor &&
  actor.startsWith("app:") &&
  backends.some(
    (b) =>
      actor === `app:${OWNER}/${b.app}` ||
      actor.startsWith(`app:${OWNER}/${b.app}@`),
  );

const actorOf = (req: Request): string | null => req.headers.get("x-plat-user");
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// ── HTTP control plane ─────────────────────────────────────────────────────
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // The trust root: handed ONLY to this network's own backends, over the
    // gate-verified app-to-app channel. A human or a foreign app gets nothing.
    if (path === "/api/forwarding-secret") {
      if (!isMyBackend(actorOf(req)))
        return Response.json(
          { error: "not a backend of this network" },
          {
            status: 403,
          },
        );
      return Response.json({ secret: forwardingSecret() });
    }

    if (path === "/api/status") {
      const statuses = await Promise.all(backends.map(backendStatus));
      return Response.json({
        app: APP,
        owner: OWNER,
        state: procState,
        joinAddress: JOIN_ADDRESS,
        defaultServer: defaultServer(),
        uptimeSec: proc ? Math.floor((Date.now() - startedAt) / 1000) : 0,
        servers: statuses.map((s) => ({
          name: s.app,
          online: s.online,
          players: s.players,
          motd: s.motd,
        })),
      });
    }
    if (path === "/api/log")
      return Response.json({ lines: logLines.slice(-100) });

    if (req.method === "POST") {
      const actor = actorOf(req);
      if (!actor)
        return Response.json(
          { error: "sign in to control the hub" },
          { status: 401 },
        );
      if (path === "/api/start") {
        const r = await startProxy();
        return Response.json(r, { status: r.ok ? 200 : 409 });
      }
      if (path === "/api/stop") {
        await stopProxy();
        return Response.json({ ok: true });
      }
      if (path === "/api/reload") {
        // Re-discover backends and rewrite config (Velocity needs a restart to
        // pick up new servers; document that in the response).
        const { registered } = await writeVelocityConfig();
        return Response.json({
          ok: true,
          registered,
          note: "config rewritten; restart the hub to apply",
        });
      }
    }

    if (path === "/") {
      const statuses = await Promise.all(backends.map(backendStatus));
      return new Response(page(statuses, actorOf(req)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

function page(
  statuses: Array<{
    app: string;
    online: boolean;
    players?: unknown;
    motd?: string;
  }>,
  user: string | null,
): string {
  const running = procState;
  const pill =
    running === "running"
      ? "#22c55e"
      : running === "starting"
        ? "#eab308"
        : "#64748b";
  const def = defaultServer();
  const rows = statuses
    .map((s) => {
      const p = s.players as { online?: number; max?: number } | null;
      const dot = s.online ? "#22c55e" : "#64748b";
      return `<tr>
        <td><span style="color:${dot}">●</span> <b>${esc(s.app)}</b>${s.app === def ? ' <span class="tag">hub</span>' : ""}</td>
        <td class="mono">/server ${esc(s.app)}</td>
        <td>${s.online ? `${p?.online ?? 0}/${p?.max ?? 0}` : "offline"}</td>
        <td class="muted">${esc(s.motd ?? "")}</td>
      </tr>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(APP)} — network hub</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 system-ui, sans-serif; background: #0b1120; color: #e2e8f0; margin: 0; padding: 2rem 1rem; }
  main { max-width: 680px; margin: 0 auto; display: grid; gap: 1rem; }
  .card { background: #111a2e; border: 1px solid #1e293b; border-radius: 12px; padding: 1.25rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.3rem; } h2 { margin: 0 0 .75rem; font-size: 1rem; color: #94a3b8; }
  .pill { display: inline-block; padding: .15rem .6rem; border-radius: 999px; background: ${pill}22; color: ${pill}; font-weight: 600; font-size: .85rem; }
  .tag { font-size: .7rem; background: #1e293b; color: #60a5fa; border-radius: 999px; padding: .05rem .45rem; }
  .addr { font: 600 1.2rem/1 ui-monospace, monospace; background: #0f172a; border: 1px dashed #334155; padding: .6rem .8rem; border-radius: 8px; user-select: all; }
  table { width: 100%; border-collapse: collapse; } td { padding: .5rem .4rem; border-bottom: 1px solid #1e293b; font-size: .9rem; }
  .mono { font-family: ui-monospace, monospace; color: #cbd5e1; } .muted { color: #64748b; font-size: .82rem; }
  button { background: #2563eb; color: white; border: 0; border-radius: 8px; padding: .5rem 1rem; font-weight: 600; cursor: pointer; }
  button.ghost { background: #1e293b; } button:hover { filter: brightness(1.15); } form { display: inline; }
  pre { background: #0f172a; border-radius: 8px; padding: .8rem; font-size: .78rem; overflow-x: auto; max-height: 220px; }
</style></head><body><main>
<div class="card">
  <h1>${esc(APP)} <span class="pill">${esc(running)}</span></h1>
  <p class="muted">The Velocity front door for ${esc(OWNER)}'s network. Players connect once; <span class="mono">/server</span> hops between worlds.</p>
  <h2>Connect address</h2>
  <div class="addr">${esc(JOIN_ADDRESS)}</div>
</div>
<div class="card">
  <h2>Network</h2>
  <table><tbody>${rows || '<tr><td class="muted">No backends discovered yet.</td></tr>'}</tbody></table>
</div>
<div class="card">
  ${
    user
      ? `<form onsubmit="return go(event,'/api/start')"><button>Start hub</button></form>
         <form onsubmit="return go(event,'/api/stop')"><button class="ghost">Stop</button></form>
         <form onsubmit="return go(event,'/api/reload')"><button class="ghost">Rediscover backends</button></form>`
      : `<p class="muted">Sign in on the platform to control the hub.</p>`
  }
</div>
<div class="card"><h2>Console</h2><pre id="log">${esc(logLines.slice(-30).join("\n")) || "(no output yet)"}</pre></div>
</main>
<script>
function go(e, path) { e.preventDefault(); fetch(path, { method: "POST" }).then(function(r){return r.json()}).then(function(){ location.reload(); }); return false; }
setInterval(function () {
  fetch("/api/log").then(r => r.json()).then(d => { document.getElementById("log").textContent = d.lines.join("\\n") || "(no output yet)"; });
}, 3000);
</script></body></html>`;
}

// Resume on boot, retrying while the backends come up after a platform
// restart (startProxy needs at least one discovered backend).
async function resumeOnBoot(): Promise<void> {
  if (raw("desired") !== "running") return;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (proc) return;
    const started = await startProxy();
    if (started.ok) return;
    console.log(`[hub] start deferred (${started.error}); retrying in 10s`);
    await Bun.sleep(10_000);
  }
}
void resumeOnBoot();
console.log(
  `[hub] ${APP} control plane on :${PORT}; fronting ${backends.length} backend(s); public ${JOIN_ADDRESS}`,
);
