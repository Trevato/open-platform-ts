// One stylesheet, inlined — no external fonts, no CDN, nothing to fetch. The
// page renders identically offline and inside a locked-down CSP. Dark-first,
// with a light adaptation; a single growth-green accent, used sparingly.
export const STYLE = `
:root {
  --bg: #0b0d0e; --panel: #14181a; --panel-2: #191e21; --line: #232a2d;
  --ink: #e6edef; --muted: #8b9599; --faint: #5b6467;
  --accent: #3fb950; --accent-dim: #2ea043; --amber: #d29922; --red: #f85149;
  --radius: 10px; --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f8f8; --panel: #ffffff; --panel-2: #f0f3f3; --line: #e2e7e7;
    --ink: #11181c; --muted: #5b6467; --faint: #8b9599;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: 14px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: 0.86em; }
.wrap { max-width: 960px; margin: 0 auto; padding: 0 24px; }

header.top {
  border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 10;
}
header.top .wrap { display: flex; align-items: center; gap: 16px; height: 56px; }
.brand { font-weight: 650; letter-spacing: -0.01em; display: flex; align-items: center; gap: 9px; }
.brand .seed { width: 9px; height: 9px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent); }
.brand .dom { font-family: var(--mono); font-size: 13px; color: var(--muted); font-weight: 500; }
.top .spacer { flex: 1; }
.top nav a { color: var(--muted); margin-left: 18px; font-size: 13px; }
.top nav a:hover, .top nav a.on { color: var(--ink); text-decoration: none; }
.who { color: var(--faint); font-size: 12px; font-family: var(--mono); }

main { padding: 32px 0 80px; }
h1 { font-size: 20px; font-weight: 640; letter-spacing: -0.02em; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; font-size: 13px; }
.label { text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; color: var(--faint); font-weight: 600; }

.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.card.pad { padding: 18px 20px; }

.idcard { display: grid; grid-template-columns: auto 1fr; gap: 6px 20px; padding: 18px 20px; margin-bottom: 28px; }
.idcard .k { color: var(--faint); font-size: 12px; }
.idcard .v { font-family: var(--mono); font-size: 12.5px; word-break: break-all; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.app { display: block; padding: 16px 18px; transition: border-color .12s, transform .12s; }
.app:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); text-decoration: none; transform: translateY(-1px); }
.app .name { font-weight: 620; color: var(--ink); display: flex; align-items: center; gap: 9px; }
.app .host { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-top: 7px; word-break: break-all; }
.app .foot { margin-top: 12px; display: flex; align-items: center; gap: 8px; color: var(--faint); font-size: 12px; }

.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: var(--faint); vertical-align: middle; position: relative; top: -1px; }
.dot.running { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.dot.building, .dot.pending { background: var(--amber); animation: pulse 1.1s ease-in-out infinite; }
.dot.error { background: var(--red); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.state { text-transform: capitalize; }

form.newapp { display: flex; gap: 8px; margin: 0 0 22px; }
input[type=text], input[type=password] {
  background: var(--panel-2); border: 1px solid var(--line); color: var(--ink);
  border-radius: 8px; padding: 9px 12px; font-size: 14px; font-family: var(--sans); outline: none;
}
input:focus { border-color: var(--accent); }
input.mono { font-family: var(--mono); }
button, .btn {
  background: var(--accent-dim); color: #04140a; border: 0; border-radius: 8px;
  padding: 9px 15px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: var(--sans);
}
button:hover, .btn:hover { background: var(--accent); text-decoration: none; }
button.ghost, .btn.ghost { background: transparent; color: var(--muted); border: 1px solid var(--line); }
button.ghost:hover { color: var(--ink); border-color: var(--muted); background: transparent; }

.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.copy { cursor: pointer; }
pre.logs {
  background: #05070800; border: 1px solid var(--line); border-radius: 8px; margin: 0;
  padding: 14px 16px; font-family: var(--mono); font-size: 12px; line-height: 1.5;
  color: var(--muted); max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
.mut { color: var(--muted); }
.big { font-size: 15px; }
.mt { margin-top: 22px; } .mb { margin-bottom: 10px; }
.toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 16px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.show { opacity: 1; }

/* login */
.login { max-width: 360px; margin: 12vh auto 0; }
.login .card { padding: 26px 26px 24px; }
.login h1 { margin-bottom: 18px; }
.login form { display: flex; flex-direction: column; gap: 11px; }
.login button { padding: 10px; }
.err { color: var(--red); font-size: 13px; margin: 0 0 12px; }

.tree { font-family: var(--mono); font-size: 13px; line-height: 1.9; }
.tree .gen { color: var(--muted); }
.tree .arrow { color: var(--faint); }
.empty { color: var(--faint); text-align: center; padding: 48px 0; border: 1px dashed var(--line); border-radius: var(--radius); }
`;
