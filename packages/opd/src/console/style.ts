// One stylesheet, inlined — no external fonts, no CDN, nothing to fetch. The
// page renders identically offline and inside a locked-down CSP. The token
// vocabulary is shadcn's (mid-2026): OKLCH background/foreground pairs, one
// --radius knob driving a calc-derived scale, a two-part focus ring
// (border→ring color + 3px half-alpha shadow), 36px controls, 24px-padded
// bordered cards. Themes are a single attribute swap ([data-theme]) that
// re-declares the same tokens; the one green --primary is the only chroma, so
// it always reads as signal. Elevation is surface-lightness steps + a 1px
// border; shadows stay at the xs/sm level. Density is Nova-tight.
//
// Legacy variable names (--bg/--panel/--ink/--line/--red/--faint…) remain as
// aliases of the shadcn tokens so older inline styles keep resolving.

// Light tokens live in one constant: used for [data-theme="light"] AND the
// no-JS prefers-color-scheme fallback, so the two can never drift.
const LIGHT_TOKENS = `
  color-scheme: light;
  --background: oklch(0.976 0.003 200); --foreground: oklch(0.2 0.012 220);
  --card: oklch(1 0 0); --card-foreground: oklch(0.2 0.012 220);
  --popover: oklch(1 0 0); --popover-foreground: oklch(0.2 0.012 220);
  --primary: oklch(0.62 0.15 150); --primary-foreground: oklch(0.16 0.03 155);
  --secondary: oklch(0.96 0.004 200); --secondary-foreground: oklch(0.2 0.012 220);
  --muted: oklch(0.96 0.004 200); --muted-foreground: oklch(0.49 0.012 210);
  --accent: oklch(0.945 0.005 200); --accent-foreground: oklch(0.2 0.012 220);
  --destructive: oklch(0.577 0.245 27);
  --border: oklch(0.915 0.005 200); --input: oklch(0.875 0.006 200);
  --ring: oklch(0.62 0.14 150);
  --faint: oklch(0.665 0.012 210);
  --amber: oklch(0.6 0.12 80); --blue: oklch(0.55 0.18 262);
  --chart-1: oklch(0.62 0.15 150); --chart-2: oklch(0.55 0.18 262); --chart-3: oklch(0.6 0.12 80); --chart-4: oklch(0.577 0.245 27); --chart-5: oklch(0.58 0.14 305);`;

export const STYLE = `
:root {
  /* radius — one knob, calc-derived scale (shadcn) */
  --radius: 0.625rem;
  --radius-sm: calc(var(--radius) - 4px); --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius); --radius-xl: calc(var(--radius) + 4px);
  /* legacy radius aliases */
  --r: var(--radius); --r-sm: var(--radius-sm); --r-md: var(--radius-md);
  --r-lg: var(--radius-lg); --r-xl: var(--radius-xl); --r-full: 999px;
  /* spacing / type scale */
  --sp1: 4px; --sp2: 8px; --sp3: 12px; --sp4: 16px; --sp5: 20px; --sp6: 24px; --sp8: 32px;
  --fs-xs: 11px; --fs-sm: 13px; --fs-base: 14px; --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 24px;
  --bw: 1px;
  /* control metrics (shadcn: h-9 / h-8 / h-10) + card anatomy */
  --control-h: 36px; --control-h-sm: 32px; --control-h-lg: 40px;
  --card-pad: var(--sp6);
  /* motion / stacking / fonts */
  --dur-fast: 120ms; --dur: 180ms; --dur-slow: 340ms;
  --ease-out: cubic-bezier(.16, 1, .3, 1); --ease: ease;
  --z-sticky: 10; --z-pop: 40; --z-toast: 60; --z-modal: 80;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  /* shadows — elevation is border + surface; shadow stays subtle */
  --shadow-xs: 0 1px 2px 0 oklch(0 0 0 / 0.05);
  --shadow-sm: 0 1px 3px 0 oklch(0 0 0 / 0.1), 0 1px 2px -1px oklch(0 0 0 / 0.1);
  --shadow-lg: 0 8px 24px -4px oklch(0 0 0 / 0.25);
  /* the signature two-part focus ring, part two */
  --ring-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
  /* sidebar namespace (header chrome) — tracks the theme automatically */
  --sidebar: var(--card); --sidebar-foreground: var(--foreground);
  --sidebar-primary: var(--primary); --sidebar-primary-foreground: var(--primary-foreground);
  --sidebar-accent: var(--accent); --sidebar-accent-foreground: var(--accent-foreground);
  --sidebar-border: var(--border); --sidebar-ring: var(--ring);
  /* legacy color aliases — older inline styles still resolve */
  --bg: var(--background); --panel: var(--card); --panel-2: var(--muted);
  --pop: var(--popover); --line: var(--border); --line-strong: var(--input);
  --ink: var(--foreground); --red: var(--destructive);
  --accent-dim: var(--primary); --on-accent: var(--primary-foreground);
}
/* Elevation ladder: background → card → muted → popover, lightness steps with
   zero chroma drift. Borders are alpha-white in the dark themes. */
:root, [data-theme="dark"] {
  color-scheme: dark;
  --background: oklch(0.155 0.004 220); --foreground: oklch(0.93 0.008 200);
  --card: oklch(0.21 0.006 215); --card-foreground: oklch(0.93 0.008 200);
  --popover: oklch(0.26 0.007 215); --popover-foreground: oklch(0.93 0.008 200);
  --primary: oklch(0.7 0.17 149); --primary-foreground: oklch(0.16 0.03 155);
  --secondary: oklch(0.235 0.007 215); --secondary-foreground: oklch(0.93 0.008 200);
  --muted: oklch(0.235 0.007 215); --muted-foreground: oklch(0.665 0.012 210);
  --accent: oklch(0.26 0.007 215); --accent-foreground: oklch(0.93 0.008 200);
  --destructive: oklch(0.66 0.2 25);
  --border: oklch(1 0 0 / 8%); --input: oklch(1 0 0 / 14%);
  --ring: oklch(0.7 0.16 149);
  --faint: oklch(0.49 0.012 210);
  --amber: oklch(0.72 0.14 80); --blue: oklch(0.66 0.16 262);
  --chart-1: oklch(0.7 0.17 149); --chart-2: oklch(0.66 0.16 262); --chart-3: oklch(0.72 0.14 80); --chart-4: oklch(0.66 0.2 25); --chart-5: oklch(0.7 0.12 305);
}
[data-theme="dim"] {
  --background: oklch(0.165 0.006 65); --foreground: oklch(0.925 0.015 85);
  --card: oklch(0.215 0.008 75); --card-foreground: oklch(0.925 0.015 85);
  --popover: oklch(0.28 0.01 75); --popover-foreground: oklch(0.925 0.015 85);
  --secondary: oklch(0.245 0.009 75); --secondary-foreground: oklch(0.925 0.015 85);
  --muted: oklch(0.245 0.009 75); --muted-foreground: oklch(0.67 0.02 85);
  --accent: oklch(0.28 0.01 75); --accent-foreground: oklch(0.925 0.015 85);
  --border: oklch(1 0 0 / 7%); --input: oklch(1 0 0 / 13%);
  --faint: oklch(0.5 0.02 85);
  --amber: oklch(0.76 0.14 82);
}
[data-theme="light"] {${LIGHT_TOKENS}
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {${LIGHT_TOKENS}
  }
}
/* Nova → Mira: one attribute compacts the whole console. */
[data-density="compact"] {
  --control-h: 32px; --control-h-sm: 28px; --card-pad: var(--sp4);
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
::placeholder { color: var(--muted-foreground); opacity: 1; }
/* the shadcn focus treatment: no outline; ring shadow everywhere, and
   bordered controls also flip their border to the ring color */
:focus-visible { outline: none; box-shadow: var(--ring-shadow); }
a:focus-visible, summary:focus-visible { border-radius: var(--radius-sm); }
button:focus-visible, .btn:focus-visible { border-color: var(--ring); }
.skip { position: absolute; left: -999px; top: 8px; background: var(--popover); color: var(--popover-foreground);
  padding: 8px 14px; border-radius: var(--radius-md); border: var(--bw) solid var(--input); z-index: var(--z-modal); }
.skip:focus { left: 12px; }

.wrap { max-width: 960px; margin: 0 auto; padding: 0 var(--sp6); }
.wrap-wide { max-width: 1400px; margin: 0 auto; padding: 0 var(--sp6); }

/* ── header / chrome (painted with the sidebar-* namespace) ──────────────── */
header.top { border-bottom: var(--bw) solid var(--sidebar-border); background: var(--sidebar);
  position: sticky; top: 0; z-index: var(--z-sticky); }
header.top .bar { display: flex; align-items: center; gap: var(--sp4); height: 54px; }
.brand { font-weight: 600; letter-spacing: -0.01em; display: flex; align-items: center; gap: 9px; color: var(--sidebar-foreground); }
.brand:hover { text-decoration: none; }
.brand .seed { width: 9px; height: 9px; border-radius: 50%; background: var(--sidebar-primary); flex: none;
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--sidebar-primary) 20%, transparent); }
.brand .dom { font-family: var(--mono); font-size: var(--fs-sm); color: var(--muted-foreground); font-weight: 500; }
.top .spacer { flex: 1; }
.top nav a { color: var(--muted-foreground); font-size: var(--fs-sm); padding: 5px 2px; }
.top nav a:hover, .top nav a.on { color: var(--sidebar-foreground); text-decoration: none; }
.top nav a.on { box-shadow: inset 0 -2px 0 var(--sidebar-primary); }
.who { color: var(--faint); font-size: var(--fs-xs); font-family: var(--mono); }
.crumbs { display: flex; align-items: center; gap: 7px; height: 34px; font-size: var(--fs-sm);
  color: var(--muted-foreground); font-family: var(--mono); overflow-x: auto; scrollbar-width: none; }
.crumbs::-webkit-scrollbar { display: none; }
.crumbs a { color: var(--muted-foreground); white-space: nowrap; } .crumbs a:hover { color: var(--sidebar-foreground); }
.crumbs .sep { color: var(--faint); }
.crumbs .cur { color: var(--sidebar-foreground); font-weight: 500; white-space: nowrap; }

/* crew status pill (worst active agent state) */
.crew { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px 4px 9px; white-space: nowrap;
  border: var(--bw) solid var(--sidebar-border); border-radius: var(--r-full); font-size: var(--fs-xs);
  color: var(--muted-foreground); background: var(--muted); }
.crew:hover { text-decoration: none; color: var(--sidebar-foreground); border-color: var(--input); }
.crew.working { color: var(--amber); border-color: color-mix(in oklab, var(--amber) 36%, var(--border)); }
.crew.blocked { color: var(--destructive); border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); }

/* theme toggle */
.tmc { display: inline-flex; border: var(--bw) solid var(--sidebar-border); border-radius: var(--r-full);
  padding: 2px; background: var(--muted); }
.tmc button { background: none; border: 0; padding: 3px 7px; height: auto; border-radius: var(--r-full); cursor: pointer;
  color: var(--faint); font-size: 12px; line-height: 1; }
.tmc button:hover { background: transparent; color: var(--sidebar-foreground); }
.tmc button.on { background: var(--popover); color: var(--sidebar-foreground); box-shadow: inset 0 0 0 1px var(--border); }

main { padding: 28px 0 88px; }
h1 { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
h2 { font-size: var(--fs-lg); font-weight: 600; margin: 0 0 10px; letter-spacing: -0.01em; }
.sub { color: var(--muted-foreground); margin: 0 0 24px; font-size: var(--fs-sm); }
.label { text-transform: uppercase; letter-spacing: 0.08em; font-size: var(--fs-xs); color: var(--faint); font-weight: 600; }
.mut { color: var(--muted-foreground); } .faint { color: var(--faint); } .big { font-size: var(--fs-lg); }
.err { color: var(--destructive); font-size: var(--fs-sm); margin: 0 0 12px; }

/* ── utilities (kill inline-style sprawl) ────────────────────────────────── */
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.grow { flex: 1; min-width: 0; } .nowrap { white-space: nowrap; } .prewrap { white-space: pre-wrap; }
.stack { display: flex; flex-direction: column; gap: var(--sp3); }
.mt { margin-top: 22px; } .mb { margin-bottom: 10px; } .mt-s { margin-top: 10px; } .m0 { margin: 0; }
.hide { display: none; }

/* ── cards (shadcn anatomy: 1px border, radius-xl, card-pad, shadow-xs) ──── */
.card { background: var(--card); color: var(--card-foreground);
  border: var(--bw) solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-xs); }
.card.pad { padding: var(--card-pad); }
.card.warn { border-color: color-mix(in oklab, var(--amber) 45%, var(--border)); }
.card.danger { border-color: color-mix(in oklab, var(--destructive) 45%, var(--border)); }
/* optional slot classes for future templates */
.card-header { display: flex; align-items: flex-start; gap: var(--sp2); padding: var(--card-pad) var(--card-pad) 0; }
.card-title { font-weight: 600; line-height: 1.2; margin: 0; }
.card-desc { color: var(--muted-foreground); font-size: var(--fs-sm); margin: 2px 0 0; }
.card-content { padding: var(--card-pad); }
.card-footer { padding: 0 var(--card-pad) var(--card-pad); display: flex; align-items: center; gap: var(--sp2); }
.idcard { display: grid; grid-template-columns: auto 1fr; gap: 7px 20px; padding: 18px var(--card-pad); margin-bottom: 26px; align-items: baseline; }
.idcard .k { color: var(--faint); font-size: var(--fs-sm); }
.idcard .v { font-family: var(--mono); font-size: 12.5px; word-break: break-all; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.app { display: block; padding: var(--sp4) 18px;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease-out); }
.app:hover { border-color: color-mix(in oklab, var(--primary) 45%, var(--border)); text-decoration: none;
  transform: translateY(-1px); box-shadow: var(--shadow-sm); }
.app .name { font-weight: 600; color: var(--foreground); display: flex; align-items: center; gap: 9px; }
.app .host { font-family: var(--mono); font-size: var(--fs-sm); color: var(--muted-foreground); margin-top: 7px; word-break: break-all; }
.app .foot { margin-top: 12px; display: flex; align-items: center; gap: 8px; color: var(--faint); font-size: var(--fs-sm); }

/* ── status dot ──────────────────────────────────────────────────────────── */
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: var(--faint); vertical-align: middle; position: relative; top: -1px; }
.dot.running { background: var(--primary); box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 22%, transparent); }
.dot.building, .dot.pending, .dot.queued, .dot.cloning, .dot.starting, .dot.built {
  background: var(--amber); animation: pulse 1.1s ease-in-out infinite; }
.dot.error, .dot.failed { background: var(--destructive); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.state { text-transform: capitalize; }

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
button:disabled, .btn:disabled, .btn.is-loading { opacity: .5; pointer-events: none; }
.btn.secondary { background: var(--secondary); color: var(--secondary-foreground); border-color: var(--border); }
.btn.secondary:hover { background: var(--accent); border-color: var(--input); }
.btn.outline { background: transparent; color: var(--foreground); border-color: var(--input); }
.btn.outline:hover { background: var(--accent); }
button.ghost, .btn.ghost { background: transparent; color: var(--muted-foreground); border-color: transparent; }
button.ghost:hover, .btn.ghost:hover { color: var(--foreground); background: var(--accent); }
.btn.danger, .btn.destructive { background: transparent; color: var(--destructive);
  border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); }
.btn.danger:hover, .btn.destructive:hover { background: color-mix(in oklab, var(--destructive) 10%, transparent); }
.btn.danger:focus-visible, .btn.destructive:focus-visible { border-color: var(--destructive);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 25%, transparent); }
button.sm, .btn.sm { height: var(--control-h-sm); padding: 0 var(--sp3); font-size: var(--fs-xs); gap: 6px; }
button.icon, .btn.icon { height: var(--control-h-sm); width: var(--control-h-sm); padding: 0; }
.btn.is-loading::before { content: ""; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent; animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── forms (h-9 inputs, border --input, focus flips to ring) ─────────────── */
form.newapp { display: flex; gap: var(--sp2); margin: 0 0 22px; flex-wrap: wrap; }
/* on-ramp: the workflow-first front door */
.onramp { margin: 8px 0 28px; }
.onramp h1 { font-size: var(--fs-2xl); }
.onramp .sub { max-width: 62ch; margin-bottom: 16px; }
.onramp-form { display: flex; gap: var(--sp2); align-items: flex-end; flex-wrap: wrap; margin: 0 0 12px; }
.onramp-form textarea { flex: 1; min-height: 60px; min-width: 260px; font-size: var(--fs-lg); }
.onramp-form button { height: var(--control-h); }
.onramp-note { color: var(--muted-foreground); font-size: var(--fs-sm); margin: 0 0 18px; }
.starters-label { color: var(--faint); font-size: var(--fs-sm); margin: 0 0 8px; }
.starters { display: flex; flex-wrap: wrap; gap: var(--sp2); }
.chip.starter { cursor: pointer; font-family: var(--sans); font-size: var(--fs-sm); padding: 5px 12px;
  transition: color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease); }
.chip.starter:hover { color: var(--primary); border-color: color-mix(in oklab, var(--primary) 45%, var(--border));
  background: color-mix(in oklab, var(--primary) 8%, transparent); }
details.advanced { margin-top: 20px; }
details.advanced > summary { cursor: pointer; color: var(--muted-foreground); font-size: var(--fs-sm);
  list-style: none; width: fit-content; padding: 4px 0; }
details.advanced > summary::-webkit-details-marker { display: none; }
details.advanced > summary::before { content: "＋ "; color: var(--faint); }
details.advanced[open] > summary::before { content: "－ "; }
details.advanced > summary:hover { color: var(--foreground); }
details.advanced > form.newapp { margin-top: 12px; }
input[type=text], input[type=password], input[type=url], input:not([type]), textarea, .input {
  background: color-mix(in oklab, var(--input) 25%, transparent);
  border: var(--bw) solid var(--input); color: var(--foreground);
  border-radius: var(--radius-md); height: var(--control-h); padding: 0 var(--sp3);
  font-size: var(--fs-base); font-family: var(--sans); outline: none; width: 100%; min-width: 0;
  box-shadow: var(--shadow-xs);
  transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease); }
textarea { height: auto; resize: vertical; min-height: 76px; line-height: 1.5; padding: var(--sp2) var(--sp3); }
input:focus-visible, textarea:focus-visible, select:focus-visible, .input:focus-visible {
  border-color: var(--ring); box-shadow: var(--ring-shadow); }
/* validation is attribute-driven (aria-invalid), destructive-tinted ring */
[aria-invalid="true"], [aria-invalid="true"]:focus-visible,
.field.err input, .field.err input:focus-visible,
.field.err textarea, .field.err textarea:focus-visible {
  border-color: var(--destructive);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 22%, transparent); }
input.mono { font-family: var(--mono); font-size: 13px; }
label.check { font-size: var(--fs-sm); color: var(--muted-foreground); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; cursor: pointer; }
/* field anatomy: label / control / description / error */
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: var(--fs-sm); font-weight: 500; color: var(--foreground); }
.field-desc { font-size: var(--fs-sm); color: var(--muted-foreground); }
.field-error { font-size: var(--fs-sm); color: var(--destructive); }

/* ── pills / chips / badges ──────────────────────────────────────────────── */
.pill, .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; padding: 2px 8px;
  border-radius: var(--r-full); background: var(--muted); border: var(--bw) solid var(--border);
  color: var(--muted-foreground); font-family: var(--mono); line-height: 1.5; white-space: nowrap; }
.chip.agent, .pill.agent { color: var(--primary); border-color: color-mix(in oklab, var(--primary) 40%, var(--border)); }
.pill.open { color: var(--primary); border-color: color-mix(in oklab, var(--primary) 40%, var(--border)); }
.pill.merged { color: var(--blue); border-color: color-mix(in oklab, var(--blue) 40%, var(--border)); }
.pill.closed { color: var(--faint); }
.pill.building, .pill.reviewing { color: var(--amber); border-color: color-mix(in oklab, var(--amber) 40%, var(--border)); }
.pill.blocked { color: var(--amber); border-color: color-mix(in oklab, var(--amber) 45%, var(--border)); background: color-mix(in oklab, var(--amber) 10%, transparent); }
.pill.ok { color: var(--primary); } .pill.fail { color: var(--destructive); border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); }
.chip.rm { cursor: pointer; } .chip.rm:hover { color: var(--destructive); border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); }
kbd, .kbd { font-family: var(--mono); font-size: var(--fs-xs); color: var(--muted-foreground);
  background: var(--muted); border: var(--bw) solid var(--border); border-radius: var(--radius-sm); padding: 1px 5px; }

/* ── tabs (segmented) ────────────────────────────────────────────────────── */
.tabs { display: inline-flex; gap: 2px; background: var(--muted); border-radius: var(--radius-lg); padding: 3px;
  border: var(--bw) solid var(--border); }
.tab { background: none; border: 0; height: 30px; padding: 0 14px; border-radius: var(--radius-md); color: var(--muted-foreground);
  font-size: var(--fs-sm); font-weight: 500; cursor: pointer; }
.tab:hover { color: var(--foreground); background: transparent; }
.tab.on { background: var(--popover); color: var(--foreground); box-shadow: var(--shadow-xs); }
.tabpane { display: none; } .tabpane.on { display: block; }
.tab:focus-visible { box-shadow: var(--ring-shadow); }
.tabs.sm { padding: 2px; }
.tabs.sm .tab { height: 26px; padding: 0 10px; font-size: var(--fs-xs); }
select { background: color-mix(in oklab, var(--input) 25%, transparent); border: var(--bw) solid var(--input);
  color: var(--foreground); border-radius: var(--radius-md);
  padding: 0 10px; height: var(--control-h); font-size: var(--fs-sm); font-family: var(--sans); cursor: pointer; outline: none;
  box-shadow: var(--shadow-xs); transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease); }
select:focus-visible { border-color: var(--ring); box-shadow: var(--ring-shadow); }
.filterbar { gap: var(--sp2); flex-wrap: nowrap; }
@media (max-width: 600px) { .filterbar { flex-wrap: wrap; } .filterbar #fq { order: -1; width: 100%; } }

/* ── list rows (issues, PRs) — hover flips to the accent surface ─────────── */
.rows { display: flex; flex-direction: column; }
.list-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: var(--radius-md); color: inherit;
  border-bottom: var(--bw) solid color-mix(in oklab, var(--border) 60%, transparent); }
.list-row:last-child { border-bottom: 0; }
.list-row:hover { background: var(--accent); text-decoration: none; }
.list-row .num { font-family: var(--mono); font-size: var(--fs-sm); color: var(--faint); }
.list-row .ttl { font-size: 13.5px; color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-row .meta { display: flex; align-items: center; gap: 6px; }

/* ── data tables (integration map) ───────────────────────────────────────── */
.tablewrap { overflow-x: auto; }
table.data { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
table.data th { text-align: left; padding: 6px 10px; border-bottom: var(--bw) solid var(--border);
  text-transform: uppercase; letter-spacing: 0.08em; font-size: var(--fs-xs); color: var(--faint); font-weight: 600; }
table.data td { padding: 9px 10px; vertical-align: top;
  border-bottom: var(--bw) solid color-mix(in oklab, var(--border) 60%, transparent); }
table.data tr:last-child td { border-bottom: 0; }

/* ── deploy timeline ─────────────────────────────────────────────────────── */
.tl { display: flex; flex-direction: column; }
.tl-ev { display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 9px;
  padding: 7px 0; border-bottom: var(--bw) solid color-mix(in oklab, var(--border) 55%, transparent); }
.tl-ev:last-child { border-bottom: 0; }
.tl-ev .ph { font-size: 13px; font-weight: 500; text-transform: capitalize; }
.tl-ev .msg { font-size: var(--fs-sm); color: var(--muted-foreground); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-ev .t { font-size: var(--fs-xs); color: var(--faint); font-variant-numeric: tabular-nums; }

/* ── logs ────────────────────────────────────────────────────────────────── */
pre.logs { background: color-mix(in oklab, var(--background) 60%, transparent); border: var(--bw) solid var(--border);
  border-radius: var(--radius-md); margin: 0; padding: 13px 15px; font-family: var(--mono); font-size: 12px; line-height: 1.5;
  color: var(--muted-foreground); max-height: 380px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.diff-add { color: var(--primary); } .diff-del { color: var(--destructive); } .diff-hd { color: var(--blue); }

/* ── skeleton (bg-accent + pulse, sized like the content it replaces) ────── */
.sk { background: var(--accent); border-radius: var(--radius-sm); animation: pulse 1.6s ease-in-out infinite; height: 12px; }
.sk.line { height: 12px; margin: 8px 0; } .sk.w60 { width: 60%; } .sk.w40 { width: 40%; } .sk.w80 { width: 80%; }

/* ── tooltip (CSS-only) ──────────────────────────────────────────────────── */
[data-tip] { position: relative; }
[data-tip]:hover::after { content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  background: var(--foreground); color: var(--background); font-size: var(--fs-xs); padding: 4px 8px; border-radius: var(--radius-sm);
  white-space: nowrap; z-index: var(--z-pop); pointer-events: none; opacity: 0; animation: tipin var(--dur) var(--ease-out) forwards; }
@keyframes tipin { to { opacity: 1; } }

/* ── pipeline stepper ────────────────────────────────────────────────────── */
.pipeline { display: flex; gap: 0; list-style: none; padding: 0; margin: 0 0 24px; }
.pipeline .step { flex: 1; display: flex; align-items: center; gap: 7px; font-size: var(--fs-sm); color: var(--faint); }
.pipeline .step .dot { position: static; }
.pipeline .step::after { content: ""; flex: 1; height: 2px; margin: 0 8px; border-radius: 2px;
  background: linear-gradient(90deg, var(--primary) 50%, var(--border) 50%); background-size: 200% 100%;
  background-position: 100% 0; transition: background-position var(--dur-slow) var(--ease-out); }
.pipeline .step:last-child::after { display: none; }
.pipeline .step.done { color: var(--foreground); } .pipeline .step.done::after { background-position: 0 0; }
.pipeline .step.active { color: var(--foreground); font-weight: 500; }
.pipeline .step.failed { color: var(--destructive); }

/* ── crew activity feed (the flagship) ───────────────────────────────────── */
.feed { display: flex; flex-direction: column; gap: 2px; }
.feed-block { animation: feedin var(--dur) var(--ease-out); }
@keyframes feedin { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.feed-phase { display: flex; align-items: center; gap: 8px; margin: 16px 0 8px; font-size: var(--fs-sm);
  font-weight: 500; color: var(--foreground); }
.feed-phase .who { color: var(--muted-foreground); font-weight: 400; }
.feed-phase::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.feed-body { font-size: 13.5px; color: var(--muted-foreground); padding: 3px 0; }
.feed-body.prose { color: var(--foreground); }
.feed-t { font-size: var(--fs-xs); color: var(--faint); font-variant-numeric: tabular-nums; }
.tool { border: var(--bw) solid var(--border); border-radius: var(--radius-md); margin: 4px 0; background: var(--card); overflow: hidden; }
.tool > summary { display: flex; align-items: center; gap: 8px; padding: 7px 11px; cursor: pointer; font-size: var(--fs-sm); list-style: none; }
.tool > summary::-webkit-details-marker { display: none; }
.tool > summary code { background: var(--muted); padding: 1px 6px; border-radius: var(--radius-sm); color: var(--foreground); }
.tool > summary .grow { color: var(--muted-foreground); font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool[open] > summary { border-bottom: var(--bw) solid var(--border); }
.tool.err { border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); }
.tool pre.logs { border: 0; border-radius: 0; max-height: 240px; }
.feed-verdict { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin: 12px 0; padding: 12px 15px;
  border: var(--bw) solid var(--border); border-left: 3px solid var(--faint); border-radius: var(--radius-md);
  background: var(--card); font-size: 13.5px; }
.feed-verdict .v-icon { font-size: 15px; }
.feed-verdict.pass { border-left-color: var(--primary); }
.feed-verdict.warn { border-left-color: var(--amber); }
.feed-verdict.fail { border-left-color: var(--destructive); }
.feed-human { margin: 8px 0; padding: 11px 14px; }
.feed-human b { color: var(--foreground); font-size: var(--fs-sm); }
.prose code { background: var(--muted); padding: 1px 5px; border-radius: var(--radius-sm); }
.prose pre.logs { margin: 6px 0; }
.newpill { display: inline-flex; align-items: center; gap: 5px; position: sticky; bottom: 8px; align-self: center;
  padding: 4px 12px; background: var(--popover); border: var(--bw) solid var(--input); border-radius: var(--r-full);
  font-size: var(--fs-xs); cursor: pointer; box-shadow: var(--shadow-lg); }

/* ── misc ────────────────────────────────────────────────────────────────── */
.cols { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 28px; align-items: start; }
.copy { cursor: pointer; } .copy:hover { color: var(--foreground); }
.toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%) translateY(8px);
  background: var(--popover); color: var(--popover-foreground); border: var(--bw) solid var(--border); border-radius: var(--radius-lg);
  padding: 10px 16px; font-size: var(--fs-sm); opacity: 0; transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease-out);
  pointer-events: none; z-index: var(--z-toast); box-shadow: var(--shadow-lg); }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.tree { font-family: var(--mono); font-size: 13px; line-height: 1.9; }
.tree .gen { color: var(--muted-foreground); } .tree .arrow { color: var(--faint); }
/* empty state: centered, dashed border, muted description (shadcn Empty) */
.empty { color: var(--muted-foreground); text-align: center; padding: 44px var(--sp6);
  border: 1px dashed var(--border); border-radius: var(--radius-xl); font-size: var(--fs-base); }
.empty .empty-icon, .empty .empty-media { display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; margin: 0 auto var(--sp3); border-radius: var(--radius-md);
  background: var(--muted); color: var(--muted-foreground); }
.empty .empty-title { color: var(--foreground); font-weight: 500; margin: 0 0 4px; }
.empty .empty-desc { color: var(--muted-foreground); font-size: var(--fs-sm); margin: 0 auto; max-width: 46ch; }
.empty .empty-actions { display: flex; justify-content: center; gap: var(--sp2); margin-top: var(--sp4); }

/* login */
.login { max-width: 360px; margin: 12vh auto 0; }
.login .card { padding: var(--card-pad); }
.login h1 { margin-bottom: 18px; }
.login form { display: flex; flex-direction: column; gap: 11px; }
.login button { height: var(--control-h-lg); }

/* ── responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
@media (max-width: 600px) {
  .wrap, .wrap-wide { padding: 0 16px; }
  header.top .bar { gap: 10px; }
  .top nav, .who { display: none; }
  .idcard { grid-template-columns: 1fr; gap: 3px 0; }
  .idcard .k { margin-top: 8px; }
  .list-row { grid-template-columns: auto 1fr; }
  .list-row .meta { grid-column: 2; justify-content: flex-start; }
  .pipeline { flex-direction: column; align-items: flex-start; gap: 6px; }
  .pipeline .step { width: 100%; } .pipeline .step::after { display: none; }
  h1 { font-size: var(--fs-lg); }
  form.newapp { flex-direction: column; align-items: stretch; }
  .feed-verdict { flex-direction: column; align-items: flex-start; }
}
/* ── docs: the reading surface ────────────────────────────────────────────
   Three panes on the token system: groups sidebar / ~46rem prose / scroll-spy
   TOC. The TOC folds first (<1280px), the sidebar becomes an in-flow drawer
   (<980px). Prose is em-rhythm'd (.typeset) at 15px so one wrapper size
   scales the whole page; headings land below the sticky header via
   scroll-margin. */
.docs { display: grid; grid-template-columns: 240px minmax(0, 1fr) 216px; gap: 44px; align-items: start; }
.docs-nav, .docs-toc { position: sticky; top: 102px; max-height: calc(100vh - 122px); overflow-y: auto; scrollbar-width: thin; padding-bottom: 24px; }
.docs-mobilebar { display: none; }

.dsearch-btn { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px;
  height: var(--control-h-sm); padding: 0 10px; margin: 0 0 16px;
  background: color-mix(in oklab, var(--input) 25%, transparent); border: var(--bw) solid var(--input);
  border-radius: var(--radius-md); color: var(--muted-foreground); font-size: var(--fs-sm); cursor: pointer; font-family: var(--sans); }
.dsearch-btn:hover { color: var(--foreground); border-color: var(--ring); background: transparent; }
.dnav-group { margin-bottom: 18px; }
.dnav-label { text-transform: uppercase; letter-spacing: 0.08em; font-size: var(--fs-xs); color: var(--faint); font-weight: 600; padding: 0 8px 6px; }
.dnav a { display: block; padding: 5px 8px; border-radius: var(--radius-md); color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
.dnav a:hover { color: var(--foreground); background: var(--accent); text-decoration: none; }
.dnav a[aria-current="page"] { color: var(--foreground); background: var(--accent); font-weight: 500; box-shadow: inset 2px 0 0 var(--primary); }

.dtoc-label { text-transform: uppercase; letter-spacing: 0.08em; font-size: var(--fs-xs); color: var(--faint); font-weight: 600; margin-bottom: 8px; }
.dtoc-list { display: flex; flex-direction: column; border-left: var(--bw) solid var(--border); }
.dtoc-list a { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.5; padding: 3px 0 3px 13px; margin-left: -1px; border-left: 2px solid transparent; }
.dtoc-list a[data-depth="3"] { padding-left: 26px; }
.dtoc-list a:hover { color: var(--foreground); text-decoration: none; }
.dtoc-list a.on { color: var(--foreground); font-weight: 500; border-left-color: var(--primary); }

.docs-page { max-width: 46rem; margin: 0 auto; min-width: 0; }
.docs-head { margin-bottom: 6px; }
.docs-head h1 { font-size: 27px; letter-spacing: -0.02em; margin: 0 0 6px; }
.docs-desc { color: var(--muted-foreground); font-size: 15px; margin: 0; text-wrap: pretty; }
.docs-actions { display: flex; gap: 6px; margin: 14px 0 0; }

.typeset { font-size: 15px; line-height: 1.7; }
.typeset p { margin: 1.05em 0 0; text-wrap: pretty; }
.typeset h3, .typeset h4, .typeset h5 { letter-spacing: -0.01em; scroll-margin-top: 110px; position: relative; margin: 2em 0 0; }
.typeset h3 { font-size: 19px; }
.typeset h4 { font-size: 16px; }
.typeset h5 { font-size: 14px; }
.typeset h3 + *, .typeset h4 + *, .typeset h5 + * { margin-top: 0.8em; }
.h-anchor { margin-left: 9px; color: var(--faint); font-weight: 400; opacity: 0; transition: opacity var(--dur-fast) var(--ease); }
.h-anchor:hover { color: var(--primary); text-decoration: none; }
:is(h3, h4, h5):hover .h-anchor, .h-anchor:focus-visible { opacity: 1; }
.typeset a { color: var(--foreground); font-weight: 500; text-decoration: underline;
  text-decoration-color: color-mix(in oklab, var(--primary) 55%, transparent); text-underline-offset: 3px; }
.typeset a:hover { color: var(--primary); }
.typeset code { background: var(--muted); border: var(--bw) solid var(--border); border-radius: var(--radius-sm); padding: 1px 5px; }
.typeset a.code-ref { text-decoration: none; font-weight: 400; }
.typeset a.code-ref code { border-color: color-mix(in oklab, var(--primary) 40%, var(--border)); }
.typeset a.code-ref:hover code { color: var(--primary); border-color: var(--primary); }
.typeset ul, .typeset ol { margin: 1.05em 0 0; padding-left: 1.45em; }
.typeset li { margin-top: 0.45em; }
.typeset li::marker { color: var(--faint); }
.typeset li > ul, .typeset li > ol { margin-top: 0.45em; }
.typeset blockquote { margin: 1.4em 0 0; border-left: 2px solid var(--border); padding-left: 1em; color: var(--muted-foreground); }
.typeset hr { border: 0; border-top: var(--bw) solid var(--border); margin: 2.4em 0 0; }
.typeset .tablewrap { margin: 1.4em 0 0; }
.typeset table.data td { font-size: 13.5px; }

/* code figures: filename bar, internal scroll, hover copy */
.codeblock { position: relative; margin: 1.35em 0 0; border: var(--bw) solid var(--border); border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--background) 55%, var(--card)); overflow: hidden; }
.codeblock figcaption { padding: 8px 42px 8px 14px; border-bottom: var(--bw) solid var(--border);
  font-family: var(--mono); font-size: 12px; color: var(--muted-foreground); }
.codeblock pre { margin: 0; padding: 13px 16px; overflow-x: auto; max-height: 430px; overflow-y: auto;
  font-family: var(--mono); font-size: 13px; line-height: 1.65; font-variant-ligatures: none; tab-size: 2; }
.codeblock code { background: none; border: 0; padding: 0; font-size: inherit; border-radius: 0; }
.cb-copy { position: absolute; top: 6px; right: 6px; height: 26px; width: 26px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: transparent; border: var(--bw) solid transparent; border-radius: var(--radius-sm);
  cursor: pointer; font-size: 13px; line-height: 1; }
.codeblock:hover .cb-copy, .cb-copy:focus-visible { color: var(--muted-foreground); }
.cb-copy:hover { color: var(--foreground); background: var(--accent); }
.cb-copy.ok, .codeblock:hover .cb-copy.ok { color: var(--primary); }

/* syntax tokens ride the theme vars — one highlighter output, three themes */
.tk-c { color: var(--faint); font-style: italic; }
.tk-s { color: color-mix(in oklab, var(--primary) 78%, var(--foreground)); }
.tk-k { color: var(--blue); }
.tk-n { color: var(--amber); }

/* callouts: one per concept, the type does the work */
.callout { margin: 1.35em 0 0; padding: 11px 15px; border: var(--bw) solid var(--border); border-left-width: 3px;
  border-radius: var(--radius-md); background: var(--card); font-size: 14px; }
.callout-title { font-weight: 600; font-size: var(--fs-sm); margin-bottom: 2px; }
.callout.note { border-left-color: var(--blue); } .callout.note .callout-title { color: var(--blue); }
.callout.tip { border-left-color: var(--primary); } .callout.tip .callout-title { color: var(--primary); }
.callout.warn { border-left-color: var(--amber); } .callout.warn .callout-title { color: var(--amber); }
.callout.danger { border-left-color: var(--destructive); } .callout.danger .callout-title { color: var(--destructive); }

/* prev / next */
.docs-pn { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 48px; padding-top: 22px; border-top: var(--bw) solid var(--border); }
.pn { display: flex; flex-direction: column; gap: 2px; padding: 12px 16px; border: var(--bw) solid var(--border); border-radius: var(--radius-lg); }
.pn:hover { border-color: color-mix(in oklab, var(--primary) 45%, var(--border)); text-decoration: none; }
.pn.next { align-items: flex-end; text-align: right; }
.pn-k { font-size: var(--fs-xs); color: var(--faint); }
.pn-t { font-size: var(--fs-sm); font-weight: 500; color: var(--foreground); }

/* ⌘K palette */
.dsearch-veil { position: fixed; inset: 0; background: oklch(0 0 0 / 0.5); z-index: var(--z-modal); padding: 0 16px; }
.dsearch { max-width: 560px; margin: 12vh auto 0; background: var(--popover); border: var(--bw) solid var(--input);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); overflow: hidden; }
.dsearch input, .dsearch input:focus-visible { border: 0; border-bottom: var(--bw) solid var(--border); border-radius: 0;
  height: 48px; font-size: 15px; background: transparent; box-shadow: none; padding: 0 16px; }
.dsearch-hits { max-height: 330px; overflow-y: auto; padding: 6px; }
.hit { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; padding: 9px 10px;
  border-radius: var(--radius-md); color: var(--foreground); font-size: var(--fs-sm); }
.hit:hover, .hit.on { text-decoration: none; background: var(--accent); }
.hit-t mark { background: transparent; color: var(--primary); }
.hit-h { color: var(--muted-foreground); font-size: var(--fs-xs); }
.hit-s { color: var(--faint); font-size: var(--fs-xs); white-space: nowrap; }
.hit-none { padding: 18px; color: var(--muted-foreground); font-size: var(--fs-sm); text-align: center; }
.dsearch-foot { display: flex; gap: 14px; padding: 8px 14px; border-top: var(--bw) solid var(--border); color: var(--faint); font-size: var(--fs-xs); }

/* ── blob: the source viewer docs link into ──────────────────────────────── */
.blob-head { margin-bottom: 10px; }
.blob-path { font-size: 12.5px; color: var(--muted-foreground); word-break: break-all; }
.blob { border: var(--bw) solid var(--border); border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--background) 55%, var(--card)); overflow-x: auto; padding: 10px 0; font-size: 12.5px; line-height: 1.6; }
.bl { display: grid; grid-template-columns: 3.6em 1fr; scroll-margin-top: 110px; }
.bln { text-align: right; padding-right: 14px; color: var(--faint); font-size: 11px; user-select: none; }
.bln:hover { color: var(--foreground); text-decoration: none; }
.blc { white-space: pre; padding-right: 16px; }
.bl.hl { background: color-mix(in oklab, var(--amber) 13%, transparent); box-shadow: inset 2px 0 0 var(--amber); }

@media (max-width: 1279px) {
  .docs { grid-template-columns: 232px minmax(0, 1fr); gap: 36px; }
  .docs-toc { display: none; }
}
@media (max-width: 979px) {
  .docs { display: block; }
  .docs-mobilebar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .docs-mobilebar > .mut { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* the drawer is IN FLOW (no z-index dance): Menu expands the nav above the page */
  .docs-nav { display: none; position: static; max-height: none; }
  .docs-nav.open { display: block; border-bottom: var(--bw) solid var(--border); padding-bottom: 14px; margin-bottom: 18px; }
  .docs-pn { grid-template-columns: 1fr; }
}

/* ── the guide panel: right sheet on desktop, bottom sheet on phones ─────── */
.gp { position: fixed; top: 0; right: 0; bottom: 0; width: 400px; max-width: 100vw; z-index: var(--z-pop);
  display: flex; flex-direction: column; background: var(--background);
  border-left: var(--bw) solid var(--input); box-shadow: var(--shadow-lg);
  transform: translateX(105%); transition: transform var(--dur-slow) var(--ease-out); visibility: hidden; }
.gp.open { transform: none; visibility: visible; }
.gp-head { display: flex; align-items: center; gap: 6px; height: 54px; flex: none;
  padding: 0 10px 0 16px; border-bottom: var(--bw) solid var(--border); }
.gp-title { display: flex; align-items: center; gap: 9px; font-weight: 600; font-size: var(--fs-sm); }
.gp-title .seed { width: 8px; height: 8px; border-radius: 50%; background: var(--primary);
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--primary) 20%, transparent); }
.gp-log { flex: 1; overflow-y: auto; padding: 16px 16px 8px; display: flex; flex-direction: column; gap: 12px; }
.gp-hello { color: var(--muted-foreground); font-size: 13.5px; line-height: 1.65;
  border: 1px dashed var(--border); border-radius: var(--radius-lg); padding: 14px 16px; }
.gm { font-size: 13.5px; line-height: 1.65; min-width: 0; overflow-wrap: break-word; }
.gm.user { align-self: flex-end; max-width: 86%; white-space: pre-wrap;
  background: var(--muted); border: var(--bw) solid var(--border);
  padding: 8px 12px; border-radius: var(--radius-lg); }
.gm.bot code, .gp-hello code { background: var(--muted); border: var(--bw) solid var(--border);
  border-radius: var(--radius-sm); padding: 1px 5px; }
.gm.bot a { text-decoration: underline; text-underline-offset: 3px;
  text-decoration-color: color-mix(in oklab, var(--primary) 55%, transparent); }
.gp-code { max-height: 220px; font-size: 11.5px; margin: 6px 0; }
.gm.tools { display: flex; flex-direction: column; gap: 5px; }
.gp-tool { display: flex; align-items: center; gap: 7px; font-family: var(--mono); font-size: 11.5px; color: var(--faint); }
.gp-tool code { background: none; border: 0; padding: 0; color: var(--muted-foreground); }
.gm.src { display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  font-size: var(--fs-xs); color: var(--faint); }
.gm.src .pill { color: var(--muted-foreground); }
.gm.src .pill:hover { color: var(--primary); border-color: color-mix(in oklab, var(--primary) 40%, var(--border)); text-decoration: none; }
.gp-form { display: flex; align-items: flex-end; gap: 8px; padding: 12px 14px; flex: none;
  border-top: var(--bw) solid var(--border); }
.gp-form textarea { min-height: 40px; max-height: 140px; font-size: 13.5px; }
.gp-form button { width: 40px; height: 40px; padding: 0; border-radius: var(--radius-lg); font-size: 16px; flex: none; }
@media (max-width: 600px) {
  .gp { top: auto; height: 80vh; width: 100%; border-left: 0; border-top: var(--bw) solid var(--input);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0; transform: translateY(105%); }
  .gp.open { transform: none; }
}

@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
