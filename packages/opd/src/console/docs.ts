// The manual, served by the platform that it documents. Pages are markdown in
// plat/platform's docs/ tree (seeded from genesis/platform/docs, hot-editable
// like crew prompts, inherited by daughters), rendered through md.ts into the
// console chrome. Reads are git-first with a disk fallback (the PlatformConfig
// convention): a platform whose config repo predates the docs still serves
// them from its own source checkout.
//
// Docs are public-read — product docs carry no secrets, and a shareable link
// must not bounce through a login page. Everything here is derived, cached on
// the config repo's main sha, and re-read only when that moves.
//
// The docs are also machine-readable, for agents (including our own guide):
//   /docs/<slug>.md   → the raw markdown of a page
//   /docs/llms.txt    → an index of every page (title + description + URL)
//   /docs/search.json → the client search index (⌘K palette)

import { join } from "node:path";
import type { GitHost } from "@op/git";
import type { Store } from "@op/store";
import { OPD, PLAT } from "../platform-config.ts";
import { type Chrome, esc, page } from "./layout.ts";
import {
  CODE_REF_RE,
  parseFrontmatter,
  renderMd,
  type DocHeading,
} from "./md.ts";

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  section: string;
  html: string;
  headings: DocHeading[];
  plain: string;
  /** The raw markdown body (frontmatter stripped) — served at /docs/<slug>.md. */
  raw: string;
}

export interface DocsTree {
  sections: Array<{ title: string; pages: DocPage[] }>;
  bySlug: Map<string, DocPage>;
  /** Flattened manifest order — drives prev/next. */
  order: DocPage[];
}

interface Manifest {
  sections: Array<{ title: string; pages: string[] }>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `path:12` / `path:12-40` → the blob viewer on the platform's own hosted
 *  source. Line links anchor at the range start. */
export function codeRefHref(ref: string): string {
  const m = ref.match(/^(.*?)(?::(\d+)(?:-\d+)?)?$/)!;
  return `/apps/${OPD.owner}/${OPD.name}/blob/main/${m[1]}${m[2] ? `#L${m[2]}` : ""}`;
}

export class DocsSource {
  private cache: { key: string; tree: DocsTree } | null = null;

  constructor(
    private readonly git: GitHost,
    private readonly store: Store,
    /** genesis/ on disk — the fallback when plat/platform has no docs. */
    private readonly genesisDir: string,
  ) {}

  async tree(): Promise<DocsTree> {
    const sha = await this.git.headSha(PLAT.owner, PLAT.name, "main");
    // Code refs only link when the source repo exists to link INTO.
    const linkSource = this.store.getRepo(OPD.owner, OPD.name) !== null;
    const key = `${sha.status === "ok" ? sha.value : "disk"}:${linkSource}`;
    if (this.cache?.key === key) return this.cache.tree;
    const tree =
      (sha.status === "ok" ? await this.fromGit(linkSource) : null) ??
      (await this.fromDisk(linkSource));
    this.cache = { key, tree };
    return tree;
  }

  private async fromGit(linkSource: boolean): Promise<DocsTree | null> {
    const read = async (path: string) => {
      const r = await this.git.readFile(PLAT.owner, PLAT.name, "main", path);
      return r.status === "ok" ? new TextDecoder().decode(r.value) : null;
    };
    return buildTree(read, linkSource);
  }

  private async fromDisk(linkSource: boolean): Promise<DocsTree> {
    const read = async (path: string) => {
      const f = Bun.file(join(this.genesisDir, "platform", path));
      return (await f.exists()) ? f.text() : null;
    };
    return (
      (await buildTree(read, linkSource)) ?? {
        sections: [],
        bySlug: new Map(),
        order: [],
      }
    );
  }
}

async function buildTree(
  read: (path: string) => Promise<string | null>,
  linkSource: boolean,
): Promise<DocsTree | null> {
  const rawManifest = await read("docs/docs.json");
  if (!rawManifest) return null;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(rawManifest) as Manifest;
  } catch {
    return null;
  }
  if (!Array.isArray(manifest.sections)) return null;

  const mdOpts = {
    codeLink: (code: string) =>
      linkSource && CODE_REF_RE.test(code) ? codeRefHref(code) : null,
  };

  const sections: DocsTree["sections"] = [];
  const bySlug = new Map<string, DocPage>();
  const order: DocPage[] = [];
  for (const s of manifest.sections) {
    const pages: DocPage[] = [];
    for (const slug of s.pages ?? []) {
      if (!SLUG_RE.test(slug)) continue;
      const src = await read(`docs/${slug}.md`);
      if (src === null) continue;
      const { meta, body } = parseFrontmatter(src);
      const rendered = renderMd(body, mdOpts);
      const docPage: DocPage = {
        slug,
        title: meta["title"] ?? slug,
        description: meta["description"] ?? "",
        section: s.title,
        html: rendered.html,
        headings: rendered.headings,
        plain: rendered.plain.slice(0, 2400),
        raw: body,
      };
      pages.push(docPage);
      bySlug.set(slug, docPage);
      order.push(docPage);
    }
    if (pages.length) sections.push({ title: s.title, pages });
  }
  return bySlug.size ? { sections, bySlug, order } : null;
}

// ── routes ─────────────────────────────────────────────────────────────────

export interface DocsDeps {
  docs: DocsSource;
  domain: string;
  /** The signed-in username, or null — docs render for both. */
  user: string | null;
  /** Show the Ask affordance (signed in + credentialed guide). */
  guide: boolean;
}

/** Handles /docs* paths; null lets the console router continue. */
export async function docsRoute(
  req: Request,
  path: string,
  deps: DocsDeps,
): Promise<Response | null> {
  if (path !== "/docs" && !path.startsWith("/docs/")) return null;
  if (req.method !== "GET") return null;
  const tree = await deps.docs.tree();

  if (path === "/docs/search.json") {
    return Response.json({
      pages: tree.order.map((p) => ({
        slug: p.slug,
        title: p.title,
        description: p.description,
        section: p.section,
        headings: p.headings,
        plain: p.plain,
      })),
    });
  }

  if (path === "/docs/llms.txt") {
    const lines = [
      `# ${deps.domain} — platform docs`,
      "",
      ...tree.order.map(
        (p) =>
          `- [${p.title}](/docs/${p.slug}.md): ${p.description || p.section}`,
      ),
    ];
    return new Response(lines.join("\n") + "\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const mdMatch = path.match(/^\/docs\/([a-z0-9-]+)\.md$/);
  if (mdMatch) {
    const docPage = tree.bySlug.get(mdMatch[1]!);
    if (!docPage) return new Response("not found", { status: 404 });
    return new Response(
      `# ${docPage.title}\n\n${docPage.description ? docPage.description + "\n\n" : ""}${docPage.raw}`,
      { headers: { "content-type": "text/markdown; charset=utf-8" } },
    );
  }

  const slug = path === "/docs" ? "index" : path.slice("/docs/".length);
  if (!SLUG_RE.test(slug)) return new Response("not found", { status: 404 });
  const docPage = tree.bySlug.get(slug) ?? null;
  const chrome: Chrome = {
    domain: deps.domain,
    user: deps.user,
    active: "docs",
    guide: deps.guide,
    crumbs: docPage
      ? [
          { label: "Docs", href: "/docs" },
          ...(docPage.slug === "index"
            ? []
            : [{ label: docPage.section }, { label: docPage.title }]),
        ]
      : [{ label: "Docs", href: "/docs" }],
  };
  if (!docPage && tree.order.length === 0) {
    return page(
      "Docs",
      chrome,
      `<div class="empty"><div class="empty-title">No docs installed</div><div class="empty-desc">This platform's config repo (<code>plat/platform</code>) has no <code>docs/</code> tree and the genesis fallback is missing.</div></div>`,
    );
  }
  if (!docPage)
    return page(
      "Not found",
      chrome,
      `<div class="empty"><div class="empty-title">No such page</div><div class="empty-desc"><a href="/docs">← all docs</a></div></div>`,
      "",
      { wide: true },
    );

  return page(
    docPage.slug === "index" ? "Docs" : `${docPage.title} · Docs`,
    chrome,
    docsBody(tree, docPage),
    DOCS_JS,
    { wide: true },
  );
}

function docsBody(tree: DocsTree, current: DocPage): string {
  const nav = tree.sections
    .map(
      (s) => `<div class="dnav-group">
  <div class="dnav-label">${esc(s.title)}</div>
  ${s.pages
    .map(
      (p) =>
        `<a href="/docs/${esc(p.slug)}"${p.slug === current.slug ? ' aria-current="page"' : ""}>${esc(p.title)}</a>`,
    )
    .join("")}
</div>`,
    )
    .join("");

  const toc = current.headings.length
    ? `<div class="dtoc-label">On this page</div>
<div class="dtoc-list">${current.headings
        .map(
          (h) =>
            `<a href="#${esc(h.id)}" data-depth="${h.depth}">${esc(h.text)}</a>`,
        )
        .join("")}</div>`
    : "";

  const idx = tree.order.findIndex((p) => p.slug === current.slug);
  const prev = idx > 0 ? tree.order[idx - 1]! : null;
  const next =
    idx >= 0 && idx < tree.order.length - 1 ? tree.order[idx + 1]! : null;
  const pn =
    prev || next
      ? `<nav class="docs-pn">
  ${prev ? `<a class="pn prev" href="/docs/${esc(prev.slug)}"><span class="pn-k">← Previous</span><span class="pn-t">${esc(prev.title)}</span></a>` : "<span></span>"}
  ${next ? `<a class="pn next" href="/docs/${esc(next.slug)}"><span class="pn-k">Next →</span><span class="pn-t">${esc(next.title)}</span></a>` : "<span></span>"}
</nav>`
      : "";

  // The search palette is chrome, present on every docs page; its index loads
  // lazily on first open (or on hover of the trigger — the preload trick).
  const palette = `<div class="dsearch-veil" id="dsv" hidden><div class="dsearch" role="dialog" aria-label="Search docs">
  <input type="text" id="dsq" placeholder="Search docs…" autocomplete="off" spellcheck="false">
  <div class="dsearch-hits" id="dsh" role="listbox"></div>
  <div class="dsearch-foot"><span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
</div></div>`;

  return `<div class="docs">
<aside class="docs-nav" id="docsnav" aria-label="Docs">
  <button class="dsearch-btn" id="dsb" type="button"><span>Search docs…</span><kbd>⌘K</kbd></button>
  <nav class="dnav">${nav}</nav>
</aside>
<div class="docs-mobilebar">
  <button class="btn secondary sm" id="dnavtoggle" type="button" aria-expanded="false">Menu</button>
  <span class="mut" style="font-size:12px">${esc(current.section)}${current.slug === "index" ? "" : " › " + esc(current.title)}</span>
  <button class="btn ghost sm" id="dsbm" type="button" aria-label="Search docs">⌘K</button>
</div>
<article class="docs-page typeset" id="main-doc">
  <header class="docs-head">
    <h1>${esc(current.title)}</h1>
    ${current.description ? `<p class="docs-desc">${esc(current.description)}</p>` : ""}
    <div class="docs-actions">
      <button class="btn ghost sm" id="dcopy" data-tip="Copy page as Markdown" type="button">Copy page</button>
      <a class="btn ghost sm" href="/docs/${esc(current.slug)}.md" data-tip="Raw markdown">.md</a>
    </div>
  </header>
  ${current.html}
  ${pn}
</article>
<aside class="docs-toc" aria-label="On this page">${toc}</aside>
${palette}
</div>`;
}

// One block of vanilla JS per docs page: copy buttons, scroll-spy, drawer,
// and the ⌘K palette (index fetched once, cached on the window).
const DOCS_JS = `
// code-block copy (delegated; the button precedes its <pre>)
document.addEventListener('click',function(e){
  var b=e.target.closest&&e.target.closest('.cb-copy');if(!b)return;
  var pre=b.parentElement.querySelector('pre');if(!pre)return;
  navigator.clipboard.writeText(pre.textContent).then(function(){
    b.textContent='✓';b.classList.add('ok');setTimeout(function(){b.textContent='⧉';b.classList.remove('ok')},1600);});
});
// copy page as markdown
(function(){var b=document.getElementById('dcopy');if(!b)return;
  b.addEventListener('click',function(){
    fetch(location.pathname.replace(/\\/$/,'')+'.md').then(function(r){return r.text()}).then(function(t){
      navigator.clipboard.writeText(t).then(function(){toast('page copied as markdown')});});});})();
// scroll-spy: the heading nearest above the reading line drives the TOC
(function(){
  var links=[].slice.call(document.querySelectorAll('.dtoc-list a'));if(!links.length)return;
  var hs=links.map(function(a){return document.getElementById(a.getAttribute('href').slice(1))}).filter(Boolean);
  function spy(){
    var y=120,cur=hs[0];
    for(var i=0;i<hs.length;i++){if(hs[i].getBoundingClientRect().top<=y)cur=hs[i];}
    links.forEach(function(a){a.classList.toggle('on',cur&&a.getAttribute('href')==='#'+cur.id)});
  }
  addEventListener('scroll',spy,{passive:true});spy();
})();
// mobile drawer
(function(){
  var t=document.getElementById('dnavtoggle'),nav=document.getElementById('docsnav');if(!t||!nav)return;
  t.addEventListener('click',function(){
    var open=nav.classList.toggle('open');t.setAttribute('aria-expanded',open);t.textContent=open?'Close':'Menu';});
})();
// center the active nav item
(function(){var nav=document.querySelector('.dnav');var a=nav&&nav.querySelector('[aria-current]');
  if(a&&nav.scrollHeight>nav.clientHeight)nav.scrollTop=a.offsetTop-nav.clientHeight/2;})();
// ⌘K palette
(function(){
  var veil=document.getElementById('dsv'),input=document.getElementById('dsq'),hits=document.getElementById('dsh');
  if(!veil)return;
  var idx=null,sel=0,rows=[];
  function load(){if(idx||window._didx){idx=idx||window._didx;return Promise.resolve(idx);}
    return fetch('/docs/search.json').then(function(r){return r.json()}).then(function(j){idx=window._didx=j.pages;return idx});}
  function open(){veil.hidden=false;input.value='';render('');input.focus();}
  function close(){veil.hidden=true;}
  function score(p,q){
    var t=p.title.toLowerCase(),d=(p.description||'').toLowerCase(),body=(p.plain||'').toLowerCase();
    if(t.indexOf(q)>=0)return 3;
    if(d.indexOf(q)>=0)return 2;
    for(var i=0;i<p.headings.length;i++)if(p.headings[i].text.toLowerCase().indexOf(q)>=0)return 2;
    if(body.indexOf(q)>=0)return 1;
    return 0;
  }
  function mark(text,q){
    var i=text.toLowerCase().indexOf(q);if(i<0||!q)return escHtml(text);
    return escHtml(text.slice(0,i))+'<mark>'+escHtml(text.slice(i,i+q.length))+'</mark>'+escHtml(text.slice(i+q.length));
  }
  function render(q){
    q=q.toLowerCase().trim();
    var list=(idx||[]).map(function(p){return {p:p,s:score(p,q)}}).filter(function(x){return q?x.s>0:true});
    list.sort(function(a,b){return b.s-a.s});list=list.slice(0,9);
    sel=0;rows=list.map(function(x){return x.p});
    hits.innerHTML=list.length?list.map(function(x,i){
      var h=x.p.headings.filter(function(h){return q&&h.text.toLowerCase().indexOf(q)>=0})[0];
      return '<a class="hit'+(i===0?' on':'')+'" href="/docs/'+x.p.slug+(h?'#'+h.id:'')+'">'+
        '<span class="hit-t">'+mark(x.p.title,q)+(h?' <span class="hit-h">› '+mark(h.text,q)+'</span>':'')+'</span>'+
        '<span class="hit-s">'+escHtml(x.p.section)+'</span></a>';
    }).join(''):'<div class="hit-none">No matches. The guide might know — ask it.</div>';
  }
  function move(d){
    var els=hits.querySelectorAll('.hit');if(!els.length)return;
    sel=(sel+d+els.length)%els.length;
    [].forEach.call(els,function(el,i){el.classList.toggle('on',i===sel)});
    els[sel].scrollIntoView({block:'nearest'});
  }
  var trigger=function(e){e.preventDefault();load().then(open);};
  var b=document.getElementById('dsb');if(b){b.addEventListener('click',trigger);b.addEventListener('mouseenter',function(){load()});}
  var bm=document.getElementById('dsbm');if(bm)bm.addEventListener('click',trigger);
  document.addEventListener('keydown',function(e){
    if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();veil.hidden?load().then(open):close();return;}
    if(veil.hidden)return;
    if(e.key==='Escape')close();
    else if(e.key==='ArrowDown'){e.preventDefault();move(1)}
    else if(e.key==='ArrowUp'){e.preventDefault();move(-1)}
    else if(e.key==='Enter'){var on=hits.querySelector('.hit.on');if(on){location.href=on.getAttribute('href')}}
  });
  input.addEventListener('input',function(){render(input.value)});
  veil.addEventListener('mousedown',function(e){if(e.target===veil)close();});
})();
`;
