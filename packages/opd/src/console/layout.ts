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

export interface Chrome {
  domain: string;
  user: string;
  active: "apps" | "lineage" | "";
}

export function page(
  title: string,
  chrome: Chrome,
  main: string,
  extraScript = "",
): Response {
  const nav = (href: string, label: string, key: string) =>
    `<a href="${href}" class="${chrome.active === key ? "on" : ""}">${label}</a>`;
  return html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(chrome.domain)}</title>
<style>${STYLE}</style></head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="/"><span class="seed"></span>Open Platform <span class="dom">${esc(chrome.domain)}</span></a>
  <span class="spacer"></span>
  <nav>${nav("/", "Apps", "apps")}${nav("/lineage", "Lineage", "lineage")}</nav>
  <span class="who">${esc(chrome.user)}</span>
  <form method="post" action="/logout" style="margin:0"><button class="ghost" style="padding:5px 10px">Sign out</button></form>
</div></header>
<main><div class="wrap">${main}</div></main>
<div class="toast" id="toast"></div>
<script>
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2200);}
function copy(t){navigator.clipboard.writeText(t).then(function(){toast('copied')});}
${extraScript}
</script>
</body></html>`);
}
