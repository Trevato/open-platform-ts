import type { StateDir } from "@op/core";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import { readLineage } from "@op/mitosis";
import type { Store } from "@op/store";
import { readAppSpecs } from "../gitops.ts";
import { authorizeFor } from "../oidc.ts";
import { hostFor } from "../policy.ts";
import { type Chrome, type Crumb, esc, html, page } from "./layout.ts";
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

// The crew pipeline, rendered from an issue's labels. Filed → Building →
// Reviewing → Merged, each pending/active/done/failed.
function pipeline(labels: string[]): string {
  const has = (l: string) => labels.includes(l);
  type S = "pending" | "active" | "done" | "failed";
  let filed: S = "done";
  let building: S = "pending";
  let reviewing: S = "pending";
  let merged: S = "pending";
  if (has("agent-shipped")) {
    building = reviewing = "done";
    merged = "done";
  } else if (has("agent-review-failed")) {
    building = "done";
    reviewing = "failed";
  } else if (has("agent-reviewing")) {
    building = "done";
    reviewing = "active";
  } else if (has("agent-building")) {
    building = "active";
  } else if (has("agent-failed")) {
    building = "failed";
  } else if (has("agent-work")) {
    filed = "active";
  }
  const step = (s: S, label: string) => {
    const dot =
      s === "active"
        ? "building"
        : s === "failed"
          ? "error"
          : s === "done"
            ? "running"
            : "";
    return `<li class="step ${s}"><span class="dot ${dot}"></span>${label}</li>`;
  };
  return `<ol class="pipeline">${step(filed, "Filed")}${step(building, "Building")}${step(reviewing, "Reviewing")}${step(merged, "Merged")}</ol>`;
}

// Colorize a unified diff for the server-rendered PR view (no client parsing).
function colorDiff(patch: string): string {
  return patch
    .split("\n")
    .map((l) => {
      const e = esc(l);
      if (l.startsWith("+") && !l.startsWith("+++"))
        return `<span class="diff-add">${e}</span>`;
      if (l.startsWith("-") && !l.startsWith("---"))
        return `<span class="diff-del">${e}</span>`;
      if (l.startsWith("@@") || l.startsWith("diff ") || l.startsWith("index "))
        return `<span class="diff-hd">${e}</span>`;
      return e;
    })
    .join("\n");
}

export function consoleRouter(
  deps: ConsoleDeps,
): (req: Request) => Promise<Response | null> {
  // Only same-origin absolute paths may be resumed after login — never an
  // attacker-supplied external URL (open-redirect guard).
  const safeNext = (raw: string | null): string =>
    raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  const loginPage = (next: string, error?: string) =>
    html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light">
<title>Sign in · ${esc(deps.domain)}</title>
<script>(function(){try{var t=localStorage.getItem('op-theme')||(matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}})();</script>
<style>${STYLE}</style></head><body>
<div class="wrap login"><div class="card pad">
<h1><span class="brand"><span class="seed"></span>Open Platform</span></h1>
<p class="sub" style="margin-bottom:18px">${esc(deps.domain)}</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/login?next=${esc(encodeURIComponent(next))}">
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
    if (path === "/login" && req.method === "GET")
      return loginPage(safeNext(url.searchParams.get("next")));
    if (path === "/login" && req.method === "POST") {
      const form = await req.formData();
      const username = String(form.get("username") ?? "");
      const password = String(form.get("password") ?? "");
      // next travels in the action query string (clean single decode), never a
      // hidden field — a form-body round-trip mangles '+'/space in the URL.
      const next = safeNext(url.searchParams.get("next"));
      const user = await deps.forge.verifyPassword(username, password);
      if (!user) return loginPage(next, "Invalid username or password.");
      const session = deps.forge.createSession(user.id);

      // If login was an OIDC bounce, complete the authorization HERE — the user
      // is authenticated in-process, so we never depend on the just-set cookie
      // being re-read at /oauth/authorize across a redirect (SameSite-safe).
      if (next.startsWith("/oauth/authorize?")) {
        const params = new URL(next, "https://x").searchParams;
        const outcome = authorizeFor(deps.store, params, user.id);
        if (outcome.kind !== "error")
          return redirect(outcome.location, sessionCookie(session.id));
      }
      return redirect(next, sessionCookie(session.id));
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
    const chrome = (active: Chrome["active"], crumbs?: Crumb[]): Chrome => ({
      domain: deps.domain,
      user: user.username,
      active,
      ...(crumbs ? { crumbs } : {}),
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

      const body = `
<h1>Apps</h1>
<p class="sub">${apps.length} app${apps.length === 1 ? "" : "s"} on this platform. Name one and it ships in seconds — then file an issue and the build crew grows it.</p>
<div class="card idcard">
  <span class="k">Platform</span><span class="v">${esc(deps.domain)}</span>
  <span class="k">Signed in</span><span class="v">${esc(user.username)}${user.is_admin ? " · admin" : ""}</span>
  <span class="k">Sovereign key</span><span class="v">${esc(deps.sd.keyFile)}</span>
</div>
<form class="newapp" onsubmit="return createApp(event)">
  <input type="text" id="appname" class="mono grow" placeholder="new-app-name" pattern="[a-z0-9][a-z0-9-]*" title="lowercase letters, digits, hyphens" required>
  <button type="submit" id="createbtn">Create app</button>
</form>
${apps.length ? `<div class="grid">${cards}</div>` : `<div class="empty">No apps yet. Name one above and it ships in seconds.</div>`}`;

      return page(
        "Apps",
        chrome("apps", [{ label: "Apps" }]),
        body,
        `
async function createApp(e){
  e.preventDefault();
  var name=document.getElementById('appname').value.trim();
  if(!name) return false;
  var b=document.getElementById('createbtn');b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/apps',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name})});
  if(r.ok){toast('creating '+name+'…');location.href='/apps/'+${JSON.stringify(user.username)}+'/'+name;}
  else {b.classList.remove('is-loading');b.disabled=false;var j=await r.json().catch(function(){return{}});toast(j.error||'failed');}
  return false;
}
async function refresh(){
  if(document.hidden) return;
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
setInterval(refresh,2500);`,
        { wide: true },
      );
    }

    // ── app detail ──────────────────────────────────────────────────────
    const m = path.match(/^\/apps\/([^/]+)\/([^/]+)$/);
    if (m) {
      const [, owner, app] = m as unknown as [string, string, string];
      const st = deps.store.getAppStatus(owner, app);
      const repo = deps.store.getRepo(owner, app);
      const back: Crumb[] = [{ label: "Apps", href: "/" }, { label: app }];
      if (!repo) return page("Not found", chrome("apps", back), notFound("/"));
      const state = st?.state ?? "pending";
      const o = origin(req);
      const appUrl = `https://${app}-${owner}.${deps.domain}${url.port ? `:${url.port}` : ""}/`;
      const cloneUrl = `${o}/${owner}/${app}.git`;
      const canWrite = deps.forge.authorize(user, owner, app, "write");

      const body = `
<div class="row between">
  <h1 class="m0"><span class="dot ${esc(state)}" id="dot"></span>${esc(app)}</h1>
  <a class="${appUrl ? "btn secondary sm" : "hide"}" href="${esc(appUrl)}" target="_blank" rel="noopener">Open ↗</a>
</div>
<p class="sub"><span class="state" id="state">${esc(state)}</span>${st?.message ? ` · <span class="mut" id="stmsg">${esc(st.message)}</span>` : ""}</p>

<div class="card idcard">
  <span class="k">URL</span><span class="v"><a href="${esc(appUrl)}" target="_blank" rel="noopener">${esc(appUrl)}</a></span>
  <span class="k">Clone</span><span class="v"><button class="btn ghost sm" onclick="copy(${JSON.stringify(cloneUrl)})" data-tip="Copy git URL">${esc(cloneUrl)} ⧉</button></span>
  <span class="k">Image</span><span class="v" id="digest">${st?.image_digest ? esc(st.image_digest.slice(0, 26)) + "…" : "—"}</span>
</div>

<div class="tabs" role="tablist">
  <button class="tab on" data-pane="issues" role="tab">Issues <span class="mut" id="ic"></span></button>
  <button class="tab" data-pane="prs" role="tab">Pull requests <span class="mut" id="pc"></span></button>
  <button class="tab" data-pane="overview" role="tab">Deploys</button>
  <button class="tab" data-pane="logs" role="tab">Logs</button>
</div>

<div class="tabpane on mt" id="pane-issues">
  ${
    canWrite
      ? `<form class="newapp" id="composer-form" onsubmit="return compose(event)">
    <input type="text" id="idea" class="grow" placeholder="Describe a feature — the crew drafts, builds, reviews & ships it" required>
    <button type="submit" id="composebtn">Compose</button>
  </form>
  <div id="draft"></div>`
      : ""
  }
  <div class="rows" id="issues"><div class="mut">loading…</div></div>
</div>

<div class="tabpane mt" id="pane-prs">
  <div class="rows" id="prs"><div class="mut">loading…</div></div>
</div>

<div class="tabpane mt" id="pane-overview">
  ${
    canWrite
      ? `<div class="row mb"><button class="btn secondary sm" onclick="snap(this)">Snapshot data</button>
  <span class="mut" style="font-size:12px">checkpoint → copy-on-write clone → integrity_check</span></div>`
      : ""
  }
  <div class="label mb">Deploy timeline</div>
  <div class="tl" id="tl"><div class="mut">loading…</div></div>
</div>

<div class="tabpane mt" id="pane-logs">
  <div class="label mb">Build log</div>
  <pre class="logs" id="build">—</pre>
  <div class="row between mb mt"><span class="label">Runtime</span><span class="mut" style="font-size:12px" id="logts"></span></div>
  <pre class="logs" id="logs">loading…</pre>
</div>`;

      return page(
        app,
        chrome("apps", back),
        body,
        `
var KEY=${JSON.stringify(`${owner}/${app}`)};
document.querySelectorAll('.tab').forEach(function(t){t.onclick=function(){
  document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('on',x===t)});
  document.querySelectorAll('.tabpane').forEach(function(p){p.classList.toggle('on',p.id==='pane-'+t.dataset.pane)});
}});
function dotFor(p){if(p==='running')return 'running';if(p==='failed')return 'error';if(p==='stopped')return '';if(p==='built')return 'running';return 'building';}
function issueRow(it){
  var labs=(it.labels||'').split(',').filter(Boolean).map(function(l){return '<span class="pill'+(l.indexOf('agent')===0?' agent':'')+'">'+escHtml(l)+'</span>';}).join('');
  return '<a class="list-row" href="/apps/'+KEY+'/issues/'+it.number+'"><span class="num">#'+it.number+'</span><span class="ttl">'+escHtml(it.title)+'</span><span class="meta">'+labs+'</span></a>';
}
function prRow(pr){
  var s=pr.state||'open';
  return '<a class="list-row" href="/apps/'+KEY+'/pulls/'+pr.number+'"><span class="num">#'+pr.number+'</span><span class="ttl">'+escHtml(pr.title)+'</span><span class="meta"><span class="pill '+s+'">'+s+'</span></span></a>';
}
async function tick(){
  if(document.hidden) return;
  try{
    var r=await fetch('/api/v1/apps/'+KEY);
    if(r.ok){var a=await r.json();document.getElementById('dot').className='dot '+a.state;document.getElementById('state').textContent=a.state;
      var dg=document.getElementById('digest');if(dg&&a.imageDigest)dg.textContent=a.imageDigest.slice(0,26)+'…';}
    var il=await fetch('/api/v1/repos/'+KEY+'/issues?state=open');
    if(il.ok){var ij=await il.json();var iel=document.getElementById('issues');document.getElementById('ic').textContent=ij.issues.length||'';
      iel.innerHTML=ij.issues.length?ij.issues.map(issueRow).join(''):'<div class="mut" style="font-size:13px;padding:8px 0">No open issues. Describe a feature above.</div>';}
    var pl=await fetch('/api/v1/repos/'+KEY+'/pulls?state=open');
    if(pl.ok){var pj=await pl.json();var pel=document.getElementById('prs');document.getElementById('pc').textContent=pj.pulls.length||'';
      pel.innerHTML=pj.pulls.length?pj.pulls.map(prRow).join(''):'<div class="mut" style="font-size:13px;padding:8px 0">No open pull requests.</div>';}
    var ev=await fetch('/api/v1/apps/'+KEY+'/events');
    if(ev.ok){var j=await ev.json();var el=document.getElementById('tl');
      el.innerHTML=j.events.length?j.events.map(function(e){
        return '<div class="tl-ev"><span class="dot '+dotFor(e.phase)+'"></span><span class="ph">'+escHtml(e.phase)+'</span><span class="msg" title="'+escHtml(e.message||'')+'">'+escHtml(e.message||'')+'</span><span class="t">'+relTime(e.ts)+'</span></div>';
      }).join(''):'<div class="mut" style="font-size:13px">No deploys yet.</div>';}
    var bl=await fetch('/api/v1/apps/'+KEY+'/buildlog');
    if(bl.ok){document.getElementById('build').textContent=(await bl.text())||'—';}
    var lg=await fetch('/api/v1/apps/'+KEY+'/logs');
    if(lg.ok){var t=await lg.text();var lel=document.getElementById('logs');var atBottom=lel.scrollTop+lel.clientHeight>=lel.scrollHeight-8;lel.textContent=t||'(no output yet)';if(atBottom)lel.scrollTop=lel.scrollHeight;document.getElementById('logts').textContent=new Date().toLocaleTimeString();}
  }catch(_){}
}
async function snap(b){b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/apps/'+KEY+'/snapshots',{method:'POST'});
  var j=await r.json().catch(function(){return{}});
  b.classList.remove('is-loading');b.disabled=false;
  toast(r.ok?('snapshot '+j.id):(j.error||'snapshot failed'));
}
// Curating flow: a rough idea → the composer drafts a structured issue you
// edit → File. Degrades to filing the idea as-is when the composer is offline.
async function compose(e){
  e.preventDefault();
  var idea=document.getElementById('idea').value.trim();if(!idea)return false;
  var b=document.getElementById('composebtn');b.classList.add('is-loading');b.disabled=true;
  document.getElementById('draft').innerHTML='<div class="card pad mt-s"><div class="mut" style="font-size:13px;margin-bottom:10px">structuring this…</div><div class="sk line w80"></div><div class="sk line"></div><div class="sk line w60"></div></div>';
  try{
    var r=await fetch('/api/v1/repos/'+KEY+'/issues/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idea:idea})});
    if(r.status===503){document.getElementById('draft').innerHTML='';await fileIssue(idea,idea,['agent-work']);toast('composer offline — filed as-is');}
    else{var d=await r.json();if(!r.ok)throw new Error(d.error||'failed');renderDraft(idea,d);}
  }catch(err){document.getElementById('draft').innerHTML='';toast(String((err&&err.message)||err));}
  b.classList.remove('is-loading');b.disabled=false;return false;
}
function renderDraft(idea,d){
  window._idea=idea;
  var spec=(d.body||'')+((d.acceptanceChecks&&d.acceptanceChecks.length)?'\\n\\nAcceptance checks:\\n'+d.acceptanceChecks.map(function(c){return '- '+c}).join('\\n'):'');
  var labels=d.labels&&d.labels.length?d.labels:['agent-work'];
  document.getElementById('composer-form').classList.add('hide');
  document.getElementById('draft').innerHTML=
    '<div class="card pad stack mt-s">'+
    '<div><div class="label mb">Title</div><input type="text" id="d-title" class="grow" value="'+escHtml(d.title||idea)+'"></div>'+
    '<div><div class="label mb">Spec</div><textarea id="d-body" rows="7">'+escHtml(spec)+'</textarea></div>'+
    '<div class="row"><span class="label">Labels</span><span id="d-labels">'+labels.map(function(l){return '<span class="pill agent chip rm" data-l="'+escHtml(l)+'" onclick="this.remove()">'+escHtml(l)+' ×</span>'}).join(' ')+'</span></div>'+
    '<div class="row"><button onclick="fileDraft(this)">File issue</button><button class="btn ghost" onclick="rewrite()">Rewrite</button><span class="mut" style="font-size:12px">drafted by the composer — edit anything</span></div>'+
    '</div>';
}
async function fileDraft(b){
  var title=document.getElementById('d-title').value.trim();var body=document.getElementById('d-body').value.trim();
  var labels=[].map.call(document.querySelectorAll('#d-labels [data-l]'),function(x){return x.dataset.l});
  b.classList.add('is-loading');b.disabled=true;await fileIssue(title,body,labels);
}
async function fileIssue(title,body,labels){
  var r=await fetch('/api/v1/repos/'+KEY+'/issues',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:title,body:body,labels:labels})});
  var j=await r.json().catch(function(){return{}});
  if(r.ok){document.getElementById('draft').innerHTML='';var cf=document.getElementById('composer-form');cf.classList.remove('hide');document.getElementById('idea').value='';toast(labels.indexOf('agent-work')>=0?'filed — crew is on it':'issue filed');tick();}
  else toast(j.error||'failed');
}
function rewrite(){document.getElementById('draft').innerHTML='';document.getElementById('composer-form').classList.remove('hide');var i=document.getElementById('idea');i.value=window._idea||'';i.focus();}
tick();setInterval(tick,1800);`,
      );
    }

    // ── pull request detail ─────────────────────────────────────────────
    const pm = path.match(/^\/apps\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (pm) {
      const [, owner, app, num] = pm as unknown as [
        string,
        string,
        string,
        string,
      ];
      const pr = deps.store.getPr(owner, app, Number(num));
      const back: Crumb[] = [
        { label: "Apps", href: "/" },
        { label: app, href: `/apps/${owner}/${app}` },
        { label: `#${num}` },
      ];
      if (!pr)
        return page(
          "Not found",
          chrome("apps", back),
          notFound(`/apps/${esc(owner)}/${esc(app)}`),
        );
      const diff = await deps.git.diffStat(
        owner,
        app,
        pr.base_ref,
        pr.head_ref,
      );
      const patch = diff.status === "ok" ? diff.value.patch : "";
      const canWrite = deps.forge.authorize(user, owner, app, "write");
      const isOpen = pr.state === "open";
      const previewHost = `pr-${pr.number}-${app}-${owner}.${deps.domain}${url.port ? `:${url.port}` : ""}`;
      const steps =
        pr.state === "merged"
          ? ["agent-shipped"]
          : isOpen
            ? ["agent-reviewing"]
            : ["agent-review-failed"];
      const body = `
${pipeline(steps)}
<div class="row between">
  <h1 class="m0">#${pr.number} <span style="font-weight:560">${esc(pr.title)}</span></h1>
  <span class="pill ${esc(pr.state)}">${esc(pr.state)}</span>
</div>
<p class="sub"><span class="mono">${esc(pr.head_ref)} → ${esc(pr.base_ref)}</span> · by ${esc(pr.author)}</p>

<div class="card idcard">
  <span class="k">Preview</span><span class="v">${isOpen ? `<a href="https://${esc(previewHost)}/" target="_blank" rel="noopener">https://${esc(previewHost)}/</a>` : "—"}</span>
  <span class="k">Data</span><span class="v mut">copy-on-write clone of prod, isolated to this PR</span>
</div>

${canWrite && isOpen ? `<div class="row mb"><button class="btn" onclick="act('merge',this)">Merge</button><button class="btn ghost" onclick="act('close',this)">Close</button></div>` : ""}
<div class="label mb">Diff <span class="mut">${diff.status === "ok" ? esc(String(diff.value.files ?? "")) : ""}</span></div>
<pre class="logs">${patch ? colorDiff(patch) : "(no changes)"}</pre>`;
      return page(
        `#${pr.number}`,
        chrome("apps", back),
        body,
        `
async function act(a,b){b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/repos/${esc(owner)}/${esc(app)}/pulls/${pr.number}/'+a,{method:'POST'});
  var j=await r.json().catch(function(){return{}});
  if(r.ok){toast(a==='merge'?'merged — shipping':'closed');setTimeout(function(){location.href='/apps/${esc(owner)}/${esc(app)}'},700);}
  else {b.classList.remove('is-loading');b.disabled=false;toast(j.error||'failed');}
}`,
      );
    }

    // ── issue detail ─────────────────────────────────────────────────────
    const im = path.match(/^\/apps\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
    if (im) {
      const [, owner, app, num] = im as unknown as [
        string,
        string,
        string,
        string,
      ];
      const issue = deps.store.getIssue(owner, app, Number(num));
      const back: Crumb[] = [
        { label: "Apps", href: "/" },
        { label: app, href: `/apps/${owner}/${app}` },
        { label: `#${num}` },
      ];
      if (!issue)
        return page(
          "Not found",
          chrome("apps", back),
          notFound(`/apps/${esc(owner)}/${esc(app)}`),
        );
      const canWrite = deps.forge.authorize(user, owner, app, "write");
      const labels = issue.labels.split(",").filter(Boolean);
      const isAgentWork = labels.some((l) => l.startsWith("agent-"));
      const body = `
${isAgentWork ? pipeline(labels) : ""}
<div class="row between">
  <h1 class="m0">#${issue.number} <span style="font-weight:560">${esc(issue.title)}</span></h1>
  <span class="pill ${issue.state === "open" ? "open" : "closed"}">${esc(issue.state)}</span>
</div>
<p class="sub">by ${esc(issue.author)} · ${labels.map((l) => `<span class="pill${l.startsWith("agent") ? " agent" : ""}">${esc(l)}</span>`).join(" ")}</p>
${issue.body ? `<div class="card pad prewrap" style="font-size:13.5px">${esc(issue.body)}</div>` : ""}

${
  canWrite
    ? `<div class="row mb mt">
${isAgentWork ? "" : `<button class="btn" onclick="assign(this)">Assign to build crew</button>`}
<button class="btn ghost" onclick="closeIssue(this)">Close issue</button></div>`
    : ""
}

<div class="mt row between mb"><span class="label">Activity</span><span class="mut" style="font-size:12px" id="cmts"></span></div>
<div class="feed" id="feed" aria-live="polite"><div class="mut" style="font-size:13px">loading…</div></div>
${
  canWrite
    ? `<form class="newapp mt" onsubmit="return addComment(event)">
  <input type="text" id="cbody" class="grow" placeholder="Comment…" required><button type="submit">Comment</button>
</form>`
    : ""
}`;
      return page(
        `#${issue.number}`,
        chrome("apps", back),
        body,
        `
var R=${JSON.stringify(`${owner}/${app}`)};var N=${issue.number};var seen={};var firstRender=true;
var TOOLS={Read:1,Write:1,Edit:1,Bash:1,Glob:1,Grep:1,Task:1,WebFetch:1,MultiEdit:1};
function mdLite(s){
  var e=escHtml(s);
  e=e.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  e=e.replace(/#(\\d+)/g,'<a href="/apps/'+R+'/pulls/$1">#$1</a>');
  return e;
}
function classify(c){
  var b=(c.body||'').trim();
  if(c.author!=='crew') return {kind:'human',body:b,author:c.author};
  if(/^(✅|⚠️|❌)/.test(b)){var k=b.indexOf('✅')===0?'pass':b.indexOf('⚠️')===0?'warn':'fail';return {kind:'verdict',v:k,body:b};}
  if(/^(🏗️|🔍|🚀|🌱)/.test(b)) return {kind:'phase',body:b};
  if(/^… /.test(b)){var rest=b.slice(2).trim();var w=rest.split(/\\s+/)[0];
    if(TOOLS[w]) return {kind:'tool',tool:w,rest:rest.slice(w.length).trim()};
    return {kind:'prose',body:rest};}
  return {kind:'prose',body:b};
}
function render(c){
  var m=classify(c);var t=relTime(c.ts||c.created_at);
  if(m.kind==='verdict') return '<div class="feed-block feed-verdict '+m.v+'"><span class="v-icon">'+(m.v==='pass'?'✅':m.v==='warn'?'⚠️':'❌')+'</span><span class="grow">'+mdLite(m.body.replace(/^(✅|⚠️|❌)\\s*/,''))+'</span><span class="feed-t">'+t+'</span></div>';
  if(m.kind==='phase') return '<div class="feed-block feed-phase"><span class="grow">'+mdLite(m.body)+'</span><span class="feed-t">'+t+'</span></div>';
  if(m.kind==='tool') return '<details class="feed-block tool"><summary><span class="dot running"></span><code>'+m.tool.toLowerCase()+'</code><span class="grow">'+escHtml(m.rest||'')+'</span><span class="feed-t">'+t+'</span></summary></details>';
  if(m.kind==='human') return '<div class="feed-block feed-human card pad"><b>@'+escHtml(m.author)+'</b> <span class="feed-t">'+t+'</span><div class="prose mt-s">'+mdLite(m.body)+'</div></div>';
  return '<div class="feed-block"><div class="feed-body prose">'+mdLite(m.body)+'</div></div>';
}
async function refresh(){
  var r=await fetch('/api/v1/repos/'+R+'/issues/'+N); if(!r.ok) return;
  var d=await r.json(); var el=document.getElementById('feed');
  var cs=d.comments||[];
  document.getElementById('cmts').textContent=cs.length?cs.length+' update'+(cs.length>1?'s':''):'';
  if(firstRender){el.innerHTML=cs.length?cs.map(render).join(''):'<div class="mut" style="font-size:13px">No activity yet — the crew posts here as it works.</div>';cs.forEach(function(c){seen[c.id]=1});firstRender=false;
    var f=el;f.scrollTop=f.scrollHeight;return;}
  var fresh=cs.filter(function(c){return !seen[c.id]});
  if(fresh.length){if(el.querySelector('.mut'))el.innerHTML='';fresh.forEach(function(c){seen[c.id]=1;el.insertAdjacentHTML('beforeend',render(c));});}
  // reflect pipeline/label changes without a reload
  if(d.labels!==undefined && d.labels!==window._lbl){window._lbl=d.labels;}
}
async function assign(b){b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/repos/'+R+'/issues/'+N+'/labels',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({labels:['agent-work']})});
  if(r.ok){toast('assigned — the crew is on it');setTimeout(function(){location.reload()},700);}else{b.classList.remove('is-loading');b.disabled=false;toast('failed');}
}
async function closeIssue(b){b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/repos/'+R+'/issues/'+N+'/close',{method:'POST'});
  if(r.ok){toast('closed');setTimeout(function(){location.href='/apps/'+R},600);}else{b.classList.remove('is-loading');b.disabled=false;toast('failed');}
}
async function addComment(e){e.preventDefault();var i=document.getElementById('cbody');var b=i.value.trim();if(!b)return false;
  var r=await fetch('/api/v1/repos/'+R+'/issues/'+N+'/comments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:b})});
  if(r.ok){i.value='';refresh();}else toast('failed');return false;}
refresh();setInterval(refresh,2000);`,
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
      return page(
        "Lineage",
        chrome("lineage", [{ label: "Lineage" }]),
        body,
        "",
      );
    }

    return null;
  };
}

function notFound(back: string): string {
  return `<h1>Not found</h1><p class="sub"><a href="${back}">← back</a></p>`;
}
