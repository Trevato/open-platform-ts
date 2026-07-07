import type { StateDir } from "@op/core";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import { readLineage } from "@op/mitosis";
import type { Store } from "@op/store";
import { readAppSpecs } from "../gitops.ts";
import { hostFor } from "../policy.ts";
import { esc, html, page, type Chrome } from "./layout.ts";
import { STYLE } from "./style.ts";

export interface ConsoleDeps {
  forge: Forge;
  store: Store;
  git: GitHost;
  sd: StateDir;
  domain: string;
}

const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

function sessionCookie(id: string): string {
  return `op_session=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

function redirect(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

// The external origin the browser actually used (scheme+host+port) — every
// link the console prints must round-trip on the same port the user is on.
function origin(req: Request): string {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

export function consoleRouter(
  deps: ConsoleDeps,
): (req: Request) => Promise<Response | null> {
  const loginPage = (error?: string) =>
    html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ${esc(deps.domain)}</title>
<style>${STYLE}</style></head><body>
<div class="wrap login"><div class="card">
<h1><span class="brand"><span class="seed"></span>Open Platform</span></h1>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/login">
  <input type="text" name="username" placeholder="username" autofocus autocomplete="username" required>
  <input type="password" name="password" placeholder="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
<p class="mut" style="margin:14px 0 0;font-size:12px">Admin credentials are on the card <code>op up</code> printed.</p>
</div></div></body></html>`);

  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── login / logout ──────────────────────────────────────────────────
    if (path === "/login" && req.method === "GET") return loginPage();
    if (path === "/login" && req.method === "POST") {
      const form = await req.formData();
      const username = String(form.get("username") ?? "");
      const password = String(form.get("password") ?? "");
      const user = await deps.forge.verifyPassword(username, password);
      if (!user) return loginPage("Invalid username or password.");
      const session = deps.forge.createSession(user.id);
      return redirect("/", sessionCookie(session.id));
    }
    if (path === "/logout" && req.method === "POST") {
      return redirect(
        "/login",
        "op_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      );
    }

    // Everything below is the authenticated console. Non-console paths return
    // null so the forge/API routers get their turn.
    const isConsolePath =
      path === "/" || path === "/lineage" || path.startsWith("/apps/");
    if (!isConsolePath) return null;

    const user = await deps.forge.authenticate(req);
    if (!user) return redirect("/login");
    const chrome = (active: Chrome["active"]): Chrome => ({
      domain: deps.domain,
      user: user.username,
      active,
    });

    // ── dashboard ───────────────────────────────────────────────────────
    if (path === "/") {
      const specs = await readAppSpecs(deps.git, deps.domain);
      const apps = specs.status === "ok" ? specs.value : [];
      const cards = apps
        .map((s) => {
          const st = deps.store.getAppStatus(s.owner, s.app);
          const state = st?.state ?? "pending";
          return `<a class="card app" href="/apps/${esc(s.owner)}/${esc(s.app)}">
  <div class="name"><span class="dot ${esc(state)}" data-app="${esc(s.owner)}/${esc(s.app)}"></span>${esc(s.app)}</div>
  <div class="host">${esc(hostFor(s, deps.domain))}</div>
  <div class="foot"><span class="state" data-state="${esc(s.owner)}/${esc(s.app)}">${esc(state)}</span></div>
</a>`;
        })
        .join("");

      const o = origin(req);
      const body = `
<h1>Apps</h1>
<p class="sub">${apps.length} app${apps.length === 1 ? "" : "s"} on this platform. Name one and an agent-free build ships it in seconds.</p>
<div class="card idcard">
  <span class="k">Platform</span><span class="v">${esc(deps.domain)}</span>
  <span class="k">Signed in</span><span class="v">${esc(user.username)}${user.is_admin ? " · admin" : ""}</span>
  <span class="k">Sovereign key</span><span class="v">${esc(deps.sd.keyFile)}</span>
</div>
<form class="newapp" onsubmit="return createApp(event)">
  <input type="text" id="appname" class="mono" placeholder="new-app-name" pattern="[a-z0-9][a-z0-9-]*" title="lowercase letters, digits, hyphens" required>
  <button type="submit">Create app</button>
</form>
${apps.length ? `<div class="grid">${cards}</div>` : `<div class="empty">No apps yet. Create your first one above.</div>`}`;

      return page(
        "Apps",
        chrome("apps"),
        body,
        `
var ORIGIN=${JSON.stringify(o)};
async function createApp(e){
  e.preventDefault();
  var name=document.getElementById('appname').value.trim();
  if(!name) return false;
  var r=await fetch('/api/v1/apps',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name})});
  if(r.ok){toast('creating '+name+'…');setTimeout(function(){location.href='/apps/'+${JSON.stringify(user.username)}+'/'+name},600);}
  else {var j=await r.json().catch(function(){return{}});toast(j.error||'failed');}
  return false;
}
async function refresh(){
  try{
    var r=await fetch('/api/v1/apps'); if(!r.ok) return;
    var j=await r.json();
    j.apps.forEach(function(a){
      var key=a.owner+'/'+a.app;
      var dot=document.querySelector('.dot[data-app="'+key+'"]');
      var st=document.querySelector('.state[data-state="'+key+'"]');
      if(dot){dot.className='dot '+a.state;} if(st){st.textContent=a.state;}
    });
  }catch(_){}
}
setInterval(refresh,2000);`,
      );
    }

    // ── app detail ──────────────────────────────────────────────────────
    const m = path.match(/^\/apps\/([^/]+)\/([^/]+)$/);
    if (m) {
      const [, owner, app] = m as unknown as [string, string, string];
      const st = deps.store.getAppStatus(owner, app);
      const repo = deps.store.getRepo(owner, app);
      if (!repo)
        return page(
          "Not found",
          chrome("apps"),
          `<h1>Not found</h1><p class="sub"><a href="/">← back to apps</a></p>`,
          "",
        );
      const state = st?.state ?? "pending";
      const o = origin(req);
      const appUrl = `https://${app}-${owner}.${deps.domain}${url.port ? `:${url.port}` : ""}/`;
      const cloneUrl = `${o}/${owner}/${app}.git`;
      const canWrite = deps.forge.authorize(user, owner, app, "write");

      const body = `
<div class="row between"><h1 style="margin:0"><span class="dot ${esc(state)}" id="dot"></span> ${esc(app)}</h1>
<a class="mut" href="/">← apps</a></div>
<p class="sub"><span class="state" id="state">${esc(state)}</span>${st?.message ? ` · <span class="mut">${esc(st.message)}</span>` : ""}</p>

<div class="card idcard">
  <span class="k">URL</span><span class="v"><a href="${esc(appUrl)}" target="_blank" rel="noopener">${esc(appUrl)}</a></span>
  <span class="k">Clone</span><span class="v"><span class="copy" onclick="copy(${JSON.stringify(cloneUrl)})">${esc(cloneUrl)} ⧉</span></span>
  <span class="k">Image</span><span class="v">${st?.image_digest ? esc(st.image_digest.slice(0, 26)) + "…" : "—"}</span>
</div>

${
  canWrite
    ? `<div class="row mb"><button onclick="snap()">Snapshot data</button>
<span class="mut" style="font-size:12px">checkpoint → copy-on-write clone → integrity_check</span></div>`
    : ""
}

<div class="mt"><div class="row between mb"><span class="label">Logs</span><span class="mut" style="font-size:12px" id="logts"></span></div>
<pre class="logs" id="logs">loading…</pre></div>`;

      return page(
        app,
        chrome("apps"),
        body,
        `
var KEY=${JSON.stringify(`${owner}/${app}`)};
async function tick(){
  try{
    var r=await fetch('/api/v1/apps/'+KEY);
    if(r.ok){var a=await r.json();document.getElementById('dot').className='dot '+a.state;document.getElementById('state').textContent=a.state;}
    var lg=await fetch('/api/v1/apps/'+KEY+'/logs');
    if(lg.ok){var t=await lg.text();var el=document.getElementById('logs');var atBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-8;el.textContent=t||'(no output yet)';if(atBottom)el.scrollTop=el.scrollHeight;document.getElementById('logts').textContent=new Date().toLocaleTimeString();}
  }catch(_){}
}
async function snap(){
  var r=await fetch('/api/v1/apps/'+KEY+'/snapshots',{method:'POST'});
  var j=await r.json().catch(function(){return{}});
  toast(r.ok?('snapshot '+j.id):(j.error||'snapshot failed'));
}
tick();setInterval(tick,2000);`,
      );
    }

    // ── lineage ─────────────────────────────────────────────────────────
    if (path === "/lineage") {
      const lines = await readLineage(deps.sd.originFile);
      const rows = lines
        .map((line, i) => {
          if (line.startsWith("root:")) {
            return `<div><span class="gen">root</span> — ${esc(line.slice(5).trim())}</div>`;
          }
          const indent = "&nbsp;&nbsp;".repeat(Math.min(i, 8));
          return `<div>${indent}<span class="arrow">└─</span> ${esc(line)}</div>`;
        })
        .join("");
      const body = `
<h1>Lineage</h1>
<p class="sub">This platform's family tree. Every germination records where it grew from; parents can never read children.</p>
${lines.length ? `<div class="card pad tree">${rows}</div>` : `<div class="empty">No lineage yet — this is a root platform. <code>op seed</code> then <code>op germinate</code> to grow a child.</div>`}
<p class="sub mt">Seed this platform: <code>op seed my-platform.tar.gz</code> — hand the file to anyone; their <code>op germinate</code> grows a sovereign platform of their own.</p>`;
      return page("Lineage", chrome("lineage"), body, "");
    }

    return null;
  };
}
