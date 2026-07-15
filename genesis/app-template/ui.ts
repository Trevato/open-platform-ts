// Open Platform app UI kit: one file, zero dependencies, server-rendered.
// The platform console's design language — shadcn-vocabulary OKLCH tokens, a
// one-knob radius scale, the two-part focus ring, 36px controls, 24px-padded
// bordered cards — distilled to what an app page needs. Everything inlines:
// no fonts, no CDN, no client framework; pages render identically offline and
// under a CSP that allows only inline style/script.
//
// Every helper returns an HTML string; compose pages by concatenation.
// Fields documented as text are escaped for you; `body`, `actions`, `footer`
// and table cells are raw HTML so primitives nest (a pill inside a table
// cell, a button inside a page header). Run USER text through esc() yourself
// whenever you interpolate it into raw-HTML slots.

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap a rendered document in a Response that actually serves that CSP:
 *  nothing off-host, inline style/script only — the kit needs exactly that. */
export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
}

// Light tokens live in one constant: used for [data-theme="light"] AND the
// no-JS prefers-color-scheme fallback, so the two can never drift.
const LIGHT_TOKENS = `
  color-scheme: light;
  --background: oklch(0.976 0.003 200); --foreground: oklch(0.2 0.012 220);
  --card: oklch(1 0 0); --popover: oklch(1 0 0);
  --primary: oklch(0.62 0.15 150); --primary-foreground: oklch(0.16 0.03 155);
  --muted: oklch(0.96 0.004 200); --muted-foreground: oklch(0.49 0.012 210);
  --accent: oklch(0.945 0.005 200);
  --destructive: oklch(0.577 0.245 27);
  --border: oklch(0.915 0.005 200); --input: oklch(0.875 0.006 200);
  --ring: oklch(0.62 0.14 150);
  --faint: oklch(0.665 0.012 210);
  --amber: oklch(0.6 0.12 80); --blue: oklch(0.55 0.18 262);`;

export const CSS = `
:root {
  --radius: 0.625rem;
  --radius-sm: calc(var(--radius) - 4px); --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius); --radius-xl: calc(var(--radius) + 4px); --r-full: 999px;
  --sp1: 4px; --sp2: 8px; --sp3: 12px; --sp4: 16px; --sp6: 24px; --sp8: 32px;
  --fs-xs: 11px; --fs-sm: 13px; --fs-base: 14px; --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 24px;
  --bw: 1px; --control-h: 36px; --control-h-sm: 32px; --card-pad: var(--sp6);
  --dur-fast: 120ms; --dur: 180ms; --ease: ease; --ease-out: cubic-bezier(.16, 1, .3, 1);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --shadow-xs: 0 1px 2px 0 oklch(0 0 0 / 0.05);
  --shadow-sm: 0 1px 3px 0 oklch(0 0 0 / 0.1), 0 1px 2px -1px oklch(0 0 0 / 0.1);
  /* the signature two-part focus ring, part two (part one flips the border) */
  --ring-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
/* Elevation ladder: background → card → muted → popover, lightness steps with
   zero chroma drift. Borders are alpha-white in the dark theme. */
:root, [data-theme="dark"] {
  color-scheme: dark;
  --background: oklch(0.155 0.004 220); --foreground: oklch(0.93 0.008 200);
  --card: oklch(0.21 0.006 215); --popover: oklch(0.26 0.007 215);
  --primary: oklch(0.7 0.17 149); --primary-foreground: oklch(0.16 0.03 155);
  --muted: oklch(0.235 0.007 215); --muted-foreground: oklch(0.665 0.012 210);
  --accent: oklch(0.26 0.007 215);
  --destructive: oklch(0.66 0.2 25);
  --border: oklch(1 0 0 / 8%); --input: oklch(1 0 0 / 14%);
  --ring: oklch(0.7 0.16 149);
  --faint: oklch(0.49 0.012 210);
  --amber: oklch(0.72 0.14 80); --blue: oklch(0.66 0.16 262);
}
[data-theme="light"] {${LIGHT_TOKENS}
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {${LIGHT_TOKENS}
  }
}

* { box-sizing: border-box; }
::selection { background: color-mix(in oklab, var(--primary) 26%, transparent); }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--background); color: var(--foreground);
  font-family: var(--sans); font-size: var(--fs-base); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: 0.86em; }
code { background: var(--muted); padding: 1px 5px; border-radius: var(--radius-sm); }
::placeholder { color: var(--muted-foreground); opacity: 1; }
/* the shadcn focus treatment: no outline; ring shadow everywhere, and
   bordered controls also flip their border to the ring color */
:focus-visible { outline: none; box-shadow: var(--ring-shadow); }
a:focus-visible { border-radius: var(--radius-sm); }
button:focus-visible, .btn:focus-visible { border-color: var(--ring); }
.skip { position: absolute; left: -999px; top: 8px; background: var(--popover); color: var(--foreground);
  padding: 8px 14px; border-radius: var(--radius-md); border: var(--bw) solid var(--input); z-index: 80; }
.skip:focus { left: 12px; }

.wrap { max-width: 880px; margin: 0 auto; padding: 0 var(--sp6); }

/* ── header ──────────────────────────────────────────────────────────────── */
header.top { border-bottom: var(--bw) solid var(--border); background: var(--card);
  position: sticky; top: 0; z-index: 10; }
header.top .bar { display: flex; align-items: center; gap: var(--sp4); height: 54px; }
.brand { font-weight: 600; letter-spacing: -0.01em; display: flex; align-items: center; gap: 9px; color: var(--foreground); }
.brand:hover { text-decoration: none; }
.brand .seed { width: 9px; height: 9px; border-radius: 50%; background: var(--primary); flex: none;
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--primary) 20%, transparent); }
.top .spacer { flex: 1; }
.top nav { display: flex; gap: var(--sp4); }
.top nav a { color: var(--muted-foreground); font-size: var(--fs-sm); padding: 5px 2px; }
.top nav a:hover, .top nav a.on { color: var(--foreground); text-decoration: none; }
.top nav a.on { box-shadow: inset 0 -2px 0 var(--primary); }
.who { color: var(--faint); font-size: var(--fs-xs); font-family: var(--mono); }
.tmc { display: inline-flex; border: var(--bw) solid var(--border); border-radius: var(--r-full);
  padding: 2px; background: var(--muted); }
.tmc button { background: none; border: 0; padding: 3px 7px; height: auto; border-radius: var(--r-full); cursor: pointer;
  color: var(--faint); font-size: 12px; line-height: 1; }
.tmc button:hover { background: transparent; color: var(--foreground); }
.tmc button.on { background: var(--popover); color: var(--foreground); box-shadow: inset 0 0 0 1px var(--border); }

/* ── type / utilities ────────────────────────────────────────────────────── */
main { padding: 28px 0 88px; }
h1 { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
h2 { font-size: var(--fs-lg); font-weight: 600; margin: 0 0 10px; letter-spacing: -0.01em; }
.sub { color: var(--muted-foreground); margin: 0 0 24px; font-size: var(--fs-sm); }
.label { text-transform: uppercase; letter-spacing: 0.08em; font-size: var(--fs-xs); color: var(--faint); font-weight: 600; }
.mut { color: var(--muted-foreground); } .faint { color: var(--faint); }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.stack { display: flex; flex-direction: column; gap: var(--sp3); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.mt { margin-top: 22px; } .m0 { margin: 0; }

/* ── page header (title + subline + actions) ─────────────────────────────── */
.page-head { display: flex; align-items: flex-start; justify-content: space-between;
  gap: var(--sp4); flex-wrap: wrap; margin: 0 0 24px; }
.page-head .sub { margin: 4px 0 0; }
.page-head .actions { display: flex; gap: var(--sp2); align-items: center; }

/* ── cards (shadcn anatomy: 1px border, radius-xl, card-pad, shadow-xs) ──── */
.card { background: var(--card); color: var(--foreground);
  border: var(--bw) solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-xs); }
.card.warn { border-color: color-mix(in oklab, var(--amber) 45%, var(--border)); }
.card.danger { border-color: color-mix(in oklab, var(--destructive) 45%, var(--border)); }
.card-header { padding: var(--card-pad) var(--card-pad) 0; }
.card-title { font-weight: 600; line-height: 1.2; margin: 0; }
.card-desc { color: var(--muted-foreground); font-size: var(--fs-sm); margin: 2px 0 0; }
.card-content { padding: var(--card-pad); }
.card-content > :first-child { margin-top: 0; } .card-content > :last-child { margin-bottom: 0; }
.card-footer { padding: 0 var(--card-pad) var(--card-pad); display: flex; align-items: center; gap: var(--sp2); }

/* ── stat tile ───────────────────────────────────────────────────────────── */
.stat { padding: var(--sp4) 18px 18px; }
.stat-label { text-transform: uppercase; letter-spacing: 0.08em; font-size: var(--fs-xs); color: var(--faint); font-weight: 600; }
.stat-value { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin: 2px 0 0; }
.stat-hint { color: var(--muted-foreground); font-size: var(--fs-sm); margin: 2px 0 0; }

/* ── buttons (h-9, px-4, text-sm medium; hover = 90% primary) ────────────── */
button, .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--sp2);
  background: var(--primary); color: var(--primary-foreground); border: var(--bw) solid transparent;
  border-radius: var(--radius-md); padding: 0 var(--sp4); height: var(--control-h);
  font-size: var(--fs-sm); font-weight: 500; line-height: 1;
  cursor: pointer; font-family: var(--sans); white-space: nowrap;
  transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease); }
button:hover, .btn:hover { background: color-mix(in oklab, var(--primary) 90%, transparent); text-decoration: none; }
button:disabled, .btn:disabled { opacity: .5; pointer-events: none; }
button.ghost, .btn.ghost { background: transparent; color: var(--muted-foreground); border-color: transparent; }
button.ghost:hover, .btn.ghost:hover { color: var(--foreground); background: var(--accent); }
button.danger, .btn.danger { background: transparent; color: var(--destructive);
  border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); }
button.danger:hover, .btn.danger:hover { background: color-mix(in oklab, var(--destructive) 10%, transparent); }
button.danger:focus-visible, .btn.danger:focus-visible { border-color: var(--destructive);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 25%, transparent); }
button.sm, .btn.sm { height: var(--control-h-sm); padding: 0 var(--sp3); font-size: var(--fs-xs); gap: 6px; }

/* ── forms (h-9 inputs, border --input, focus flips to ring) ─────────────── */
input[type=text], input[type=password], input[type=url], input[type=email], input[type=number],
input:not([type]), textarea, select {
  background: color-mix(in oklab, var(--input) 25%, transparent);
  border: var(--bw) solid var(--input); color: var(--foreground);
  border-radius: var(--radius-md); height: var(--control-h); padding: 0 var(--sp3);
  font-size: var(--fs-base); font-family: var(--sans); outline: none; width: 100%; min-width: 0;
  box-shadow: var(--shadow-xs);
  transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease); }
textarea { height: auto; resize: vertical; min-height: 76px; line-height: 1.5; padding: var(--sp2) var(--sp3); }
select { width: auto; cursor: pointer; font-size: var(--fs-sm); padding: 0 10px; }
input:focus-visible, textarea:focus-visible, select:focus-visible {
  border-color: var(--ring); box-shadow: var(--ring-shadow); }
/* validation is attribute-driven (aria-invalid), destructive-tinted ring */
[aria-invalid="true"], [aria-invalid="true"]:focus-visible {
  border-color: var(--destructive);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 22%, transparent); }
/* field anatomy: label / control / description / error */
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: var(--fs-sm); font-weight: 500; color: var(--foreground); }
.field-desc { font-size: var(--fs-sm); color: var(--muted-foreground); margin: 0; }
.field-error { font-size: var(--fs-sm); color: var(--destructive); margin: 0; }

/* ── table (wide content scrolls inside its wrap, never the page) ────────── */
.table-wrap { overflow-x: auto; }
table.table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.table th { text-align: left; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--faint); font-weight: 600; padding: 8px var(--sp3); border-bottom: var(--bw) solid var(--border); }
.table td { padding: 9px var(--sp3); border-bottom: var(--bw) solid color-mix(in oklab, var(--border) 60%, transparent); }
.table tbody tr:last-child td { border-bottom: 0; }
.table tbody tr:hover { background: var(--accent); }

/* ── pills (ok / warn / danger / neutral) ────────────────────────────────── */
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; padding: 2px 8px;
  border-radius: var(--r-full); background: var(--muted); border: var(--bw) solid var(--border);
  color: var(--muted-foreground); font-family: var(--mono); line-height: 1.5; white-space: nowrap; }
.pill.ok { color: var(--primary); border-color: color-mix(in oklab, var(--primary) 40%, var(--border)); }
.pill.warn { color: var(--amber); border-color: color-mix(in oklab, var(--amber) 40%, var(--border)); }
.pill.danger { color: var(--destructive); border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); }

/* ── empty state (centered, dashed border, muted description) ────────────── */
.empty { color: var(--muted-foreground); text-align: center; padding: 44px var(--sp6);
  border: 1px dashed var(--border); border-radius: var(--radius-xl); font-size: var(--fs-base); }
.empty-icon { display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; margin: 0 auto var(--sp3); border-radius: var(--radius-md);
  background: var(--muted); color: var(--muted-foreground); }
.empty-title { color: var(--foreground); font-weight: 500; margin: 0 0 4px; }
.empty-desc { color: var(--muted-foreground); font-size: var(--fs-sm); margin: 0 auto; max-width: 46ch; }
.empty-actions { display: flex; justify-content: center; gap: var(--sp2); margin-top: var(--sp4); }

/* ── responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 600px) {
  .wrap { padding: 0 16px; }
  header.top .bar { gap: 10px; }
  .top nav, .who { display: none; }
  h1 { font-size: var(--fs-lg); }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

// Set the theme BEFORE first paint so there's no flash; the toggle persists
// the choice in localStorage (same approach as the platform console).
const FOUC_SETTER = `(function(){try{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}})();`;
const THEME_JS = `function setTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('theme',t)}catch(e){}
var c=document.getElementById('tmc');if(c){[].forEach.call(c.children,function(b){b.classList.toggle('on',b.dataset.t===t)})}}
setTheme(document.documentElement.dataset.theme||'dark');`;

export interface LayoutOpts {
  title: string; // text — becomes <title> and the header brand
  user?: string | null; // text — shown mono in the header when present
  nav?: Array<{ href: string; label: string; current?: boolean }>;
  body: string; // raw HTML
}

/** A full HTML document: sticky header (brand, nav, theme toggle, user),
 *  main column, inline style + flash-free theme script. */
export function layout(opts: LayoutOpts): string {
  const nav = opts.nav?.length
    ? `<nav>${opts.nav
        .map(
          (n) =>
            `<a href="${esc(n.href)}"${n.current ? ' class="on"' : ""}>${esc(n.label)}</a>`,
        )
        .join("")}</nav>`
    : "";
  const themeBtn = (t: string, glyph: string, label: string) =>
    `<button data-t="${t}" onclick="setTheme('${t}')" aria-label="${label} theme">${glyph}</button>`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(opts.title)}</title>
<script>${FOUC_SETTER}</script>
<style>${CSS}</style></head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap">
  <div class="bar">
    <a class="brand" href="/"><span class="seed"></span>${esc(opts.title)}</a>
    <span class="spacer"></span>
    ${nav}
    <span class="tmc" id="tmc" role="group" aria-label="Theme">${themeBtn("light", "☀", "Light")}${themeBtn("dark", "☾", "Dark")}</span>
    ${opts.user ? `<span class="who">${esc(opts.user)}</span>` : ""}
  </div>
</div></header>
<main id="main"><div class="wrap">${opts.body}</div></main>
<script>${THEME_JS}</script>
</body></html>`;
}

/** h1 + optional muted subline on the left, actions (raw HTML) on the right. */
export function pageHeader(opts: {
  title: string; // text
  sub?: string; // text
  actions?: string; // raw HTML
}): string {
  return `<div class="page-head">
<div><h1>${esc(opts.title)}</h1>${opts.sub ? `<p class="sub">${esc(opts.sub)}</p>` : ""}</div>
${opts.actions ? `<div class="actions">${opts.actions}</div>` : ""}</div>`;
}

/** Bordered card. `body`/`footer` are raw HTML; `title`/`desc` are text. */
export function card(
  body: string,
  opts: {
    title?: string;
    desc?: string;
    footer?: string;
    tone?: "warn" | "danger";
  } = {},
): string {
  const header = opts.title
    ? `<div class="card-header"><h3 class="card-title">${esc(opts.title)}</h3>${opts.desc ? `<p class="card-desc">${esc(opts.desc)}</p>` : ""}</div>`
    : "";
  return `<div class="card${opts.tone ? ` ${opts.tone}` : ""}">${header}<div class="card-content">${body}</div>${opts.footer ? `<div class="card-footer">${opts.footer}</div>` : ""}</div>`;
}

/** Button or link-styled-as-button. Label is text. */
export function button(
  label: string,
  opts: {
    href?: string; // renders <a class="btn"> instead of <button>
    variant?: "primary" | "ghost" | "danger";
    small?: boolean;
    type?: "submit" | "button";
  } = {},
): string {
  const cls = [
    "btn",
    opts.variant && opts.variant !== "primary" ? opts.variant : "",
    opts.small ? "sm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return opts.href
    ? `<a class="${cls}" href="${esc(opts.href)}">${esc(label)}</a>`
    : `<button class="${cls}" type="${opts.type ?? "submit"}">${esc(label)}</button>`;
}

/** Label + input + optional description/error. All fields are text. */
export function field(opts: {
  label: string;
  name: string;
  type?: string; // input type, default "text"
  value?: string;
  placeholder?: string;
  desc?: string;
  error?: string;
}): string {
  const id = esc(`f-${opts.name}`);
  const attrs =
    `id="${id}" name="${esc(opts.name)}" type="${esc(opts.type ?? "text")}"` +
    (opts.value !== undefined ? ` value="${esc(opts.value)}"` : "") +
    (opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : "") +
    (opts.error ? ` aria-invalid="true"` : "");
  return `<div class="field">
<label class="field-label" for="${id}">${esc(opts.label)}</label>
<input ${attrs}>
${opts.desc ? `<p class="field-desc">${esc(opts.desc)}</p>` : ""}${opts.error ? `<p class="field-error">${esc(opts.error)}</p>` : ""}</div>`;
}

/** Table in a horizontal-scroll wrap. Head labels are text; cells raw HTML. */
export function table(head: string[], rows: string[][]): string {
  return `<div class="table-wrap"><table class="table">
<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
</table></div>`;
}

/** Status pill. Text label; tone picks the accent. */
export function pill(
  label: string,
  tone: "ok" | "warn" | "danger" | "neutral" = "neutral",
): string {
  return `<span class="pill${tone === "neutral" ? "" : ` ${tone}`}">${esc(label)}</span>`;
}

/** Centered dashed-border empty state. `actions` is raw HTML. */
export function empty(opts: {
  icon?: string; // text glyph, e.g. "○"
  title: string;
  desc?: string;
  actions?: string;
}): string {
  return `<div class="empty">
${opts.icon ? `<div class="empty-icon">${esc(opts.icon)}</div>` : ""}<p class="empty-title">${esc(opts.title)}</p>
${opts.desc ? `<p class="empty-desc">${esc(opts.desc)}</p>` : ""}${opts.actions ? `<div class="empty-actions">${opts.actions}</div>` : ""}</div>`;
}

/** Big-number stat tile (a card). Value/label/hint are text. */
export function stat(opts: {
  label: string;
  value: string | number;
  hint?: string;
}): string {
  return `<div class="card stat">
<div class="stat-label">${esc(opts.label)}</div>
<div class="stat-value">${esc(opts.value)}</div>
${opts.hint ? `<div class="stat-hint">${esc(opts.hint)}</div>` : ""}</div>`;
}
