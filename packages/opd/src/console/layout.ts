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
  user: string;
  active: "apps" | "lineage" | "";
  /** Breadcrumb trail below the header; last entry is the current page. */
  crumbs?: Crumb[];
}

// Set the theme BEFORE first paint so there's no flash. CSP allows inline JS.
const FOUC_SETTER = `(function(){try{var t=localStorage.getItem('op-theme')||(matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}})();`;

// One helper bundle every page shares — never copy-pasted into a page script.
const GLOBAL_JS = `
function toast(m){var t=document.getElementById('toast');if(!t)return;t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show')},2400);}
function copy(t){navigator.clipboard.writeText(t).then(function(){toast('copied')});}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function relTime(ts){var s=Math.max(0,Math.round((Date.now()-ts)/1000));if(s<60)return s+'s ago';var m=Math.round(s/60);if(m<60)return m+'m ago';var h=Math.round(m/60);if(h<24)return h+'h ago';return Math.round(h/24)+'d ago';}
function setTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('op-theme',t)}catch(e){}
  var c=document.getElementById('tmc');if(c){[].forEach.call(c.children,function(b){b.classList.toggle('on',b.dataset.t===t)})}}
// crew status pill — one cheap poll, paused on hidden tabs
function crewTick(){var el=document.getElementById('crewpill');if(!el||document.hidden)return;
  fetch('/api/v1/crew').then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;
    el.className='crew'+(d.blocked?' blocked':(d.working?' working':''));
    var dot=d.blocked?'error':(d.working?'building':'');
    var txt=d.blocked?(d.blocked+' need'+(d.blocked>1?'':'s')+' review'):(d.working?(d.working+' agent'+(d.working>1?'s':'')+' working'):'crew idle');
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
    <nav>${nav("/", "Apps", "apps")}${nav("/lineage", "Lineage", "lineage")}</nav>
    <a class="crew" id="crewpill" href="/"><span class="dot"></span>crew idle</a>
    <span class="tmc" id="tmc" role="group" aria-label="Theme">${themeBtn("light", "☀", "Light")}${themeBtn("dim", "◑", "Dim")}${themeBtn("dark", "☾", "Dark")}</span>
    <span class="who">${esc(chrome.user)}</span>
    <form method="post" action="/logout" style="margin:0"><button class="ghost sm" data-tip="Sign out">⏻</button></form>
  </div>
  ${crumbs}
</div></header>
<main id="main"><div class="${w}">${main}</div></main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>${GLOBAL_JS}
${extraScript}
</script>
</body></html>`);
}
