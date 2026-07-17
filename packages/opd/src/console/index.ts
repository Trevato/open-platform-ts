import type { StateDir } from "@op/core";
import type { Forge } from "@op/forge";
import type { GitHost } from "@op/git";
import { readLineage } from "@op/mitosis";
import type { Store } from "@op/store";
import { readAppSpecs } from "../gitops.ts";
import { computeIntegrationMap } from "../integration.ts";
import type { AppPolicy } from "../manifest.ts";
import { isSelfRepo, OPD, PLAT } from "../platform-config.ts";
import { authorizeFor } from "../oidc.ts";
import { hostFor } from "../policy.ts";
import { BLOB_JS, blobView } from "./blob.ts";
import { DocsSource, docsRoute } from "./docs.ts";
import { type Chrome, type Crumb, esc, html, page } from "./layout.ts";
import { STYLE } from "./style.ts";

export interface ConsoleDeps {
  forge: Forge;
  store: Store;
  git: GitHost;
  sd: StateDir;
  domain: string;
  appPolicy: () => AppPolicy;
  /** Shared with the API and the guide — cached on plat/platform's main sha. */
  docs: DocsSource;
  /** False without a Claude credential — the chrome hides the Ask button. */
  guideEnabled: boolean;
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

// App status in plain words for a non-technical reader. The raw state still
// drives the status-dot color; this is only the human-readable label.
function friendlyState(state: string): string {
  if (state === "running") return "working fine";
  if (state === "error" || state === "failed" || state === "stopped")
    return "needs attention";
  return "starting up"; // pending / queued / building
}

// The work-item stepper, driven from `phase` — the process truth — never from
// labels (which are taxonomy only). Human mapping: intent/queued = "Got it",
// building/reworking = "Building it", reviewing = "Making sure it works",
// shipped = "Live". Parked marks the step waiting on a human; closed items
// render no stepper (the closed pill is explicit).
function stepper(phase: string, parkedReason: string | null): string {
  type S = "pending" | "active" | "done" | "failed";
  let got: S = "done";
  let building: S = "pending";
  let review: S = "pending";
  let live: S = "pending";
  if (phase === "intent" || phase === "queued") got = "active";
  else if (phase === "building" || phase === "reworking") building = "active";
  else if (phase === "reviewing") {
    building = "done";
    review = "active";
  } else if (phase === "shipped") {
    building = review = live = "done";
  } else if (phase === "parked") {
    const atBuild =
      parkedReason === "build-failed" || parkedReason === "daemon-restarted";
    building = atBuild ? "failed" : "done";
    if (!atBuild) review = "failed";
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
  return `<ol class="pipeline">${step(got, "Got it")}${step(building, "Building it")}${step(review, "Making sure it works")}${step(live, "Live")}</ol>`;
}

// Phase → pill class/label, shared by the Work list and the detail page.
function phasePillCls(phase: string): string {
  return phase === "queued"
    ? "open"
    : phase === "building" || phase === "reworking"
      ? "building"
      : phase === "reviewing"
        ? "reviewing"
        : phase === "shipped"
          ? "ok"
          : phase === "parked"
            ? "fail"
            : phase === "closed"
              ? "closed"
              : "";
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

    // Docs are the one PUBLIC console surface: product docs carry no secrets,
    // and a shared /docs link must not bounce through login. The chrome still
    // reflects a session when one exists.
    if (path === "/docs" || path.startsWith("/docs/")) {
      const reader = await deps.forge.authenticate(req);
      return docsRoute(req, path, {
        docs: deps.docs,
        domain: deps.domain,
        user: reader?.username ?? null,
        guide: deps.guideEnabled && reader !== null,
      });
    }

    // Everything below is the authenticated console. Non-console paths return
    // null so the forge/API routers get their turn.
    const isConsolePath =
      path === "/" ||
      path === "/lineage" ||
      path === "/crew" ||
      path === "/platform" ||
      path === "/integrations" ||
      path === "/orgs" ||
      path.startsWith("/orgs/") ||
      path.startsWith("/apps/");
    if (!isConsolePath) return null;

    const user = await deps.forge.authenticate(req);
    if (!user) return redirect("/login");
    const chrome = (active: Chrome["active"], crumbs?: Crumb[]): Chrome => ({
      domain: deps.domain,
      user: user.username,
      active,
      guide: deps.guideEnabled,
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
  <div class="foot"><span class="state" data-state="${esc(s.owner)}/${esc(s.app)}">${esc(friendlyState(state))}</span></div>
</a>`;
        })
        .join("");

      const starters: Array<{ label: string; text: string }> = [
        {
          label: "Vacation requests",
          text: "I keep track of vacation requests for our office — who asked, the dates, and whether their manager approved",
        },
        {
          label: "Visitor sign-in",
          text: "I sign visitors in and out at the front desk and need a log of who was in the building and when",
        },
        {
          label: "Supply requests",
          text: "People ask me for office supplies — I need a request form and a list showing what's been ordered and what's arrived",
        },
        {
          label: "Room bookings",
          text: "I manage bookings for our two meeting rooms so people stop double-booking them",
        },
        {
          label: "Expense claims",
          text: "I collect expense claims, check the receipts, and record when each one is approved and when it's paid",
        },
        {
          label: "Maintenance log",
          text: "People report building problems to me — a leaky faucet, a broken printer — and I track each one until it's fixed",
        },
        {
          label: "New-hire checklist",
          text: "Every new hire needs the same steps done — badge, email, payroll, desk — and I track where each person is in the process",
        },
        {
          label: "Client follow-ups",
          text: "After each client call I write down what we promised, and I need reminders of who to follow up with and when",
        },
      ];
      const starterChips = starters
        .map(
          (s) =>
            `<button type="button" class="chip starter" data-fill="${esc(s.text)}">${esc(s.label)}</button>`,
        )
        .join("");

      // The on-ramp leads: describe a task in plain words → a working tool.
      const onramp = `
<div class="onramp">
  <h1 class="m0">${apps.length ? "Build another tool" : "What do you spend time on?"}</h1>
  <p class="sub">${apps.length ? "Describe another task you handle, in your own words, and I'll build you a tool for it." : "Describe one task you handle, in your own words. You'll have a working tool for it — built, checked, and live — usually within a few minutes."}</p>
  <form class="onramp-form" onsubmit="return onramp(event)">
    <textarea id="desc" class="grow" rows="2" placeholder="For example: I keep track of vacation requests for our office — who asked, the dates, and whether their manager approved." required autofocus></textarea>
    <button type="submit" id="onrampbtn">Build my tool</button>
  </form>
  <p class="onramp-note">You'll watch it get built and checked, step by step. Nothing is final — ask for changes any time.</p>
  <div class="starters-label">Or start from something familiar — click one, then make it yours:</div>
  <div class="starters" id="starters">${starterChips}</div>
</div>`;

      const advanced = `
<details class="advanced">
  <summary>More ways to start</summary>
  <form class="newapp" onsubmit="return createApp(event)">
    <input type="text" id="appname" class="mono grow" placeholder="or name a blank app" pattern="[a-z0-9][a-z0-9-]*" title="lowercase letters, digits, hyphens" required>
    <button type="submit" id="createbtn" class="secondary">Create blank app</button>
  </form>
  <form class="newapp" onsubmit="return importApp(event)">
    <input type="text" id="importurl" class="mono grow" placeholder="https://github.com/owner/repo — import an existing repo" required>
    <button type="submit" id="importbtn" class="secondary">Import from GitHub</button>
  </form>
</details>`;

      const body = `
${onramp}
${apps.length ? `<h2 class="mt">Your tools</h2><div class="grid">${cards}</div>` : ""}
${advanced}`;

      return page(
        "Apps",
        chrome("apps", [{ label: "Apps" }]),
        body,
        `
async function onramp(e){
  e.preventDefault();
  var d=document.getElementById('desc').value.trim();
  if(!d) return false;
  var b=document.getElementById('onrampbtn');b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/onramp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({description:d})});
  var j=await r.json().catch(function(){return{}});
  if(r.ok){toast('building your tool…');location.href='/apps/'+j.owner+'/'+j.app+'/work/'+j.issue;}
  else {b.classList.remove('is-loading');b.disabled=false;toast(j.error||'failed');}
  return false;
}
document.querySelectorAll('#starters .starter').forEach(function(c){
  c.addEventListener('click',function(){var d=document.getElementById('desc');d.value=c.dataset.fill;d.focus();});
});
// Cmd/Ctrl+Enter submits the on-ramp from the textarea.
(function(){var d=document.getElementById('desc');if(d)d.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){onramp(e);}});})();
function friendly(s){return s==='running'?'working fine':(s==='error'||s==='failed'||s==='stopped'?'needs attention':'starting up');}
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
async function importApp(e){
  e.preventDefault();
  var url=document.getElementById('importurl').value.trim();
  if(!url) return false;
  var b=document.getElementById('importbtn');b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/apps/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:url})});
  var j=await r.json().catch(function(){return{}});
  if(r.ok){toast('importing '+j.app+' — crew tuning it…');location.href='/apps/'+j.owner+'/'+j.app;}
  else {b.classList.remove('is-loading');b.disabled=false;toast(j.error||'failed');}
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
      if(dot){dot.className='dot '+a.state;} if(st){st.textContent=friendly(a.state);}
    });
  }catch(_){}
}
setInterval(refresh,2500);`,
        { wide: true },
      );
    }

    // ── orgs list ───────────────────────────────────────────────────────
    if (path === "/orgs") {
      const orgs = deps.store.listOrgsForUser(user.id);
      const cards = orgs
        .map((o) => {
          const n = deps.store.listReposByOwner(o.name).length;
          return `<a class="card app" href="/orgs/${esc(o.name)}">
  <div class="name"><span class="dot running"></span>${esc(o.display_name || o.name)}</div>
  <div class="host">${esc(o.name)}</div>
  <div class="foot"><span class="state">${n} repo${n === 1 ? "" : "s"}</span></div>
</a>`;
        })
        .join("");
      const body = `
<h1>Orgs</h1>
<p class="sub">An org is a shared namespace for a business — its repos and apps live under one name, visible to every member. Create one to visualize a product's software in a single place.</p>
<form class="newapp" onsubmit="return createOrg(event)">
  <input type="text" id="orgname" class="mono grow" placeholder="acme" pattern="[a-z0-9][a-z0-9-]*" title="lowercase letters, digits, hyphens" required>
  <input type="text" id="orgdisplay" class="grow" placeholder="Display name (optional)">
  <button type="submit" id="createorg">Create org</button>
</form>
${orgs.length ? `<div class="grid">${cards}</div>` : `<div class="empty">You're not in any orgs yet. Create one above.</div>`}`;
      return page(
        "Orgs",
        chrome("orgs", [{ label: "Orgs" }]),
        body,
        `
async function createOrg(e){
  e.preventDefault();
  var name=document.getElementById('orgname').value.trim();
  var disp=document.getElementById('orgdisplay').value.trim();
  if(!name) return false;
  var b=document.getElementById('createorg');b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/orgs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name,displayName:disp})});
  if(r.ok){toast('created '+name);location.href='/orgs/'+name;}
  else {b.classList.remove('is-loading');b.disabled=false;var j=await r.json().catch(function(){return{}});toast(j.error||'failed');}
  return false;
}`,
        { wide: true },
      );
    }

    // ── org overview ────────────────────────────────────────────────────
    const orgM = path.match(/^\/orgs\/([^/]+)$/);
    if (orgM) {
      const orgName = orgM[1]!;
      const org = deps.store.getOrg(orgName);
      const back: Crumb[] = [
        { label: "Orgs", href: "/orgs" },
        { label: orgName },
      ];
      if (!org)
        return page("Not found", chrome("orgs", back), notFound("/orgs"));
      const isMember = deps.store.isOrgMember(orgName, user.id);
      const members = deps.store.listOrgMembers(orgName);
      const specs = await readAppSpecs(deps.git, deps.domain);
      const apps =
        specs.status === "ok"
          ? specs.value.filter((s) => s.owner === orgName)
          : [];
      const repos = deps.store.listReposByOwner(orgName);
      const appNames = new Set(apps.map((s) => s.app));
      const appCards = apps
        .map((s) => {
          const st = deps.store.getAppStatus(s.owner, s.app);
          const state = st?.state ?? "pending";
          return `<a class="card app" href="/apps/${esc(s.owner)}/${esc(s.app)}">
  <div class="name"><span class="dot ${esc(state)}"></span>${esc(s.app)}</div>
  <div class="host">${esc(hostFor(s, deps.domain))}</div>
  <div class="foot"><span class="state">${esc(state)}</span></div>
</a>`;
        })
        .join("");
      // Repos with no app spec (e.g. an imported/plain repo) still belong to the
      // org's software picture — surface them so nothing is invisible.
      const bareRepos = repos
        .filter((r) => !appNames.has(r.name))
        .map(
          (r) =>
            `<a class="card app" href="/apps/${esc(r.owner)}/${esc(r.name)}">
  <div class="name"><span class="dot"></span>${esc(r.name)}</div>
  <div class="host">repo</div>
  <div class="foot"><span class="state">no app spec</span></div>
</a>`,
        )
        .join("");
      const memberPills = members
        .map(
          (m) =>
            `<span class="pill">${esc(m.username)}${m.role === "owner" ? " · owner" : ""}</span>`,
        )
        .join(" ");
      const body = `
<h1 class="m0">${esc(org.display_name || org.name)}</h1>
<p class="sub"><span class="mono">${esc(org.name)}</span> · ${apps.length} app${apps.length === 1 ? "" : "s"} · ${members.length} member${members.length === 1 ? "" : "s"}</p>

<div class="card idcard">
  <span class="k">Members</span><span class="v">${memberPills || "—"}</span>
</div>

${
  isMember
    ? `<form class="newapp" onsubmit="return createOrgApp(event)">
  <input type="text" id="appname" class="mono grow" placeholder="new-app-name" pattern="[a-z0-9][a-z0-9-]*" title="lowercase letters, digits, hyphens" required>
  <button type="submit" id="createbtn">Create app in ${esc(org.name)}</button>
</form>
<form class="newapp" onsubmit="return addMember(event)">
  <input type="text" id="newmember" class="mono grow" placeholder="username to add" required>
  <button type="submit" id="addmemberbtn" class="secondary">Add member</button>
</form>`
    : `<div class="empty">You're not a member of ${esc(org.name)} — read-only view.</div>`
}

<h2 class="mt">Software</h2>
${
  apps.length || bareRepos
    ? `<div class="grid">${appCards}${bareRepos}</div>`
    : `<div class="empty">No software yet. ${isMember ? "Create an app above, or import a repo." : ""}</div>`
}`;
      return page(
        org.display_name || org.name,
        chrome("orgs", back),
        body,
        `
var ORG=${JSON.stringify(orgName)};
async function createOrgApp(e){
  e.preventDefault();
  var name=document.getElementById('appname').value.trim();if(!name)return false;
  var b=document.getElementById('createbtn');b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/apps',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name,owner:ORG})});
  if(r.ok){toast('creating '+name+'…');location.href='/apps/'+ORG+'/'+name;}
  else {b.classList.remove('is-loading');b.disabled=false;var j=await r.json().catch(function(){return{}});toast(j.error||'failed');}
  return false;
}
async function addMember(e){
  e.preventDefault();
  var u=document.getElementById('newmember').value.trim();if(!u)return false;
  var b=document.getElementById('addmemberbtn');b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/orgs/'+ORG+'/members',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u})});
  b.classList.remove('is-loading');b.disabled=false;
  if(r.ok){toast('added '+u);location.reload();}
  else {var j=await r.json().catch(function(){return{}});toast(j.error||'failed');}
  return false;
}`,
        { wide: true },
      );
    }

    // ── integrations ────────────────────────────────────────────────────
    // The derived app graph, as two tables: what each app offers and needs,
    // and every consume edge. Recomputed per request — nothing to go stale.
    if (path === "/integrations") {
      const map = await computeIntegrationMap({
        git: deps.git,
        store: deps.store,
        domain: deps.domain,
        policy: deps.appPolicy(),
      });
      const statePill = (state: string | null) => {
        const s = state ?? "pending";
        const cls =
          s === "running"
            ? "ok"
            : s === "error" || s === "failed" || s === "stopped"
              ? "fail"
              : "building";
        return `<span class="pill ${cls}">${esc(s)}</span>`;
      };
      const appLink = (owner: string, app: string) =>
        `<a class="mono" href="/apps/${esc(owner)}/${esc(app)}">${esc(owner)}/${esc(app)}</a>`;
      const dash = '<span class="faint">—</span>';
      const appRows = map.apps
        .map((a) => {
          const provides =
            a.provides
              .map(
                (p) =>
                  `<span class="pill" data-tip="${esc(`${p.path} — ${p.description}`)}">${esc(p.name)}</span>`,
              )
              .join(" ") || dash;
          const tcp =
            a.tcp
              .map(
                (t) =>
                  `<span class="mono nowrap">${esc(deps.domain)}:${t.publicPort} → :${t.containerPort}</span>`,
              )
              .join("<br>") || dash;
          const manifest = a.manifestError
            ? `<span class="err">${esc(a.manifestError)}</span>`
            : dash;
          return `<tr><td>${appLink(a.owner, a.app)}</td><td>${statePill(a.state)}</td><td>${provides}</td><td>${tcp}</td><td>${manifest}</td></tr>`;
        })
        .join("");
      const edgeRows = map.edges
        .map((e) => {
          // A missing peer has no page — name it, don't link it.
          const to = e.satisfied
            ? appLink(e.to.owner, e.to.app)
            : `<span class="mono">${esc(e.to.owner)}/${esc(e.to.app)}</span>`;
          const pill = e.satisfied
            ? '<span class="pill ok">deployed</span>'
            : '<span class="pill fail">not deployed</span>';
          return `<tr><td>${appLink(e.from.owner, e.from.app)}</td><td>${to}</td><td>${pill}</td></tr>`;
        })
        .join("");
      const body = `
<h1>Integrations</h1>
<p class="sub">How your software connects — derived live from each app's <code>op.json</code> at its deployed ref. Nothing here is stored, so the map can never go stale.</p>
<h2>Apps</h2>
${
  map.apps.length
    ? `<div class="tablewrap"><table class="data">
<thead><tr><th>App</th><th>Status</th><th>Provides</th><th>TCP</th><th>Manifest</th></tr></thead>
<tbody>${appRows}</tbody></table></div>`
    : `<div class="empty">No apps yet. Build one from the <a href="/">dashboard</a>.</div>`
}
<h2 class="mt">Connections</h2>
${
  map.edges.length
    ? `<div class="tablewrap"><table class="data">
<thead><tr><th>From</th><th>Consumes</th><th>Status</th></tr></thead>
<tbody>${edgeRows}</tbody></table></div>`
    : `<div class="empty">No app declares a peer yet — add <code>consumes</code> to an app's <code>op.json</code>.</div>`
}`;
      return page(
        "Integrations",
        chrome("integrations", [{ label: "Integrations" }]),
        body,
        "",
        { wide: true },
      );
    }

    // ── source viewer ───────────────────────────────────────────────────
    // /apps/:owner/:app/blob/:ref/<path> — any readable repo file with line
    // anchors (#L42, #L42-60). Docs code references land here.
    const bm = path.match(/^\/apps\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (bm) {
      const [, owner, app, ref, filePath] = bm as unknown as [
        string,
        string,
        string,
        string,
        string,
      ];
      const back: Crumb[] = [
        { label: "Apps", href: "/" },
        { label: app, href: `/apps/${owner}/${app}` },
        { label: filePath.split("/").pop() ?? filePath },
      ];
      if (!deps.forge.authorize(user, owner, app, "read"))
        return page("Not found", chrome("apps", back), notFound("/"));
      const view = await blobView(
        deps.git,
        owner,
        app,
        decodeURIComponent(ref),
        decodeURIComponent(filePath),
      );
      if (!view.body)
        return page(
          "Not found",
          chrome("apps", back),
          notFound(`/apps/${esc(owner)}/${esc(app)}`),
        );
      return page(view.title, chrome("apps", back), view.body, BLOB_JS, {
        wide: true,
      });
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
      // System/self repos (plat/opd source, plat/platform config, sys/gitops)
      // are NOT deployed apps — they have no URL, image, deploys or logs. Show
      // them as repos: identity + issues + PRs, none of the deploy chrome.
      const isSelf = isSelfRepo(owner, app) || owner === "sys";
      const role =
        app === OPD.name
          ? "platform source"
          : app === PLAT.name
            ? "platform config"
            : "system repo";
      // Raw-TCP ports the platform relays for this app (op.json tcpPorts).
      // The public address is the whole point — it's what a player pastes
      // into their game client.
      const connectRows = deps.store
        .listAppPortsFor(owner, app)
        .map(
          (p) =>
            `<span class="k">Connect</span><span class="v"><button class="btn ghost sm" onclick="copy('${esc(`${deps.domain}:${p.public_port}`)}')" data-tip="Copy address — paste it into the game client"><code>${esc(deps.domain)}:${p.public_port}</code> ⧉</button> <span class="mut">TCP → container :${p.container_port}</span></span>`,
        )
        .join("");

      const body = `
<div class="row between">
  <h1 class="m0">${isSelf ? "" : `<span class="dot ${esc(state)}" id="dot"></span>`}${esc(app)}</h1>
  ${isSelf ? "" : `<a class="btn secondary sm" href="${esc(appUrl)}" target="_blank" rel="noopener">Open ↗</a>`}
</div>
${
  isSelf
    ? `<p class="sub">${esc(owner)}/${esc(app)} · ${esc(role)}</p>`
    : `<p class="sub"><span class="state" id="state">${esc(state)}</span>${st?.message ? ` · <span class="mut" id="stmsg">${esc(st.message)}</span>` : ""}</p>`
}

<div class="card idcard">
  ${isSelf ? "" : `<span class="k">URL</span><span class="v"><a href="${esc(appUrl)}" target="_blank" rel="noopener">${esc(appUrl)}</a></span>`}
  <span class="k">Clone</span><span class="v"><button class="btn ghost sm" onclick="copy(${JSON.stringify(cloneUrl)})" data-tip="Copy git URL">${esc(cloneUrl)} ⧉</button></span>
  ${isSelf ? "" : `<span class="k">Image</span><span class="v" id="digest">${st?.image_digest ? esc(st.image_digest.slice(0, 26)) + "…" : "—"}</span>`}
  ${connectRows}
</div>

<div class="tabs" role="tablist">
  <button class="tab on" data-pane="work" role="tab">Work <span class="mut" id="wc"></span></button>
  ${
    isSelf
      ? ""
      : `<button class="tab" data-pane="deploys" role="tab">Deploys</button>
  <button class="tab" data-pane="logs" role="tab">Logs</button>`
  }
</div>

<div class="row between mt filterbar" id="filterbar">
  <input type="text" id="fq" class="grow" placeholder="Search work…">
  <div class="tabs sm" id="fstate">
    <button class="tab on" data-v="open" type="button">Open</button>
    <button class="tab" data-v="closed" type="button">Closed</button>
    <button class="tab" data-v="all" type="button">All</button>
  </div>
  <select id="fsort" aria-label="Sort"><option value="new">Newest</option><option value="old">Oldest</option></select>
</div>

<div class="tabpane on mt-s" id="pane-work">
  ${
    canWrite
      ? `<form class="newapp" id="composer-form" onsubmit="return compose(event)">
    <input type="text" id="idea" class="grow" placeholder="Tell me what to change — I'll build it, check it works, and make it live" required>
    <button type="submit" id="composebtn">Change it</button>
  </form>
  <div id="draft"></div>`
      : ""
  }
  <div class="rows" id="work"><div class="mut">loading…</div></div>
</div>

<div class="tabpane mt" id="pane-deploys">
  ${
    canWrite
      ? `<div class="row mb"><button class="btn secondary sm" onclick="snap(this)">Snapshot data</button>
  <span class="mut" style="font-size:12px">checkpoint → copy-on-write clone → integrity_check</span></div>`
      : ""
  }
  <div id="deploys"><div class="mut">loading…</div></div>
</div>

<div class="tabpane mt" id="pane-logs">
  <div class="label mb">Build log</div>
  <pre class="logs" id="build">—</pre>
  <div class="row between mb mt"><span class="label"><span class="dot running" id="loglive" style="width:6px;height:6px"></span> Runtime</span><span class="mut" style="font-size:12px" id="logts"></span></div>
  <pre class="logs" id="logs">loading…</pre>
</div>`;

      return page(
        app,
        chrome("apps", back),
        body,
        `
var KEY=${JSON.stringify(`${owner}/${app}`)};
// Every bit of view state (tab, filter, search, sort) lives in the URL, so a
// filtered view is a shareable link and back/forward just works.
var U=urlState({tab:enP(['work','deploys','logs'],'work'),state:enP(['open','closed','all'],'open'),q:strP(''),sort:enP(['new','old'],'new')});
var lastWork=[];

function activateTab(tab){
  document.querySelectorAll('.tab[data-pane]').forEach(function(x){x.classList.toggle('on',x.dataset.pane===tab)});
  document.querySelectorAll('.tabpane').forEach(function(p){p.classList.toggle('on',p.id==='pane-'+tab)});
  document.getElementById('filterbar').classList.toggle('hide',tab!=='work');
}
function syncControls(){var s=U.read();document.getElementById('fq').value=s.q;
  document.querySelectorAll('#fstate .tab').forEach(function(b){b.classList.toggle('on',b.dataset.v===s.state)});
  document.getElementById('fsort').value=s.sort;}
function filt(list,text){var s=U.read();var q=s.q.toLowerCase();
  var out=list.filter(function(x){return !q||text(x).toLowerCase().indexOf(q)>=0;});
  out.sort(function(a,b){return s.sort==='old'?a.number-b.number:b.number-a.number;});return out;}
function phaseCls(p){return p==='queued'?'open':(p==='building'||p==='reworking')?'building':p==='reviewing'?'reviewing':p==='shipped'?'ok':p==='parked'?'fail':p==='closed'?'closed':'';}
function phasePill(it){
  var txt=it.phase==='parked'&&it.parkedReason?('parked · '+it.parkedReason):it.phase;
  return '<span class="pill '+phaseCls(it.phase)+'">'+escHtml(txt)+'</span>';
}
function workRow(it){
  var labs=(it.labels||[]).map(function(l){return '<span class="pill'+(l.indexOf('agent')===0?' agent':'')+'">'+escHtml(l)+'</span>';}).join('');
  var blk=(it.blockedBy&&it.blockedBy.length)?'<span class="pill blocked" data-tip="Crew waits until these ship">blocked by '+it.blockedBy.map(function(b){return escHtml((b.repo===it.repo?'':b.repo)+'#'+b.number);}).join(', ')+'</span>':'';
  var chg=it.change?'<span class="pill '+(it.change.state==='open'?'open':escHtml(it.change.state||''))+'" data-tip="change on branch '+escHtml(it.change.head)+'">⎇ '+escHtml(it.change.head)+'</span>':'';
  return '<a class="list-row" href="/apps/'+KEY+'/work/'+it.number+'"><span class="num">#'+it.number+'</span><span class="ttl">'+escHtml(it.title)+'</span><span class="meta">'+blk+labs+chg+phasePill(it)+'</span></a>';
}
function renderLists(){
  var items=filt(lastWork,function(x){return x.title+' '+(x.labels||[]).join(' ')});
  document.getElementById('wc').textContent=items.length||'';
  document.getElementById('work').innerHTML=items.length?items.map(workRow).join(''):'<div class="mut" style="font-size:13px;padding:8px 0">'+(lastWork.length?'No work matches your filter.':'No work yet. Describe a change above.')+'</div>';
}
// A deploy = one sha's phase sequence. Grouping answers "did this finish?" —
// each deploy shows the phase it actually reached (queued→…→running/failed).
function phaseBare(p){return p.replace(/\\s*\\(pr-\\d+\\)\\s*/,'');}
function renderDeploys(events){
  var groups=[],by={};
  events.forEach(function(e){var prev=(e.phase.match(/\\(pr-\\d+\\)/)||[])[0];var key=(e.sha||'?')+(prev||'');
    if(!by[key]){by[key]={sha:e.sha||'?',preview:(e.phase.match(/pr-\\d+/)||[])[0]||null,latest:e,evs:[]};groups.push(by[key]);}
    by[key].evs.push(e);});
  if(!groups.length)return '<div class="mut" style="font-size:13px">No deploys yet.</div>';
  return groups.map(function(g,i){
    var cur=phaseBare(g.latest.phase);
    var done=cur==='running'||cur==='preview-ready';var bad=cur.indexOf('fail')>=0;
    var dc=done?'running':(bad?'error':'building');
    var pc=done?'ok':(bad?'fail':'building');
    var tag=g.preview?'<span class="pill building">'+g.preview+'</span>':'<span class="pill">prod</span>';
    var trail=g.evs.slice().reverse().map(function(e){return phaseBare(e.phase);}).join(' › ');
    return '<div class="card pad mb" style="padding:11px 14px"><div class="row between">'+
      '<span class="row" style="gap:8px"><span class="dot '+dc+'"></span><span class="mono" style="font-size:12px">'+escHtml(g.sha.slice(0,10))+'</span>'+tag+'<span class="pill '+pc+'">'+cur+'</span></span>'+
      '<span class="mut" style="font-size:12px">'+relTime(g.latest.ts)+'</span></div>'+
      (i===0?'<div class="mono mt-s" style="font-size:11px;color:var(--faint)">'+escHtml(trail)+'</div>':'')+'</div>';
  }).join('');
}
function stateParam(){var s=U.read().state;return s==='all'?'':'?state='+s;}
async function tick(){
  if(document.hidden) return;
  try{
    var r=await fetch('/api/v1/apps/'+KEY);
    if(r.ok){var a=await r.json();document.getElementById('dot').className='dot '+a.state;document.getElementById('state').textContent=a.state;
      var dg=document.getElementById('digest');if(dg&&a.imageDigest)dg.textContent=a.imageDigest.slice(0,26)+'…';}
    var wl=await fetch('/api/v1/repos/'+KEY+'/work'+stateParam());
    if(wl.ok){lastWork=(await wl.json()).work||[];}
    renderLists();
    var ev=await fetch('/api/v1/apps/'+KEY+'/events');
    if(ev.ok){document.getElementById('deploys').innerHTML=renderDeploys((await ev.json()).events||[]);}
    var bl=await fetch('/api/v1/apps/'+KEY+'/buildlog');
    if(bl.ok){document.getElementById('build').textContent=(await bl.text())||'—';}
    var lg=await fetch('/api/v1/apps/'+KEY+'/logs');
    if(lg.ok){var t=await lg.text();var lel=document.getElementById('logs');var atBottom=lel.scrollTop+lel.clientHeight>=lel.scrollHeight-8;
      lel.textContent=t||'(no output yet — the app has not logged anything since it started)';if(atBottom)lel.scrollTop=lel.scrollHeight;
      document.getElementById('logts').textContent='updated '+new Date().toLocaleTimeString();}
  }catch(_){document.getElementById('logts').textContent='reconnecting…';}
}
// wire up tabs (pushState — discrete nav) + filters (replaceState, throttled)
document.querySelectorAll('.tab[data-pane]').forEach(function(t){t.onclick=function(){U.set({tab:t.dataset.pane},{push:true});activateTab(t.dataset.pane);};});
document.getElementById('fq').oninput=function(){U.set({q:this.value},{throttle:true});renderLists();};
document.querySelectorAll('#fstate .tab').forEach(function(b){b.onclick=function(){U.set({state:b.dataset.v});syncControls();tick();};});
document.getElementById('fsort').onchange=function(){U.set({sort:this.value});renderLists();};
U.onpop(function(){var s=U.read();activateTab(s.tab);syncControls();tick();});
activateTab(U.read().tab);syncControls();
async function snap(b){b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/apps/'+KEY+'/snapshots',{method:'POST'});
  var j=await r.json().catch(function(){return{}});
  b.classList.remove('is-loading');b.disabled=false;
  toast(r.ok?('snapshot '+j.id):(j.error||'snapshot failed'));
}
// Curating flow: a rough idea → the composer drafts a structured issue you
// edit → File. Streams the model's real state (thinking → drafting) so the UI
// stays responsive; degrades to the editable form if the composer can't answer.
function composerWorking(phase,reasoning){
  var label=phase==='drafting'?'drafting the spec':'thinking';
  document.getElementById('draft').innerHTML=
    '<div class="card pad mt-s"><div class="row" style="gap:8px;margin-bottom:10px"><span class="dot building"></span>'+
    '<span class="mut" style="font-size:13px">'+label+'…</span><span class="mut" id="c-elapsed" style="font-size:12px;margin-left:auto"></span></div>'+
    (reasoning?'<pre class="logs" id="c-reason" style="max-height:120px;font-size:11.5px">'+escHtml(reasoning)+'</pre>'
      :'<div class="sk line w80"></div><div class="sk line"></div><div class="sk line w60"></div>')+
    '</div>';
  var re=document.getElementById('c-reason');if(re)re.scrollTop=re.scrollHeight;
}
async function compose(e){
  e.preventDefault();
  var idea=document.getElementById('idea').value.trim();if(!idea)return false;
  var b=document.getElementById('composebtn');b.classList.add('is-loading');b.disabled=true;
  var degrade=function(msg){renderDraft(idea,{title:idea,body:'',labels:['agent-work'],acceptanceChecks:[]},true);if(msg)toast(msg);};
  var t0=Date.now();composerWorking('thinking','');
  var el=setInterval(function(){var x=document.getElementById('c-elapsed');if(x)x.textContent=Math.round((Date.now()-t0)/1000)+'s';},250);
  try{
    var r=await fetch('/api/v1/repos/'+KEY+'/issues/draft',{method:'POST',headers:{'content-type':'application/json','accept':'text/event-stream'},body:JSON.stringify({idea:idea})});
    if(!r.ok||!r.body){clearInterval(el);degrade(r.status===503?'composer offline — write a spec and file':'draft failed — write a spec and file');b.classList.remove('is-loading');b.disabled=false;return false;}
    var reader=r.body.getReader(),dec=new TextDecoder(),buf='',draft=null,phase='thinking',reasoning='',failed=false;
    while(true){
      var chunk=await reader.read();if(chunk.done)break;
      buf+=dec.decode(chunk.value,{stream:true});
      var parts=buf.split('\\n\\n');buf=parts.pop();
      for(var i=0;i<parts.length;i++){var line=parts[i];if(line.indexOf('data: ')!==0)continue;
        var msg;try{msg=JSON.parse(line.slice(6));}catch(_){continue;}
        if(msg.type==='event'){phase=msg.phase;if(msg.text)reasoning=(reasoning+msg.text).slice(-2000);composerWorking(phase,reasoning);}
        else if(msg.type==='draft'){draft=msg.draft;}
        else if(msg.type==='error'){failed=true;}
      }
    }
    clearInterval(el);
    if(draft)renderDraft(idea,draft,false);
    else degrade(failed?'composer offline — write a spec and file':'draft failed — write a spec and file');
  }catch(err){clearInterval(el);degrade('draft failed — write a spec and file');}
  b.classList.remove('is-loading');b.disabled=false;return false;
}
function renderDraft(idea,d,degraded){
  window._idea=idea;
  var spec=(d.body||'')+((d.acceptanceChecks&&d.acceptanceChecks.length)?'\\n\\nAcceptance checks:\\n'+d.acceptanceChecks.map(function(c){return '- '+c}).join('\\n'):'');
  var labels=d.labels&&d.labels.length?d.labels:['agent-work'];
  var note=degraded?'couldn\\'t auto-draft — write the spec, then file':'drafted by the composer — edit anything';
  var ph=degraded?' placeholder="Describe what to build: the data, the endpoints, the UI, and the safety rules the reviewer will check."':'';
  document.getElementById('composer-form').classList.add('hide');
  document.getElementById('draft').innerHTML=
    '<div class="card pad stack mt-s'+(degraded?' warn':'')+'">'+
    '<div><div class="label mb">Title</div><input type="text" id="d-title" class="grow" value="'+escHtml(d.title||idea)+'"></div>'+
    '<div><div class="label mb">Spec</div><textarea id="d-body" rows="7"'+ph+'>'+escHtml(spec)+'</textarea></div>'+
    '<div class="row"><span class="label">Labels</span><span id="d-labels">'+labels.map(function(l){return '<span class="pill agent chip rm" data-l="'+escHtml(l)+'" onclick="this.remove()">'+escHtml(l)+' ×</span>'}).join(' ')+'</span></div>'+
    '<div class="row"><button onclick="fileDraft(this)">File issue</button><button class="btn ghost" onclick="rewrite()">Rewrite</button><span class="mut" style="font-size:12px">'+note+'</span></div>'+
    '</div>';
  if(degraded){var t=document.getElementById('d-body');if(t)t.focus();}
}
async function fileDraft(b){
  var title=document.getElementById('d-title').value.trim();var body=document.getElementById('d-body').value.trim();
  var labels=[].map.call(document.querySelectorAll('#d-labels [data-l]'),function(x){return x.dataset.l});
  b.classList.add('is-loading');b.disabled=true;await fileIssue(title,body,labels);
}
async function fileIssue(title,body,labels){
  var r=await fetch('/api/v1/repos/'+KEY+'/work',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:title,body:body,labels:labels})});
  var j=await r.json().catch(function(){return{}});
  if(r.ok){document.getElementById('draft').innerHTML='';var cf=document.getElementById('composer-form');cf.classList.remove('hide');document.getElementById('idea').value='';toast(labels.indexOf('agent-work')>=0?'filed — crew is on it':'work filed');tick();}
  else toast(j.error||'failed');
}
function rewrite(){document.getElementById('draft').innerHTML='';document.getElementById('composer-form').classList.remove('hide');var i=document.getElementById('idea');i.value=window._idea||'';i.focus();}
tick();setInterval(tick,1800);`,
      );
    }

    // ── legacy detail routes → the one work surface ─────────────────────
    // Issues ARE work items (identity — same numbers): straight redirect.
    const ir = path.match(/^\/apps\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
    if (ir) return redirect(`/apps/${ir[1]!}/${ir[2]!}/work/${ir[3]!}`);

    // Historic PR pages resolve via the FROZEN pull_requests table to their
    // linked work item (branch convention agent/issue-N); anything else gets
    // a tombstone — no new PR numbers are ever minted.
    const pm = path.match(/^\/apps\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (pm) {
      const [, owner, app, num] = pm as unknown as [
        string,
        string,
        string,
        string,
      ];
      const pr = deps.store.getPr(owner, app, Number(num));
      const linked = pr?.head_ref.match(/^agent\/issue-(\d+)$/);
      if (linked) return redirect(`/apps/${owner}/${app}/work/${linked[1]!}`);
      const back: Crumb[] = [
        { label: "Apps", href: "/" },
        { label: app, href: `/apps/${owner}/${app}` },
        { label: `PR #${num}` },
      ];
      return page(
        `PR #${num}`,
        chrome("apps", back),
        `<h1>Pull requests became work items</h1>
<p class="sub">${
          pr
            ? `Historic PR #${esc(num)} (<span class="mono">${esc(pr.head_ref)}</span>, ${esc(pr.state)}) predates the unified work surface and has no linked work item.`
            : `There is no PR #${esc(num)} here — changes now live on the app's Work tab.`
        }</p>
<p class="sub"><a href="/apps/${esc(owner)}/${esc(app)}">← back to ${esc(app)}</a></p>`,
      );
    }

    // ── work detail — intent + change + attempts + activity, one page ────
    const wm = path.match(/^\/apps\/([^/]+)\/([^/]+)\/work\/(\d+)$/);
    if (wm) {
      const [, owner, app, num] = wm as unknown as [
        string,
        string,
        string,
        string,
      ];
      const n = Number(num);
      const item = deps.store.getIssue(owner, app, n);
      const back: Crumb[] = [
        { label: "Apps", href: "/" },
        { label: app, href: `/apps/${owner}/${app}` },
        { label: `#${num}` },
      ];
      if (!item)
        return page(
          "Not found",
          chrome("apps", back),
          notFound(`/apps/${esc(owner)}/${esc(app)}`),
        );
      const canWrite = deps.forge.authorize(user, owner, app, "write");
      const labels = item.labels.split(",").filter(Boolean);
      const attempts = deps.store.listAttempts(owner, app, n);
      const changeOpen = item.change_state === "open";
      const previewHost = `pr-${item.number}-${app}-${owner}.${deps.domain}${url.port ? `:${url.port}` : ""}`;
      const diff =
        item.head_ref && item.base_ref
          ? await deps.git.diffStat(owner, app, item.base_ref, item.head_ref)
          : null;
      const patch = diff?.status === "ok" ? diff.value.patch : "";
      const nFiles = diff?.status === "ok" ? diff.value.files.length : 0;
      const phaseText =
        item.phase === "parked" && item.parked_reason
          ? `parked · ${item.parked_reason}`
          : item.phase;

      // Controls follow the legal edges: Queue (intent), Re-queue (parked),
      // Merge (open change in reviewing — the human rescue, mandatory for
      // self-repos which always park — or parked), Close (any non-terminal).
      const controls = canWrite
        ? [
            item.phase === "intent"
              ? `<button class="btn" onclick="act('queue',this,'queued — the crew is on it')">Send to crew</button>`
              : "",
            item.phase === "parked"
              ? `<button class="btn secondary" onclick="act('queue',this,'re-queued')">Re-queue</button>`
              : "",
            changeOpen &&
            (item.phase === "reviewing" || item.phase === "parked")
              ? `<button class="btn" onclick="act('merge',this,'merged — shipping')">Merge</button>`
              : "",
            item.state === "open"
              ? `<button class="btn ghost" onclick="act('close',this,'closed')">Close</button>`
              : "",
          ]
            .filter(Boolean)
            .join("")
        : "";

      const attemptRows = attempts
        .map((a) => {
          const cost = [
            a.builder_cost_usd != null
              ? `build $${a.builder_cost_usd.toFixed(2)}`
              : "",
            a.reviewer_cost_usd != null
              ? `review $${a.reviewer_cost_usd.toFixed(2)}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const vCls =
            a.verdict === "pass" || a.verdict === "concerns"
              ? "ok"
              : a.verdict === null
                ? "building"
                : "fail";
          return `<div class="list-row"><span class="num">#${a.attempt}</span><span class="ttl">${esc(a.verdict_line ?? a.verdict ?? "in progress")}</span><span class="meta">${cost ? `<span class="mut" style="font-size:12px">${esc(cost)}</span>` : ""}<span class="pill ${vCls}">${esc(a.verdict ?? "building")}</span></span></div>`;
        })
        .join("");

      const changeCard = item.head_ref
        ? `<div class="card idcard">
  <span class="k">Change</span><span class="v"><span class="mono">${esc(item.head_ref)} → ${esc(item.base_ref ?? "main")}</span> <span class="pill ${esc(item.change_state ?? "")}">${esc(item.change_state ?? "")}</span></span>
  ${
    changeOpen
      ? `<span class="k">Preview</span><span class="v"><a href="https://${esc(previewHost)}/" target="_blank" rel="noopener">https://${esc(previewHost)}/</a></span>
  <span class="k">Data</span><span class="v mut">copy-on-write clone of prod, isolated to this change</span>`
      : ""
  }
</div>`
        : "";

      const body = `
<div id="stepper-wrap">${item.phase === "closed" ? "" : stepper(item.phase, item.parked_reason)}</div>
<div class="row between">
  <h1 class="m0">#${item.number} <span style="font-weight:560">${esc(item.title)}</span></h1>
  <span class="pill ${phasePillCls(item.phase)}" id="phasepill">${esc(phaseText)}</span>
</div>
<p class="sub">by ${esc(item.author)} · <span id="labelpills">${labels.map((l) => `<span class="pill${l.startsWith("agent") ? " agent" : ""}">${esc(l)}</span>`).join(" ")}</span></p>
${item.body ? `<div class="card pad prewrap" style="font-size:13.5px">${esc(item.body)}</div>` : ""}
${changeCard}
${controls ? `<div class="row mb mt">${controls}</div>` : ""}
${attempts.length ? `<div class="mt label mb">Attempts</div><div class="rows">${attemptRows}</div>` : ""}
${item.head_ref ? `<div class="label mb mt">Diff <span class="mut">${nFiles ? `${nFiles} file${nFiles === 1 ? "" : "s"}` : ""}</span></div><pre class="logs">${patch ? colorDiff(patch) : "(no changes)"}</pre>` : ""}
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
        `#${item.number}`,
        chrome("apps", back),
        body,
        `
var R=${JSON.stringify(`${owner}/${app}`)};var N=${item.number};var seen={};var firstRender=true;
var TOOLS={Read:1,Write:1,Edit:1,Bash:1,Glob:1,Grep:1,Task:1,WebFetch:1,MultiEdit:1};
function mdLite(s){
  var e=escHtml(s);
  e=e.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  e=e.replace(/#(\\d+)/g,'<a href="/apps/'+R+'/work/$1">#$1</a>');
  return e;
}
function classify(c){
  var b=(c.body||'').trim();
  if(c.author!=='crew') return {kind:'human',body:b,author:c.author};
  if(/^(✅|⚠️|❌)/.test(b)){var k=b.indexOf('✅')===0?'pass':b.indexOf('⚠️')===0?'warn':'fail';return {kind:'verdict',v:k,body:b};}
  if(/^(🏗️|🔍|🚀|🌱|🔁|🔧|🛠️)/.test(b)) return {kind:'phase',body:b};
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
// Client mirror of the server stepper() — ONE phase-driven mapping, so the
// tracker advances live without a reload.
function renderStepper(phase,parkedReason){
  var got='done',building='pending',review='pending',live='pending';
  if(phase==='intent'||phase==='queued')got='active';
  else if(phase==='building'||phase==='reworking')building='active';
  else if(phase==='reviewing'){building='done';review='active';}
  else if(phase==='shipped'){building=review=live='done';}
  else if(phase==='parked'){
    var atBuild=parkedReason==='build-failed'||parkedReason==='daemon-restarted';
    building=atBuild?'failed':'done';
    if(!atBuild)review='failed';
  }
  function step(s,label){var dot=s==='active'?'building':(s==='failed'?'error':(s==='done'?'running':''));return '<li class="step '+s+'"><span class="dot '+dot+'"></span>'+label+'</li>';}
  return phase==='closed'?'':'<ol class="pipeline">'+step(got,'Got it')+step(building,'Building it')+step(review,'Making sure it works')+step(live,'Live')+'</ol>';
}
function phaseCls(p){return p==='queued'?'open':(p==='building'||p==='reworking')?'building':p==='reviewing'?'reviewing':p==='shipped'?'ok':p==='parked'?'fail':p==='closed'?'closed':'';}
async function refresh(){
  var r=await fetch('/api/v1/repos/'+R+'/work/'+N); if(!r.ok) return;
  var d=await r.json(); var el=document.getElementById('feed');
  var cs=d.comments||[];
  document.getElementById('cmts').textContent=cs.length?cs.length+' update'+(cs.length>1?'s':''):'';
  if(firstRender){el.innerHTML=cs.length?cs.map(render).join(''):'<div class="mut" style="font-size:13px">No activity yet — the crew posts here as it works.</div>';cs.forEach(function(c){seen[c.id]=1});firstRender=false;
    var f=el;f.scrollTop=f.scrollHeight;return;}
  var fresh=cs.filter(function(c){return !seen[c.id]});
  if(fresh.length){if(el.querySelector('.mut'))el.innerHTML='';fresh.forEach(function(c){seen[c.id]=1;el.insertAdjacentHTML('beforeend',render(c));});}
  // reflect phase/label changes LIVE, without a reload
  if(d.phase!==undefined && d.phase!==window._phase){
    window._phase=d.phase;
    var sw=document.getElementById('stepper-wrap');
    if(sw) sw.innerHTML=renderStepper(d.phase,d.parkedReason||null);
    var pp=document.getElementById('phasepill');
    if(pp){pp.className='pill '+phaseCls(d.phase);pp.textContent=d.phase==='parked'&&d.parkedReason?('parked · '+d.parkedReason):d.phase;}
  }
  if(d.labels!==undefined){
    var lbl=(d.labels||[]).join(',');
    if(lbl!==window._lbl){window._lbl=lbl;
      var lp=document.getElementById('labelpills');
      if(lp) lp.innerHTML=(d.labels||[]).map(function(l){return '<span class="pill'+(l.indexOf('agent')===0?' agent':'')+'">'+escHtml(l)+'</span>';}).join(' ');}
  }
}
async function act(a,b,msg){b.classList.add('is-loading');b.disabled=true;
  var r=await fetch('/api/v1/repos/'+R+'/work/'+N+'/'+a,{method:'POST'});
  var j=await r.json().catch(function(){return{}});
  if(r.ok){toast(msg);setTimeout(function(){a==='close'?location.href='/apps/'+R:location.reload()},700);}
  else {b.classList.remove('is-loading');b.disabled=false;toast(j.error||'failed');}
}
async function addComment(e){e.preventDefault();var i=document.getElementById('cbody');var b=i.value.trim();if(!b)return false;
  var r=await fetch('/api/v1/repos/'+R+'/work/'+N+'/comments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:b})});
  if(r.ok){i.value='';refresh();}else toast('failed');return false;}
refresh();setInterval(refresh,2000);`,
      );
    }

    // ── crew queue ───────────────────────────────────────────────────────
    if (path === "/crew") {
      const body = `
<h1>Crew</h1>
<p class="sub">What the build crew is working on across every app. Issues that need a human are listed first.</p>
<div id="queue"><div class="mut">loading…</div></div>`;
      return page(
        "Crew",
        chrome("crew", [{ label: "Crew" }]),
        body,
        `
function crewRow(it){
  var blocked=it.phase==='parked';
  var pc=blocked?'fail':(it.phase==='reviewing'?'reviewing':it.phase==='queued'?'':'building');
  var dot=blocked?'error':(it.phase==='queued'?'pending':'building');
  var label=blocked&&it.parkedReason?('parked · '+it.parkedReason):it.phase;
  return '<a class="list-row" href="/apps/'+it.owner+'/'+it.repo+'/work/'+it.number+'">'+
    '<span class="num"><span class="dot '+dot+'" style="margin-right:7px"></span>'+escHtml(it.owner+'/'+it.repo+' #'+it.number)+'</span>'+
    '<span class="ttl">'+escHtml(it.title)+'</span>'+
    '<span class="meta"><span class="pill '+pc+'">'+escHtml(label)+'</span></span></a>';
}
async function tick(){
  if(document.hidden) return;
  try{
    var r=await fetch('/api/v1/crew'); if(!r.ok) return;
    var d=await r.json(); var el=document.getElementById('queue');
    if(!d.items.length){el.innerHTML='<div class="empty">The crew is idle — nothing in flight.<br><span class="mut" style="font-size:13px">Open an app and describe a feature to put it to work.</span></div>';return;}
    var head='<p class="sub" style="margin:-8px 0 16px">'+(d.blocked?('<b style="color:var(--red)">'+d.blocked+' parked — need'+(d.blocked>1?'':'s')+' you</b> · '):'')+(d.working||'0')+' in progress</p>';
    el.innerHTML=head+'<div class="rows">'+d.items.map(crewRow).join('')+'</div>';
  }catch(_){}
}
tick();setInterval(tick,2000);`,
      );
    }

    // ── platform ────────────────────────────────────────────────────────
    if (path === "/platform") {
      // The Config repo (plat/platform) exists on every boot; the Source repo
      // (plat/opd) only after `op host-source`. Don't link to a repo that isn't
      // there — a germinated daughter that never hosted its source would get a
      // dead "Not found" card otherwise.
      const opdHosted = deps.store.getRepo(OPD.owner, OPD.name) !== null;
      const sourceCard = opdHosted
        ? `<a class="card app" href="/apps/plat/opd">
  <div class="name">Source</div>
  <div class="host">plat/opd</div>
  <p class="sub" style="margin:6px 0">The platform's own code. An issue here → the crew edits the daemon → self-upgrade applies it.</p>
  <div class="foot"><span class="mut" id="ic-opd"></span><span>File an issue →</span></div>
</a>`
        : `<div class="card app">
  <div class="name">Source</div>
  <div class="host">plat/opd</div>
  <p class="sub" style="margin:6px 0">The platform's own code — not hosted here yet. Run <code>op host-source</code> to publish it, then the crew can edit the daemon.</p>
  <div class="foot"><span class="mut">not hosted</span></div>
</div>`;
      const body = `
<h1>Platform</h1>
<p class="sub">Change the platform itself — file an issue and the crew builds it.</p>
<div class="grid">
${sourceCard}
<a class="card app" href="/apps/plat/platform">
  <div class="name">Config</div>
  <div class="host">plat/platform</div>
  <p class="sub" style="margin:6px 0">Crew prompts + settings. Merging hot-reloads it live, no restart.</p>
  <div class="foot"><span class="mut" id="ic-platform"></span><span>File an issue →</span></div>
</a>
</div>`;
      return page(
        "Platform",
        chrome("platform", [{ label: "Platform" }]),
        body,
        `
async function issueCount(repo,el){
  try{
    var r=await fetch('/api/v1/repos/'+repo+'/work?state=open');
    if(!r.ok) return;
    var d=await r.json();
    var n=document.getElementById(el);
    if(n) n.textContent='('+d.work.length+' open)';
  }catch(_){}
}
${opdHosted ? "issueCount('plat/opd','ic-opd');" : ""}
issueCount('plat/platform','ic-platform');`,
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
