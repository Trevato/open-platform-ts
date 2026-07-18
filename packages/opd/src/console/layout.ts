import { STYLE } from "./style.ts";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The console fetches nothing off-host — lock it down.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
}

export interface Crumb {
  label: string;
  href?: string;
}

export interface Chrome {
  domain: string;
  /** null = anonymous (public pages like /docs) — header shows Sign in. */
  user: string | null;
  active:
    | "apps"
    | "orgs"
    | "integrations"
    | "lineage"
    | "crew"
    | "platform"
    | "docs"
    | "";
  /** Breadcrumb trail below the header; last entry is the current page. */
  crumbs?: Crumb[];
  /** Render the Ask affordance + guide panel (signed in + credentialed). */
  guide?: boolean;
}

// Set the theme BEFORE first paint so there's no flash. CSP allows inline JS.
const FOUC_SETTER = `(function(){try{var t=localStorage.getItem('op-theme')||(matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}})();`;

// One helper bundle every page shares — never copy-pasted into a page script.
const GLOBAL_JS = `
function toast(m){var t=document.getElementById('toast');if(!t)return;t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show')},2400);}
function copy(t){navigator.clipboard.writeText(t).then(function(){toast('copied')});}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function relTime(ts){var s=Math.max(0,Math.round((Date.now()-ts)/1000));if(s<60)return s+'s ago';var m=Math.round(s/60);if(m<60)return m+'m ago';var h=Math.round(m/60);if(h<24)return h+'h ago';return Math.round(h/24)+'d ago';}
// URL-as-state (the nuqs pattern, dep-free): view state lives in the query
// string so it's shareable, refresh-safe, and back/forward works. Defaults are
// omitted from the URL (clean links); throttled writes keep typing responsive.
function urlState(defs){
  function read(){var sp=new URLSearchParams(location.search),o={};for(var k in defs){o[k]=sp.has(k)?defs[k].parse(sp.get(k)):defs[k].def;}return o;}
  var timer;
  function write(state,push){var sp=new URLSearchParams(location.search);for(var k in defs){var v=state[k],d=defs[k];
    if(v==null||v===d.def)sp.delete(k);else sp.set(k,d.serialize(v));}
    var qs=sp.toString();history[push?'pushState':'replaceState'](state,'',location.pathname+(qs?'?'+qs:'')+location.hash);}
  return {read:read,
    set:function(patch,opts){opts=opts||{};var s=Object.assign(read(),patch);
      if(opts.throttle){clearTimeout(timer);timer=setTimeout(function(){write(s,false)},250);}else write(s,!!opts.push);return s;},
    onpop:function(cb){window.addEventListener('popstate',function(){cb(read())});}};
}
function enP(vals,def){return {parse:function(v){return vals.indexOf(v)>=0?v:def;},serialize:function(v){return v;},def:def};}
function strP(def){return {parse:function(v){return v;},serialize:function(v){return v;},def:def||''};}
function setTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('op-theme',t)}catch(e){}
  var c=document.getElementById('tmc');if(c){[].forEach.call(c.children,function(b){b.classList.toggle('on',b.dataset.t===t)})}}
// crew status pill — one cheap poll, paused on hidden tabs
function crewTick(){var el=document.getElementById('crewpill');if(!el||document.hidden)return;
  fetch('/api/v1/crew').then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;
    // No credential AND work is waiting → that's the live truth, above any
    // stale per-item "not credentialed" comment. A crewless platform with no
    // queued work just reads "idle" (the crew is optional).
    var needsCred=d.credentialed===false&&d.working>0;
    el.className='crew'+(needsCred||d.blocked?' blocked':(d.working?' working':''));
    var dot=needsCred||d.blocked?'error':(d.working?'building':'');
    var txt=needsCred?('crew needs a token — '+d.working+' waiting'):(d.blocked?(d.blocked+' parked — need'+(d.blocked>1?'':'s')+' you'):(d.working?(d.working+' agent'+(d.working>1?'s':'')+' working'):'crew idle'));
    el.innerHTML='<span class="dot '+dot+'"></span>'+txt;
  }).catch(function(){});}
document.addEventListener('DOMContentLoaded',function(){var c=document.getElementById('tmc');if(c)setTheme(document.documentElement.dataset.theme||'dark');crewTick();setInterval(crewTick,3000);});
`;

export function page(
  title: string,
  chrome: Chrome,
  main: string,
  extraScript = "",
  opts: { wide?: boolean } = {},
): Response {
  const w = opts.wide ? "wrap-wide" : "wrap";
  const nav = (href: string, label: string, key: string) =>
    `<a href="${href}" class="${chrome.active === key ? "on" : ""}">${label}</a>`;
  const themeBtn = (t: string, glyph: string, label: string) =>
    `<button data-t="${t}" onclick="setTheme('${t}')" aria-label="${label} theme" data-tip="${label}">${glyph}</button>`;
  const crumbs = (chrome.crumbs ?? []).length
    ? `<nav class="crumbs" aria-label="Breadcrumb">${chrome
        .crumbs!.map((c, i, a) =>
          i === a.length - 1
            ? `<b class="cur">${esc(c.label)}</b>`
            : `${c.href ? `<a href="${c.href}">${esc(c.label)}</a>` : esc(c.label)}<span class="sep">›</span>`,
        )
        .join("")}</nav>`
    : "";
  // Anonymous readers (public pages like /docs) get the same chrome minus the
  // session affordances — and no crew pill polling an endpoint that would 401.
  const session = chrome.user
    ? `${chrome.guide ? `<button class="btn secondary sm" id="gopen" type="button">✦ Ask</button>` : ""}
    <a class="crew" id="crewpill" href="/crew"><span class="dot"></span>crew idle</a>
    <span class="tmc" id="tmc" role="group" aria-label="Theme">${themeBtn("light", "☀", "Light")}${themeBtn("dim", "◑", "Dim")}${themeBtn("dark", "☾", "Dark")}</span>
    <span class="who">${esc(chrome.user)}</span>
    <form method="post" action="/logout" style="margin:0"><button class="ghost sm" data-tip="Sign out">⏻</button></form>`
    : `<span class="tmc" id="tmc" role="group" aria-label="Theme">${themeBtn("light", "☀", "Light")}${themeBtn("dim", "◑", "Dim")}${themeBtn("dark", "☾", "Dark")}</span>
    <a class="btn secondary sm" href="/login">Sign in</a>`;
  return html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(title)} · ${esc(chrome.domain)}</title>
<script>${FOUC_SETTER}</script>
<style>${STYLE}</style></head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="${w}">
  <div class="bar">
    <a class="brand" href="/"><span class="seed"></span>Open Platform <span class="dom">${esc(chrome.domain)}</span></a>
    <span class="spacer"></span>
    <nav>${nav("/", "Apps", "apps")}${nav("/orgs", "Orgs", "orgs")}${nav("/integrations", "Integrations", "integrations")}${nav("/platform", "Platform", "platform")}${nav("/crew", "Crew", "crew")}${nav("/lineage", "Lineage", "lineage")}${nav("/docs", "Docs", "docs")}</nav>
    ${session}
  </div>
  ${crumbs}
</div></header>
<main id="main"><div class="${w}">${main}</div></main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
${chrome.user && chrome.guide ? GUIDE_PANEL : ""}
<script>${GLOBAL_JS}
${chrome.user && chrome.guide ? GUIDE_JS : ""}
${extraScript}
</script>
</body></html>`);
}

// ── the guide panel — every signed-in page carries it ──────────────────────
// A slide-over (right sheet on desktop, bottom sheet on phones) chatting with
// POST /api/v1/guide over SSE. The conversation lives in sessionStorage only;
// closing the tab ends it. Rendering is a deliberately tiny md subset —
// escape-first, then code/links/bold — never raw HTML.
const GUIDE_PANEL = `
<aside class="gp" id="gp" aria-label="Platform guide" aria-hidden="true">
  <div class="gp-head">
    <span class="gp-title"><span class="seed"></span>Guide</span>
    <span class="spacer"></span>
    <button class="btn ghost sm" id="gclear" type="button" data-tip="New conversation">↺</button>
    <button class="btn ghost sm" id="gclose" type="button" aria-label="Close">✕</button>
  </div>
  <div class="gp-log" id="glog"></div>
  <form class="gp-form" id="gform">
    <textarea id="gq" rows="2" placeholder="Ask about your platform…" required></textarea>
    <button type="submit" id="gsend" aria-label="Send">↑</button>
  </form>
</aside>`;

const GUIDE_JS = `
(function(){
  var gp=document.getElementById('gp'),log=document.getElementById('glog'),form=document.getElementById('gform'),
      q=document.getElementById('gq'),send=document.getElementById('gsend');
  if(!gp)return;
  var hist=[];try{hist=JSON.parse(sessionStorage.getItem('op-guide')||'[]')}catch(e){}
  var busy=false;
  function save(){try{sessionStorage.setItem('op-guide',JSON.stringify(hist.slice(-20)))}catch(e){}}
  function gmd(s){
    var blocks=[];
    s=s.replace(/\`\`\`\\w*\\n?([\\s\\S]*?)(\`\`\`|$)/g,function(_,c){blocks.push(c);return '\\u0000'+(blocks.length-1)+'\\u0000'});
    var e=escHtml(s);
    e=e.replace(/\`([^\`\\n]+)\`/g,'<code>$1</code>');
    e=e.replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>');
    e=e.replace(/(^|[\\s(>])(\\/(docs|apps)\\/[A-Za-z0-9\\/._#-]*[A-Za-z0-9\\/#-])/g,'$1<a href="$2">$2</a>');
    e=e.replace(/\\n/g,'<br>');
    return e.replace(/\\u0000(\\d+)\\u0000/g,function(_,i){return '<pre class="logs gp-code">'+escHtml(blocks[+i])+'</pre>'});
  }
  function bubble(role,html){var d=document.createElement('div');d.className='gm '+role;d.innerHTML=html;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
  function paint(){log.innerHTML='';hist.forEach(function(m){bubble(m.role==='user'?'user':'bot',m.role==='user'?escHtml(m.content):gmd(m.content));});
    if(!hist.length)log.innerHTML='<div class="gp-hello">I\\u2019ve read this platform\\u2019s manual and can see your apps, work, logs, and the platform\\u2019s own source. Ask me anything \\u2014 from \\u201cwhy is my app red?\\u201d to \\u201chow do previews get their data?\\u201d</div>';}
  function open(){gp.classList.add('open');gp.setAttribute('aria-hidden','false');paint();setTimeout(function(){q.focus()},180);}
  function close(){gp.classList.remove('open');gp.setAttribute('aria-hidden','true');}
  var ob=document.getElementById('gopen');if(ob)ob.addEventListener('click',function(){gp.classList.contains('open')?close():open();});
  document.getElementById('gclose').addEventListener('click',close);
  document.getElementById('gclear').addEventListener('click',function(){hist=[];save();paint();q.focus();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&gp.classList.contains('open')&&document.getElementById('dsv')===null)close();});
  q.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();form.requestSubmit();}});
  form.addEventListener('submit',function(e){
    e.preventDefault();
    if(busy)return;
    var text=q.value.trim();if(!text)return;
    q.value='';busy=true;send.disabled=true;
    if(!hist.length)log.innerHTML='';
    hist.push({role:'user',content:text});save();
    bubble('user',escHtml(text));
    var think=bubble('tools','<div class="gp-tool"><span class="dot building"></span>thinking…</div>');
    var out=null,raw='';
    fetch('/api/v1/guide',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({messages:hist.slice(-12),page:location.pathname})})
    .then(function(r){
      if(!r.ok||!r.body)throw new Error(r.status===503?'The guide needs a Claude credential \\u2014 see /docs/crew.':'guide failed ('+r.status+')');
      var reader=r.body.getReader(),dec=new TextDecoder(),buf='';
      function pump(){return reader.read().then(function(ch){
        if(ch.done)return;
        buf+=dec.decode(ch.value,{stream:true});
        var parts=buf.split('\\n\\n');buf=parts.pop();
        parts.forEach(function(line){
          if(line.indexOf('data: ')!==0)return;
          var msg;try{msg=JSON.parse(line.slice(6))}catch(e){return}
          if(msg.type==='text'){if(!out){out=bubble('bot','');}raw+=msg.text;out.innerHTML=gmd(raw);log.scrollTop=log.scrollHeight;}
          else if(msg.type==='tool'){think.insertAdjacentHTML('beforeend','<div class="gp-tool"><span class="dot building"></span><code>'+escHtml(msg.name)+'</code></div>');log.scrollTop=log.scrollHeight;}
          else if(msg.type==='sources'&&msg.sources.length){
            var chips=msg.sources.map(function(s){
              var href=s.kind==='doc'?'/docs/'+s.ref:'/apps/plat/opd/blob/main/'+s.ref;
              return '<a class="pill" href="'+escHtml(href)+'">'+escHtml(s.title)+'</a>';}).join('');
            bubble('src','<span>sources</span>'+chips);}
          else if(msg.type==='error'){throw new Error(msg.error||'guide failed');}
        });
        return pump();
      })}
      return pump();
    })
    .then(function(){ think.remove(); if(raw){hist.push({role:'assistant',content:raw});save();} })
    .catch(function(err){ think.remove(); bubble('bot','<span class="err">'+escHtml(String(err.message||err))+'</span>'); })
    .finally(function(){busy=false;send.disabled=false;[].forEach.call(gp.querySelectorAll('.gp-tool .dot'),function(d){d.className='dot running'});});
  });
})();
`;
