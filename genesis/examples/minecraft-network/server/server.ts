// A Minecraft server, run as a platform app. The Bun process is the HTTP
// control plane (status, start/stop, console, a validated settings form); the
// actual server is a Paper (java) child working out of /data — world, config,
// and the platform-placed server.jar all live there, so redeploys and
// snapshots carry the whole server.
//
// Two roles, chosen in the settings UI so you can't land in a broken state:
//   standalone — public, real auth (online-mode), players join this server
//                directly at its own address.
//   backend    — part of a Velocity network: online-mode off, modern
//                forwarding on with a secret fetched from the proxy over the
//                platform's app-to-app channel. Players join through the hub;
//                Paper rejects any direct connection that skipped the proxy.
import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

const PORT = Number(process.env["PORT"] ?? 8080);
const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const APP = process.env["OP_APP"] ?? "mc-server";
const OWNER = process.env["OP_OWNER"] ?? "";
const HOST = process.env["OP_HOST"] ?? "localhost";
const PUBLIC_PORT = process.env["OP_TCP_PORT_25565"] ?? "";
const DOMAIN = HOST.split(".").slice(1).join(".") || HOST;
const DIRECT_ADDRESS = PUBLIC_PORT ? `${DOMAIN}:${PUBLIC_PORT}` : "";
const MC_PORT = 25565;
const JAR = join(DATA_DIR, "server.jar");

// Peer wiring the platform injects (present when op.json consumes the proxy).
const ISSUER = process.env["OIDC_ISSUER"];
const CLIENT_ID = process.env["OIDC_CLIENT_ID"];
const CLIENT_SECRET = process.env["OIDC_CLIENT_SECRET"];
const HUB_URL = process.env["OP_PEER_HUB_URL"]; // the Velocity proxy app
const CA_FILE = process.env["OP_CA_FILE"];
const tls = CA_FILE ? { tls: { ca: Bun.file(CA_FILE) } } : {};

// ── settings (validated, curated — not raw server.properties) ─────────────
type Field =
  | { kind: "enum"; options: string[]; def: string }
  | { kind: "int"; min: number; max: number; def: number }
  | { kind: "bool"; def: boolean }
  | { kind: "text"; max: number; def: string };

const SCHEMA: Record<string, Field> = {
  role: { kind: "enum", options: ["standalone", "backend"], def: "standalone" },
  motd: { kind: "text", max: 120, def: "" },
  // "flat" is a superflat world — a clean, predictable hub floor (players
  // always spawn on flat ground). "normal" is generated terrain. Changing it
  // only affects newly generated chunks, so pair it with "Reset world".
  worldType: { kind: "enum", options: ["normal", "flat"], def: "normal" },
  gamemode: {
    kind: "enum",
    options: ["survival", "creative", "adventure", "spectator"],
    def: "survival",
  },
  difficulty: {
    kind: "enum",
    options: ["peaceful", "easy", "normal", "hard"],
    def: "normal",
  },
  maxPlayers: { kind: "int", min: 1, max: 200, def: 20 },
  viewDistance: { kind: "int", min: 3, max: 32, def: 10 },
  pvp: { kind: "bool", def: true },
  spawnProtection: { kind: "int", min: 0, max: 64, def: 0 },
  commandBlocks: { kind: "bool", def: false },
};

const db = new Database(join(DATA_DIR, "app.db"), { create: true });
db.exec(
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
);
const raw = (key: string): string | null =>
  db
    .query<
      { value: string },
      [string]
    >("SELECT value FROM settings WHERE key = ?")
    .get(key)?.value ?? null;
const setRaw = (key: string, value: string): void =>
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );

function setting<T = string>(key: string): T {
  const f = SCHEMA[key];
  const v = raw(key);
  if (!f) return (v ?? "") as T;
  if (v === null) return f.def as T;
  if (f.kind === "bool") return (v === "true") as T;
  if (f.kind === "int") return Number(v) as T;
  return v as T;
}

/** Coerce + validate one setting; returns the stored string or an error. */
function coerce(key: string, value: unknown): { ok: string } | { err: string } {
  const f = SCHEMA[key];
  if (!f) return { err: `unknown setting ${key}` };
  if (f.kind === "enum")
    return f.options.includes(String(value))
      ? { ok: String(value) }
      : { err: `${key} must be one of ${f.options.join(", ")}` };
  if (f.kind === "bool")
    return { ok: value === true || value === "true" ? "true" : "false" };
  if (f.kind === "int") {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < f.min || n > f.max)
      return { err: `${key} must be ${f.min}..${f.max}` };
    return { ok: String(n) };
  }
  const s = String(value).slice(0, f.max);
  return { ok: s };
}

const eulaAccepted = () => raw("eula") === "true";
const isBackend = () => setting("role") === "backend";
const motdText = () => setting<string>("motd") || `${APP} on ${DOMAIN}`;

// ── the java child ─────────────────────────────────────────────────────────
let proc: ReturnType<typeof Bun.spawn> | null = null;
let procState: "stopped" | "starting" | "running" | "stopping" = "stopped";
let startedAt = 0;
const logLines: string[] = [];
const pushLog = (line: string) => {
  logLines.push(line);
  if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  if (procState === "starting" && /Done \(/.test(line)) procState = "running";
};

/** Fetch the shared Velocity forwarding secret from the proxy over the
 *  platform's app-to-app channel. The token's audience is the hub, and the
 *  hub only hands the secret to its own backends — the secret never travels
 *  by hand. Returns null (retry later) if the hub isn't up yet. */
async function fetchForwardingSecret(): Promise<string | null> {
  if (!HUB_URL || !ISSUER || !CLIENT_ID || !CLIENT_SECRET) return null;
  try {
    const origin = new URL(HUB_URL).origin;
    const tok = await fetch(`${ISSUER}/oauth/token`, {
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
    if (!tok.ok) return null;
    const { access_token } = (await tok.json()) as { access_token: string };
    const res = await fetch(`${origin}/api/forwarding-secret`, {
      headers: { authorization: `Bearer ${access_token}` },
      ...tls,
    });
    if (!res.ok) return null;
    const { secret } = (await res.json()) as { secret?: string };
    return secret ?? null;
  } catch {
    return null;
  }
}

async function writeServerFiles(): Promise<{ ok: boolean; error?: string }> {
  await Bun.write(join(DATA_DIR, "eula.txt"), "eula=true\n");
  const backend = isBackend();
  const flat = setting("worldType") === "flat";
  const props = [
    `server-port=${MC_PORT}`,
    `motd=${motdText()}`,
    // A backend defers auth to Velocity; standalone authenticates itself.
    `online-mode=${backend ? "false" : "true"}`,
    `gamemode=${setting("gamemode")}`,
    `difficulty=${setting("difficulty")}`,
    // Superflat for a hub: a clean floor + no structures poking through.
    // level-type=flat needs generator-settings (a layer stack), or the world
    // fails to generate ("No key layers"). bedrock+dirt+grass, plains biome.
    `level-type=minecraft\\:${flat ? "flat" : "normal"}`,
    ...(flat
      ? [
          `generator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":3},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}`,
        ]
      : []),
    `generate-structures=${!flat}`,
    `max-players=${setting("maxPlayers")}`,
    `view-distance=${setting("viewDistance")}`,
    `pvp=${setting<boolean>("pvp")}`,
    `spawn-protection=${setting("spawnProtection")}`,
    `enable-command-block=${setting<boolean>("commandBlocks")}`,
    "",
  ].join("\n");
  await Bun.write(join(DATA_DIR, "server.properties"), props);

  if (backend) {
    const secret = await fetchForwardingSecret();
    if (!secret)
      return {
        ok: false,
        error:
          "waiting for the hub proxy — deploy the 'hub' app and this server will join it",
      };
    // Paper reads config/paper-global.yml at startup. Modern forwarding on +
    // the shared secret makes Paper REJECT any connection that didn't arrive
    // through Velocity (so the public port can't be used to spoof a name).
    // Only the velocity block — Paper reads this at boot and merges in its own
    // defaults (incl. _version) for every key we don't set. online-mode:true
    // here + secret must match velocity.toml; server.properties online-mode is
    // false (Velocity, not the backend, talks to Mojang).
    await Bun.write(
      join(DATA_DIR, "config", "paper-global.yml"),
      [
        "proxies:",
        "  velocity:",
        "    enabled: true",
        "    online-mode: true",
        `    secret: "${secret}"`,
        "",
      ].join("\n"),
    );
  }
  return { ok: true };
}

async function startServer(): Promise<{ ok: boolean; error?: string }> {
  if (proc) return { ok: true };
  if (!eulaAccepted()) return { ok: false, error: "EULA not accepted" };
  if (!(await Bun.file(JAR).exists()))
    return {
      ok: false,
      error:
        "server.jar missing — the platform places it from op.json assets on deploy",
    };
  const files = await writeServerFiles();
  if (!files.ok) return files;
  procState = "starting";
  startedAt = Date.now();
  pushLog(`[wrapper] starting Paper (${setting("role")}, heap 1280M) …`);
  proc = Bun.spawn(["java", "-Xms512M", "-Xmx1280M", "-jar", JAR, "nogui"], {
    cwd: DATA_DIR,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  setRaw("desired", "running");
  void pipeLogs(proc.stdout);
  void pipeLogs(proc.stderr);
  void proc.exited.then((code) => {
    pushLog(`[wrapper] java exited (code ${code})`);
    proc = null;
    const crashed = procState !== "stopping";
    procState = "stopped";
    if (crashed && raw("desired") === "running") {
      pushLog("[wrapper] unexpected exit — restarting in 10s");
      setTimeout(() => void startServer(), 10_000);
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

async function stopServer(): Promise<void> {
  setRaw("desired", "stopped");
  if (!proc) return;
  procState = "stopping";
  sendCommand("stop");
  const exited = await Promise.race([
    proc.exited,
    Bun.sleep(15_000).then(() => null),
  ]);
  if (exited === null && proc) proc.kill();
}

function sendCommand(command: string): boolean {
  if (!proc || !proc.stdin || typeof proc.stdin === "number") return false;
  proc.stdin.write(command + "\n");
  proc.stdin.flush();
  return true;
}

/** Apply the settings that a running server accepts live (the rest need a
 *  restart, which the UI makes clear). */
function applyLive(): void {
  if (!proc) return;
  sendCommand(`difficulty ${setting("difficulty")}`);
  sendCommand(`defaultgamemode ${setting("gamemode")}`);
}

// ── Server List Ping (the client protocol's status handshake) ──────────────
function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

async function pingServer(): Promise<{
  online: boolean;
  players?: { online: number; max: number };
  motd?: string;
}> {
  return new Promise((resolvePing) => {
    const socket = connect({ host: "127.0.0.1", port: MC_PORT });
    const done = (v: {
      online: boolean;
      players?: { online: number; max: number };
      motd?: string;
    }) => {
      socket.destroy();
      resolvePing(v);
    };
    const timer = setTimeout(() => done({ online: false }), 1_500);
    const chunks: Buffer[] = [];
    socket.on("connect", () => {
      const hostBytes = new TextEncoder().encode("127.0.0.1");
      const handshake = [
        0x00,
        ...varint(770),
        ...varint(hostBytes.length),
        ...hostBytes,
        MC_PORT >> 8,
        MC_PORT & 0xff,
        0x01,
      ];
      socket.write(Buffer.from([...varint(handshake.length), ...handshake]));
      socket.write(Buffer.from([0x01, 0x00]));
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      let i = 0;
      const readVarint = (): number | null => {
        let value = 0,
          shift = 0;
        while (true) {
          if (i >= buf.length) return null;
          const b = buf[i++]!;
          value |= (b & 0x7f) << shift;
          if (!(b & 0x80)) return value;
          shift += 7;
        }
      };
      if (readVarint() === null) return;
      if (readVarint() === null) return;
      const jsonLen = readVarint();
      if (jsonLen === null || buf.length < i + jsonLen) return;
      clearTimeout(timer);
      try {
        const status = JSON.parse(buf.subarray(i, i + jsonLen).toString());
        done({
          online: true,
          players: {
            online: status.players?.online ?? 0,
            max: status.players?.max ?? 0,
          },
          motd:
            typeof status.description === "string"
              ? status.description
              : (status.description?.text ?? ""),
        });
      } catch {
        done({ online: false });
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      done({ online: false });
    });
  });
}

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

    if (path === "/api/status") {
      const ping = proc ? await pingServer() : { online: false };
      return Response.json({
        app: APP,
        owner: OWNER,
        role: setting("role"),
        state: procState,
        desired: raw("desired") ?? "stopped",
        eulaAccepted: eulaAccepted(),
        // A backend is reached through the hub; standalone is reached directly.
        joinAddress: isBackend() ? "" : DIRECT_ADDRESS,
        directAddress: DIRECT_ADDRESS,
        gamemode: setting("gamemode"),
        difficulty: setting("difficulty"),
        uptimeSec: proc ? Math.floor((Date.now() - startedAt) / 1000) : 0,
        players: ping.online ? ping.players : null,
        motd: ping.online ? ping.motd : motdText(),
      });
    }
    if (path === "/api/log")
      return Response.json({ lines: logLines.slice(-100) });
    if (req.method === "GET" && path === "/api/settings") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(SCHEMA)) out[key] = setting(key);
      return Response.json({ schema: SCHEMA, values: out });
    }

    if (req.method === "POST") {
      const actor = actorOf(req);
      if (!actor)
        return Response.json(
          { error: "sign in to control the server" },
          {
            status: 401,
          },
        );
      if (path === "/api/eula") {
        setRaw("eula", "true");
        pushLog(`[wrapper] EULA accepted by ${actor}`);
        return Response.json({ ok: true });
      }
      if (path === "/api/start") {
        const started = await startServer();
        return Response.json(started, { status: started.ok ? 200 : 409 });
      }
      if (path === "/api/stop") {
        await stopServer();
        return Response.json({ ok: true });
      }
      if (path === "/api/reset-world") {
        // Wipe the world dirs and let the next start regenerate with the
        // current level-type. Destructive by design — an operator picks it
        // to switch a lobby to superflat or clear a griefed hub.
        const wasRunning = !!proc;
        await stopServer();
        for (const w of ["world", "world_nether", "world_the_end"])
          await rm(join(DATA_DIR, w), { recursive: true, force: true });
        pushLog(`[wrapper] ${actor} reset the world (${setting("worldType")})`);
        if (wasRunning) await startServer();
        return Response.json({ ok: true, worldType: setting("worldType") });
      }
      if (path === "/api/command") {
        const body = (await req.json().catch(() => ({}))) as {
          command?: string;
        };
        if (!body.command?.trim())
          return Response.json({ error: "command required" }, { status: 400 });
        pushLog(`[wrapper] ${actor}: /${body.command}`);
        return Response.json({ ok: sendCommand(body.command.trim()) });
      }
      if (path === "/api/settings") {
        const body = (await req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        for (const [key, value] of Object.entries(body)) {
          if (!(key in SCHEMA)) continue;
          const c = coerce(key, value);
          if ("err" in c)
            return Response.json({ error: c.err }, { status: 400 });
          setRaw(key, c.ok);
        }
        applyLive();
        pushLog(`[wrapper] ${actor} updated settings`);
        return Response.json({
          ok: true,
          note: "gamemode/difficulty apply live; other changes take effect on restart",
        });
      }
    }

    if (path === "/") {
      const ping = proc ? await pingServer() : { online: false };
      const state =
        procState === "running" && !ping.online ? "starting" : procState;
      return new Response(page(state, ping, actorOf(req)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

function optionTags(opts: string[], current: string): string {
  return opts
    .map(
      (o) =>
        `<option value="${o}"${o === current ? " selected" : ""}>${o}</option>`,
    )
    .join("");
}

function page(
  state: string,
  ping: {
    online: boolean;
    players?: { online: number; max: number };
    motd?: string;
  },
  user: string | null,
): string {
  const pill =
    state === "running"
      ? "#22c55e"
      : state === "starting"
        ? "#eab308"
        : "#64748b";
  const backend = isBackend();
  const address = backend
    ? "join via the network hub"
    : DIRECT_ADDRESS || "(no public port)";
  const s = (k: string) => esc(String(setting(k)));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(APP)} — Minecraft</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 system-ui, sans-serif; background: #0b1120; color: #e2e8f0; margin: 0; padding: 2rem 1rem; }
  main { max-width: 660px; margin: 0 auto; display: grid; gap: 1rem; }
  .card { background: #111a2e; border: 1px solid #1e293b; border-radius: 12px; padding: 1.25rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.3rem; } h2 { margin: 0 0 .75rem; font-size: 1rem; color: #94a3b8; }
  .pill { display: inline-block; padding: .15rem .6rem; border-radius: 999px; background: ${pill}22; color: ${pill}; font-weight: 600; font-size: .85rem; }
  .role { display: inline-block; padding: .1rem .5rem; border-radius: 999px; background: #1e293b; color: #94a3b8; font-size: .78rem; margin-left: .4rem; }
  .addr { font: 600 1.15rem/1 ui-monospace, monospace; background: #0f172a; border: 1px dashed #334155; padding: .6rem .8rem; border-radius: 8px; user-select: all; }
  button { background: #2563eb; color: white; border: 0; border-radius: 8px; padding: .5rem 1rem; font-weight: 600; cursor: pointer; }
  button.ghost { background: #1e293b; } button:hover { filter: brightness(1.15); }
  pre { background: #0f172a; border-radius: 8px; padding: .8rem; font-size: .78rem; overflow-x: auto; max-height: 240px; }
  .muted { color: #64748b; font-size: .85rem; }
  form.settings { display: grid; grid-template-columns: 1fr 1fr; gap: .7rem 1rem; }
  form.settings label { display: flex; flex-direction: column; gap: .25rem; font-size: .8rem; color: #94a3b8; }
  form.settings select, form.settings input { background: #0f172a; border: 1px solid #334155; color: #e2e8f0; border-radius: 7px; padding: .4rem .5rem; font: inherit; }
  form.settings .full { grid-column: 1 / -1; }
  .ctl form { display: inline; }
</style></head><body><main>
<div class="card">
  <h1>${esc(APP)} <span class="pill">${esc(state)}</span><span class="role">${backend ? "network member" : "standalone"}</span></h1>
  <p class="muted">A Minecraft server run entirely by the platform${OWNER ? ` · org <b>${esc(OWNER)}</b>` : ""}.</p>
  <h2>${backend ? "How to join" : "Join address"}</h2>
  <div class="addr">${esc(address)}</div>
  ${ping.online ? `<p>${ping.players?.online ?? 0}/${ping.players?.max ?? 0} players — "${esc(ping.motd ?? "")}" · ${s("gamemode")} / ${s("difficulty")}</p>` : ""}
</div>
<div class="card ctl">
  ${
    user
      ? eulaAccepted()
        ? `<form onsubmit="return go(event,'/api/start')"><button>Start</button></form>
           <form onsubmit="return go(event,'/api/stop')"><button class="ghost">Stop</button></form>`
        : `<p>First run: accept the <a href="https://aka.ms/MinecraftEULA" style="color:#60a5fa">Minecraft EULA</a> to start.</p>
           <form onsubmit="return go(event,'/api/eula')"><button>Accept EULA</button></form>`
      : `<p class="muted">Sign in on the platform to control this server.</p>`
  }
</div>
${
  user
    ? `<div class="card">
  <h2>Settings</h2>
  <form class="settings" id="settings" onsubmit="return saveSettings(event)">
    <label>Role
      <select name="role">${optionTags(["standalone", "backend"], s("role"))}</select></label>
    <label>World type
      <select name="worldType">${optionTags((SCHEMA.worldType as { options: string[] }).options, s("worldType"))}</select></label>
    <label>Game mode
      <select name="gamemode">${optionTags((SCHEMA.gamemode as { options: string[] }).options, s("gamemode"))}</select></label>
    <label>Difficulty
      <select name="difficulty">${optionTags((SCHEMA.difficulty as { options: string[] }).options, s("difficulty"))}</select></label>
    <label>Max players
      <input type="number" name="maxPlayers" value="${s("maxPlayers")}" min="1" max="200"></label>
    <label>View distance
      <input type="number" name="viewDistance" value="${s("viewDistance")}" min="3" max="32"></label>
    <label>PvP
      <select name="pvp">${optionTags(["true", "false"], s("pvp"))}</select></label>
    <label class="full">MOTD
      <input type="text" name="motd" value="${s("motd")}" maxlength="120" placeholder="${esc(motdText())}"></label>
    <div class="full"><button type="submit">Save settings</button>
      <button type="button" class="ghost" onclick="resetWorld()">Reset world</button>
      <span class="muted">Game mode & difficulty apply live; the rest on next restart. Reset world regenerates the map with the current world type.</span></div>
  </form>
</div>`
    : ""
}
<div class="card"><h2>Console</h2><pre id="log">${esc(logLines.slice(-30).join("\n")) || "(no output yet)"}</pre></div>
</main>
<script>
function go(e, path) { e.preventDefault(); fetch(path, { method: "POST" }).then(() => location.reload()); return false; }
function saveSettings(e){ e.preventDefault();
  var f = e.target, body = {};
  for (var el of f.elements) if (el.name) body[el.name] = el.value;
  fetch('/api/settings', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })
    .then(r => r.json()).then(function(){ location.reload(); });
  return false;
}
function resetWorld(){
  if (!confirm('Delete the world and regenerate it? This cannot be undone.')) return;
  fetch('/api/reset-world', { method:'POST' }).then(function(){ setTimeout(function(){ location.reload(); }, 1500); });
}
setInterval(function () {
  fetch("/api/log").then(r => r.json()).then(d => { document.getElementById("log").textContent = d.lines.join("\\n") || "(no output yet)"; });
}, 3000);
</script></body></html>`;
}

if (raw("desired") === "running" && eulaAccepted()) void startServer();
console.log(
  `[wrapper] ${APP} control plane on :${PORT} (${setting("role")}); ${DIRECT_ADDRESS || "no public port"}`,
);
