// One stylesheet, inlined — no external fonts, no CDN, nothing to fetch. The
// page renders identically offline and inside a locked-down CSP. Every value
// comes from a token; components never hardcode a color. Themes are a single
// attribute swap ([data-theme]); the one green accent is the only chroma, so it
// always reads as signal. Elevation is lightness steps, not shadow; dark
// borders are alpha-white. That restraint is the whole "no-nonsense" feel.
export const STYLE = `
:root {
  /* scale — one radius knob, calc-derived */
  --r: 10px; --r-sm: calc(var(--r) - 4px); --r-md: calc(var(--r) - 2px);
  --r-lg: var(--r); --r-xl: calc(var(--r) + 4px); --r-full: 999px;
  --sp1: 4px; --sp2: 8px; --sp3: 12px; --sp4: 16px; --sp5: 20px; --sp6: 24px; --sp8: 32px;
  --fs-xs: 11px; --fs-sm: 12.5px; --fs-base: 14px; --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 24px;
  --bw: 1px;
  --dur-fast: 120ms; --dur: 180ms; --dur-slow: 340ms;
  --ease-out: cubic-bezier(.16, 1, .3, 1); --ease: ease;
  --z-sticky: 10; --z-pop: 40; --z-toast: 60; --z-modal: 80;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --accent: #3fb950; --accent-dim: #2ea043; --amber: #d29922; --red: #f85149; --blue: #4c8fff;
  --ring: 0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent);
  --on-accent: #04140a;
}
/* Elevation ladder: bg → panel → panel-2 → pop, each ~+5% lightness, zero
   chroma drift. Borders are alpha-white in the dark themes. */
:root, [data-theme="dark"] {
  --bg: #0b0d0e; --panel: #14181a; --panel-2: #191e21; --pop: #1e2427;
  --line: #ffffff14; --line-strong: #ffffff24;
  --ink: #e6edef; --muted: #8b9599; --faint: #5b6467;
}
[data-theme="dim"] {
  --bg: #12100e; --panel: #1b1815; --panel-2: #221e1a; --pop: #2a2521;
  --line: #ffffff12; --line-strong: #ffffff20;
  --ink: #ece4da; --muted: #9c9184; --faint: #6b6157; --amber: #e0a83e;
}
[data-theme="light"] {
  --bg: #f6f8f8; --panel: #ffffff; --panel-2: #f0f3f3; --pop: #ffffff;
  --line: #e2e7e7; --line-strong: #d2d9d9;
  --ink: #11181c; --muted: #5b6467; --faint: #8b9599; --on-accent: #04140a;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --bg: #f6f8f8; --panel: #ffffff; --panel-2: #f0f3f3; --pop: #ffffff;
    --line: #e2e7e7; --line-strong: #d2d9d9;
    --ink: #11181c; --muted: #5b6467; --faint: #8b9599;
  }
}

* { box-sizing: border-box; }
::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: var(--fs-base); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: 0.86em; }
:focus-visible { outline: none; box-shadow: var(--ring); border-radius: var(--r-sm); }
.skip { position: absolute; left: -999px; top: 8px; background: var(--pop); color: var(--ink);
  padding: 8px 14px; border-radius: var(--r-md); border: var(--bw) solid var(--line-strong); z-index: var(--z-modal); }
.skip:focus { left: 12px; }

.wrap { max-width: 960px; margin: 0 auto; padding: 0 var(--sp6); }
.wrap-wide { max-width: 1400px; margin: 0 auto; padding: 0 var(--sp6); }

/* ── header / chrome ─────────────────────────────────────────────────────── */
header.top { border-bottom: var(--bw) solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: var(--z-sticky); }
header.top .bar { display: flex; align-items: center; gap: var(--sp4); height: 54px; }
.brand { font-weight: 640; letter-spacing: -0.01em; display: flex; align-items: center; gap: 9px; color: var(--ink); }
.brand:hover { text-decoration: none; }
.brand .seed { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex: none;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent); }
.brand .dom { font-family: var(--mono); font-size: var(--fs-sm); color: var(--muted); font-weight: 500; }
.top .spacer { flex: 1; }
.top nav a { color: var(--muted); font-size: var(--fs-sm); padding: 5px 2px; }
.top nav a:hover, .top nav a.on { color: var(--ink); text-decoration: none; }
.top nav a.on { box-shadow: inset 0 -2px 0 var(--accent); }
.who { color: var(--faint); font-size: var(--fs-xs); font-family: var(--mono); }
.crumbs { display: flex; align-items: center; gap: 7px; height: 34px; font-size: var(--fs-sm);
  color: var(--muted); font-family: var(--mono); overflow-x: auto; scrollbar-width: none; }
.crumbs::-webkit-scrollbar { display: none; }
.crumbs a { color: var(--muted); white-space: nowrap; } .crumbs a:hover { color: var(--ink); }
.crumbs .sep { color: var(--faint); }
.crumbs .cur { color: var(--ink); font-weight: 500; white-space: nowrap; }

/* crew status pill (worst active agent state) */
.crew { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px 4px 9px; white-space: nowrap;
  border: var(--bw) solid var(--line); border-radius: var(--r-full); font-size: var(--fs-xs);
  color: var(--muted); background: var(--panel-2); }
.crew:hover { text-decoration: none; color: var(--ink); border-color: var(--line-strong); }
.crew.working { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 36%, var(--line)); }
.crew.blocked { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }

/* theme toggle */
.tmc { display: inline-flex; border: var(--bw) solid var(--line); border-radius: var(--r-full);
  padding: 2px; background: var(--panel-2); }
.tmc button { background: none; border: 0; padding: 3px 7px; border-radius: var(--r-full); cursor: pointer;
  color: var(--faint); font-size: 12px; line-height: 1; }
.tmc button.on { background: var(--pop); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }

main { padding: 28px 0 88px; }
h1 { font-size: var(--fs-xl); font-weight: 640; letter-spacing: -0.02em; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
h2 { font-size: var(--fs-lg); font-weight: 620; margin: 0 0 10px; letter-spacing: -0.01em; }
.sub { color: var(--muted); margin: 0 0 24px; font-size: var(--fs-sm); }
.label { text-transform: uppercase; letter-spacing: 0.08em; font-size: var(--fs-xs); color: var(--faint); font-weight: 600; }
.mut { color: var(--muted); } .faint { color: var(--faint); } .big { font-size: var(--fs-lg); }
.err { color: var(--red); font-size: var(--fs-sm); margin: 0 0 12px; }

/* ── utilities (kill inline-style sprawl) ────────────────────────────────── */
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.grow { flex: 1; min-width: 0; } .nowrap { white-space: nowrap; } .prewrap { white-space: pre-wrap; }
.stack { display: flex; flex-direction: column; gap: var(--sp3); }
.mt { margin-top: 22px; } .mb { margin-bottom: 10px; } .mt-s { margin-top: 10px; } .m0 { margin: 0; }
.hide { display: none; }

/* ── cards ───────────────────────────────────────────────────────────────── */
.card { background: var(--panel); border: var(--bw) solid var(--line); border-radius: var(--r-lg); }
.card.pad { padding: 18px 20px; }
.card.warn { border-color: color-mix(in srgb, var(--amber) 45%, var(--line)); }
.card.danger { border-color: color-mix(in srgb, var(--red) 45%, var(--line)); }
.idcard { display: grid; grid-template-columns: auto 1fr; gap: 7px 20px; padding: 16px 20px; margin-bottom: 26px; align-items: baseline; }
.idcard .k { color: var(--faint); font-size: var(--fs-sm); }
.idcard .v { font-family: var(--mono); font-size: 12.5px; word-break: break-all; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.app { display: block; padding: 16px 18px; transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease-out); }
.app:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); text-decoration: none; transform: translateY(-1px); }
.app .name { font-weight: 620; color: var(--ink); display: flex; align-items: center; gap: 9px; }
.app .host { font-family: var(--mono); font-size: var(--fs-sm); color: var(--muted); margin-top: 7px; word-break: break-all; }
.app .foot { margin-top: 12px; display: flex; align-items: center; gap: 8px; color: var(--faint); font-size: var(--fs-sm); }

/* ── status dot ──────────────────────────────────────────────────────────── */
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: var(--faint); vertical-align: middle; position: relative; top: -1px; }
.dot.running { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.dot.building, .dot.pending, .dot.queued, .dot.cloning, .dot.starting, .dot.built {
  background: var(--amber); animation: pulse 1.1s ease-in-out infinite; }
.dot.error, .dot.failed { background: var(--red); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.state { text-transform: capitalize; }

/* ── buttons ─────────────────────────────────────────────────────────────── */
button, .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  background: var(--accent-dim); color: var(--on-accent); border: var(--bw) solid transparent;
  border-radius: var(--r-md); padding: 0 15px; height: 36px; font-size: var(--fs-sm); font-weight: 600;
  cursor: pointer; font-family: var(--sans); white-space: nowrap;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease); }
button:hover, .btn:hover { background: var(--accent); text-decoration: none; }
button:disabled, .btn:disabled, .btn.is-loading { opacity: .55; pointer-events: none; }
.btn.secondary { background: var(--panel-2); color: var(--ink); border-color: var(--line); }
.btn.secondary:hover { background: var(--pop); border-color: var(--line-strong); }
.btn.outline { background: transparent; color: var(--ink); border-color: var(--line-strong); }
.btn.outline:hover { background: var(--panel-2); }
button.ghost, .btn.ghost { background: transparent; color: var(--muted); border-color: var(--line); }
button.ghost:hover, .btn.ghost:hover { color: var(--ink); border-color: var(--line-strong); background: transparent; }
.btn.danger { background: transparent; color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }
.btn.danger:hover { background: color-mix(in srgb, var(--red) 12%, transparent); }
.btn.sm { height: 30px; padding: 0 11px; font-size: var(--fs-xs); }
.btn.icon { height: 30px; width: 30px; padding: 0; }
.btn.is-loading::before { content: ""; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent; animation: spin .6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── forms ───────────────────────────────────────────────────────────────── */
form.newapp { display: flex; gap: 8px; margin: 0 0 22px; flex-wrap: wrap; }
input[type=text], input[type=password], input[type=url], input:not([type]), textarea {
  background: var(--panel-2); border: var(--bw) solid var(--line); color: var(--ink);
  border-radius: var(--r-md); padding: 9px 12px; font-size: var(--fs-base); font-family: var(--sans); outline: none;
  transition: border-color var(--dur-fast) var(--ease); width: 100%; }
textarea { resize: vertical; min-height: 76px; line-height: 1.5; }
input:focus-visible, textarea:focus-visible { border-color: var(--accent); box-shadow: var(--ring); }
input.mono { font-family: var(--mono); }
.field.err input, .field.err textarea { border-color: var(--red); }
label.check { font-size: var(--fs-sm); color: var(--muted); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; cursor: pointer; }

/* ── pills / chips / badges ──────────────────────────────────────────────── */
.pill, .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; padding: 2px 8px;
  border-radius: var(--r-full); background: var(--panel-2); border: var(--bw) solid var(--line);
  color: var(--muted); font-family: var(--mono); line-height: 1.5; white-space: nowrap; }
.chip.agent, .pill.agent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.pill.open { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.pill.merged { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 40%, var(--line)); }
.pill.closed { color: var(--faint); }
.pill.building, .pill.reviewing { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, var(--line)); }
.pill.ok { color: var(--accent); } .pill.fail { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }
.chip.rm { cursor: pointer; } .chip.rm:hover { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }

/* ── tabs (segmented) ────────────────────────────────────────────────────── */
.tabs { display: inline-flex; gap: 2px; background: var(--panel-2); border-radius: var(--r-lg); padding: 3px;
  border: var(--bw) solid var(--line); }
.tab { background: none; border: 0; height: 30px; padding: 0 14px; border-radius: var(--r-md); color: var(--muted);
  font-size: var(--fs-sm); font-weight: 500; cursor: pointer; }
.tab:hover { color: var(--ink); background: transparent; }
.tab.on { background: var(--panel); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.tabpane { display: none; } .tabpane.on { display: block; }
.tabs.sm { padding: 2px; }
.tabs.sm .tab { height: 26px; padding: 0 10px; font-size: var(--fs-xs); }
select { background: var(--panel-2); border: var(--bw) solid var(--line); color: var(--ink); border-radius: var(--r-md);
  padding: 0 10px; height: 34px; font-size: var(--fs-sm); font-family: var(--sans); cursor: pointer; outline: none; }
select:focus-visible { border-color: var(--accent); box-shadow: var(--ring); }
.filterbar { gap: 8px; flex-wrap: nowrap; }
@media (max-width: 600px) { .filterbar { flex-wrap: wrap; } .filterbar #fq { order: -1; width: 100%; } }

/* ── list rows (issues, PRs) ─────────────────────────────────────────────── */
.rows { display: flex; flex-direction: column; }
.list-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: var(--r-md); color: inherit;
  border-bottom: var(--bw) solid color-mix(in srgb, var(--line) 60%, transparent); }
.list-row:last-child { border-bottom: 0; }
.list-row:hover { background: var(--panel-2); text-decoration: none; }
.list-row .num { font-family: var(--mono); font-size: var(--fs-sm); color: var(--faint); }
.list-row .ttl { font-size: 13.5px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-row .meta { display: flex; align-items: center; gap: 6px; }

/* ── deploy timeline ─────────────────────────────────────────────────────── */
.tl { display: flex; flex-direction: column; }
.tl-ev { display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 9px;
  padding: 7px 0; border-bottom: var(--bw) solid color-mix(in srgb, var(--line) 55%, transparent); }
.tl-ev:last-child { border-bottom: 0; }
.tl-ev .ph { font-size: 13px; font-weight: 560; text-transform: capitalize; }
.tl-ev .msg { font-size: var(--fs-sm); color: var(--muted); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-ev .t { font-size: var(--fs-xs); color: var(--faint); font-variant-numeric: tabular-nums; }

/* ── logs ────────────────────────────────────────────────────────────────── */
pre.logs { background: color-mix(in srgb, var(--bg) 60%, transparent); border: var(--bw) solid var(--line);
  border-radius: var(--r-md); margin: 0; padding: 13px 15px; font-family: var(--mono); font-size: 12px; line-height: 1.5;
  color: var(--muted); max-height: 380px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.diff-add { color: var(--accent); } .diff-del { color: var(--red); } .diff-hd { color: var(--blue); }

/* ── skeleton ────────────────────────────────────────────────────────────── */
.sk { background: var(--panel-2); border-radius: var(--r-sm); animation: pulse 1.6s ease-in-out infinite; height: 12px; }
.sk.line { height: 12px; margin: 8px 0; } .sk.w60 { width: 60%; } .sk.w40 { width: 40%; } .sk.w80 { width: 80%; }

/* ── tooltip (CSS-only) ──────────────────────────────────────────────────── */
[data-tip] { position: relative; }
[data-tip]:hover::after { content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  background: var(--ink); color: var(--bg); font-size: var(--fs-xs); padding: 4px 8px; border-radius: var(--r-sm);
  white-space: nowrap; z-index: var(--z-pop); pointer-events: none; opacity: 0; animation: tipin var(--dur) var(--ease-out) forwards; }
@keyframes tipin { to { opacity: 1; } }

/* ── pipeline stepper ────────────────────────────────────────────────────── */
.pipeline { display: flex; gap: 0; list-style: none; padding: 0; margin: 0 0 24px; }
.pipeline .step { flex: 1; display: flex; align-items: center; gap: 7px; font-size: var(--fs-sm); color: var(--faint); }
.pipeline .step .dot { position: static; }
.pipeline .step::after { content: ""; flex: 1; height: 2px; margin: 0 8px; border-radius: 2px;
  background: linear-gradient(90deg, var(--accent) 50%, var(--line) 50%); background-size: 200% 100%;
  background-position: 100% 0; transition: background-position var(--dur-slow) var(--ease-out); }
.pipeline .step:last-child::after { display: none; }
.pipeline .step.done { color: var(--ink); } .pipeline .step.done::after { background-position: 0 0; }
.pipeline .step.active { color: var(--ink); font-weight: 560; }
.pipeline .step.failed { color: var(--red); }

/* ── crew activity feed (the flagship) ───────────────────────────────────── */
.feed { display: flex; flex-direction: column; gap: 2px; }
.feed-block { animation: feedin var(--dur) var(--ease-out); }
@keyframes feedin { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.feed-phase { display: flex; align-items: center; gap: 8px; margin: 16px 0 8px; font-size: var(--fs-sm);
  font-weight: 560; color: var(--ink); }
.feed-phase .who { color: var(--muted); font-weight: 400; }
.feed-phase::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.feed-body { font-size: 13.5px; color: var(--muted); padding: 3px 0; }
.feed-body.prose { color: var(--ink); }
.feed-t { font-size: var(--fs-xs); color: var(--faint); font-variant-numeric: tabular-nums; }
.tool { border: var(--bw) solid var(--line); border-radius: var(--r-md); margin: 4px 0; background: var(--panel); overflow: hidden; }
.tool > summary { display: flex; align-items: center; gap: 8px; padding: 7px 11px; cursor: pointer; font-size: var(--fs-sm); list-style: none; }
.tool > summary::-webkit-details-marker { display: none; }
.tool > summary code { background: var(--panel-2); padding: 1px 6px; border-radius: var(--r-sm); color: var(--ink); }
.tool > summary .grow { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool[open] > summary { border-bottom: var(--bw) solid var(--line); }
.tool.err { border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }
.tool pre.logs { border: 0; border-radius: 0; max-height: 240px; }
.feed-verdict { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin: 12px 0; padding: 12px 15px;
  border: var(--bw) solid var(--line); border-left: 3px solid var(--faint); border-radius: var(--r-md);
  background: var(--panel); font-size: 13.5px; }
.feed-verdict .v-icon { font-size: 15px; }
.feed-verdict.pass { border-left-color: var(--accent); }
.feed-verdict.warn { border-left-color: var(--amber); }
.feed-verdict.fail { border-left-color: var(--red); }
.feed-human { margin: 8px 0; padding: 11px 14px; }
.feed-human b { color: var(--ink); font-size: var(--fs-sm); }
.prose code { background: var(--panel-2); padding: 1px 5px; border-radius: var(--r-sm); }
.prose pre.logs { margin: 6px 0; }
.newpill { display: inline-flex; align-items: center; gap: 5px; position: sticky; bottom: 8px; align-self: center;
  padding: 4px 12px; background: var(--pop); border: var(--bw) solid var(--line-strong); border-radius: var(--r-full);
  font-size: var(--fs-xs); cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.25); }

/* ── misc ────────────────────────────────────────────────────────────────── */
.cols { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 28px; align-items: start; }
.copy { cursor: pointer; } .copy:hover { color: var(--ink); }
.toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%) translateY(8px);
  background: var(--pop); border: var(--bw) solid var(--line-strong); border-radius: var(--r-md);
  padding: 10px 16px; font-size: var(--fs-sm); opacity: 0; transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease-out);
  pointer-events: none; z-index: var(--z-toast); box-shadow: 0 6px 20px rgba(0,0,0,.28); }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.tree { font-family: var(--mono); font-size: 13px; line-height: 1.9; }
.tree .gen { color: var(--muted); } .tree .arrow { color: var(--faint); }
.empty { color: var(--faint); text-align: center; padding: 46px 20px; border: 1px dashed var(--line-strong); border-radius: var(--r-lg); }

/* login */
.login { max-width: 360px; margin: 12vh auto 0; }
.login .card { padding: 26px; }
.login h1 { margin-bottom: 18px; }
.login form { display: flex; flex-direction: column; gap: 11px; }
.login button { height: 40px; }

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
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
