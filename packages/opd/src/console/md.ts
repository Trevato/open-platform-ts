// The docs renderer: markdown → HTML, dependency-free, XSS-safe by
// construction (every byte of source text passes through esc() before any
// markup is wrapped around it — there is no raw-HTML passthrough, so a doc
// page can never smuggle script past the console's CSP).
//
// Deliberately small: the grammar is the subset our docs actually use —
// headings, paragraphs, fenced code (with a lean highlighter), lists, tables,
// blockquotes + GitHub-style callouts, hr, links, emphasis, inline code.
// Two seams make it the PLATFORM's renderer rather than a generic one:
//   codeLink — inline code that names a repo path becomes a link into the
//              platform's own hosted source (the docs↔code contract);
//   linkHref — md link targets are rewritten (doc-slug links, safety).

import { esc } from "./layout.ts";

export interface DocHeading {
  depth: 2 | 3;
  text: string;
  id: string;
}

export interface RenderedDoc {
  html: string;
  headings: DocHeading[];
  /** Prose only (no code blocks) — feeds the client search index. */
  plain: string;
}

export interface MdOptions {
  /** Inline code → href (or null for plain code). The repo-path auto-link. */
  codeLink?: (code: string) => string | null;
  /** Rewrite/veto md link hrefs; null renders the text without a link. */
  linkHref?: (href: string) => string | null;
}

/** Frontmatter: a leading `---` block of `key: value` lines. Anything else
 *  (including a missing block) yields empty meta and the untouched source. */
export function parseFrontmatter(src: string): {
  meta: Record<string, string>;
  body: string;
} {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: src.slice(m[0].length) };
}

/** The grammar of a code reference: a repo-rooted file path, optionally
 *  `:line` or `:line-line`. Shared by the renderer (auto-linking) and the
 *  docs checker test (CI truth enforcement) — one definition, two duties. */
export const CODE_REF_RE =
  /^(packages|genesis|test|docs)\/(?!.*\.\.)[A-Za-z0-9._/-]+\.[A-Za-z0-9]+(:\d+(-\d+)?)?$/;

// ── inline ─────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/`/g, "")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/[\s-]+/g, "-") || "section"
  );
}

// Emphasis/links run on ESCAPED text, so their replacements can only ever
// wrap entity-safe content. Code spans are carved out of the RAW text first
// (a span may contain <, &, backtick-adjacent markup must not see inside it).
function inline(raw: string, opts: MdOptions): string {
  const parts: string[] = [];
  let rest = raw;
  for (;;) {
    const m = rest.match(/`([^`]+)`/);
    if (!m || m.index === undefined) {
      parts.push(inlineText(rest, opts));
      break;
    }
    parts.push(inlineText(rest.slice(0, m.index), opts));
    const code = m[1]!;
    const href = opts.codeLink?.(code) ?? null;
    parts.push(
      href
        ? `<a class="code-ref" href="${esc(href)}"><code>${esc(code)}</code></a>`
        : `<code>${esc(code)}</code>`,
    );
    rest = rest.slice(m.index + m[0].length);
  }
  return parts.join("");
}

function inlineText(raw: string, opts: MdOptions): string {
  let s = esc(raw);
  // links: [text](href) — href is vetted through linkHref (defaults to
  // same-page/absolute-path/https only; javascript: can never survive).
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, text: string, href: string) => {
      const raw = href.replace(/&amp;/g, "&");
      const mapped = opts.linkHref ? opts.linkHref(raw) : defaultLinkHref(raw);
      if (!mapped) return text;
      const ext = /^https?:\/\//.test(mapped)
        ? ' target="_blank" rel="noopener"'
        : "";
      return `<a href="${esc(mapped)}"${ext}>${text}</a>`;
    },
  );
  // Both emphasis spellings — the repo formatter normalizes *em* to _em_,
  // so the renderer must read what the formatter writes.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
  return s;
}

function defaultLinkHref(href: string): string | null {
  if (/^https?:\/\//.test(href)) return href;
  // Same-page anchors and SAME-ORIGIN absolute paths only. `//host` and the
  // browser-normalized `/\host` are protocol-relative off-site links wearing
  // an absolute-path costume — reject them so a doc page can't smuggle an
  // external link that looks internal (and would open in-frame, no rel guard).
  if (href.startsWith("#")) return href;
  if (href.startsWith("/") && !/^\/[/\\]/.test(href)) return href;
  return null; // relative, protocol-relative, or exotic schemes: render as text
}

// ── highlighting ───────────────────────────────────────────────────────────
// One lean tokenizer, language = a keyword set + comment style. Tokens are
// escaped individually, so highlighting can never un-escape source text.

const TS_KEYWORDS = new Set(
  "const let var function return if else for while do switch case break continue new class extends implements interface type enum import export from default async await try catch finally throw typeof instanceof in of as is void null undefined true false this super yield static readonly public private protected abstract namespace declare keyof infer never unknown any string number boolean object symbol bigint".split(
    " ",
  ),
);
const SH_KEYWORDS = new Set(
  "if then else elif fi for in do done while case esac function return exit export local set echo cd source".split(
    " ",
  ),
);
const SQL_KEYWORDS = new Set(
  "select from where insert into values update set delete create table index primary key foreign references not null unique default integer text real blob join left inner on as order by group having limit and or exists between".split(
    " ",
  ),
);

export function highlight(code: string, lang: string): string {
  const l = lang.toLowerCase();
  if (
    ["ts", "tsx", "js", "jsx", "typescript", "javascript", "json"].includes(l)
  )
    return tokenize(code, TS_KEYWORDS, { line: "//", block: true });
  if (
    [
      "sh",
      "bash",
      "shell",
      "zsh",
      "dockerfile",
      "docker",
      "yaml",
      "yml",
      "toml",
      "ini",
    ].includes(l)
  )
    return tokenize(code, l.startsWith("docker") ? new Set() : SH_KEYWORDS, {
      line: "#",
      block: false,
      dockerDirectives: l.startsWith("docker"),
    });
  if (l === "sql")
    return tokenize(code, SQL_KEYWORDS, {
      line: "--",
      block: true,
      caseInsensitive: true,
    });
  return esc(code);
}

function tokenize(
  code: string,
  keywords: Set<string>,
  opts: {
    line: string;
    block: boolean;
    caseInsensitive?: boolean;
    dockerDirectives?: boolean;
  },
): string {
  let out = "";
  let i = 0;
  const n = code.length;
  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = code[i]!;
    // comments
    if (opts.block && code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      out += `<span class="tk-c">${esc(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (code.startsWith(opts.line, i)) {
      let j = code.indexOf("\n", i);
      if (j === -1) j = n;
      out += `<span class="tk-c">${esc(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // strings
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, n);
      out += `<span class="tk-s">${esc(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // numbers
    if (/[0-9]/.test(c) && (i === 0 || !isWord(code[i - 1]!))) {
      let j = i;
      while (j < n && /[0-9a-fA-Fx._]/.test(code[j]!)) j++;
      out += `<span class="tk-n">${esc(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // words → keyword or plain
    if (isWord(c)) {
      let j = i;
      while (j < n && isWord(code[j]!)) j++;
      const word = code.slice(i, j);
      const key = opts.caseInsensitive ? word.toLowerCase() : word;
      // Dockerfiles highlight the directive column (FROM, RUN, …) instead of
      // a keyword set — an uppercase word at line start.
      const isDirective =
        opts.dockerDirectives &&
        /^[A-Z]+$/.test(word) &&
        (i === 0 || code[i - 1] === "\n");
      out +=
        keywords.has(key) || isDirective
          ? `<span class="tk-k">${esc(word)}</span>`
          : esc(word);
      i = j;
      continue;
    }
    out += esc(c);
    i++;
  }
  return out;
}

// ── blocks ─────────────────────────────────────────────────────────────────

const CALLOUTS: Record<string, { cls: string; label: string }> = {
  note: { cls: "note", label: "Note" },
  tip: { cls: "tip", label: "Tip" },
  important: { cls: "note", label: "Important" },
  warning: { cls: "warn", label: "Warning" },
  caution: { cls: "danger", label: "Caution" },
};

export function renderMd(src: string, opts: MdOptions = {}): RenderedDoc {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  const headings: DocHeading[] = [];
  const plainParts: string[] = [];
  const usedIds = new Set<string>();
  let i = 0;

  const flushPlain = (text: string) => {
    const t = text
      .replace(/[`*[\]()#>|-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (t) plainParts.push(t);
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    // fenced code: ```lang optional-title
    const fence = line.match(/^```(\w*)\s*(.*)$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const title = fence[2]
        ?.replace(/^title=/, "")
        .replace(/^["']|["']$/g, "");
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      const code = buf.join("\n");
      const body = `<pre><code>${highlight(code, lang)}</code></pre>`;
      out.push(
        `<figure class="codeblock"${lang ? ` data-lang="${esc(lang)}"` : ""}>` +
          (title
            ? `<figcaption><span class="cb-title">${esc(title)}</span></figcaption>`
            : "") +
          `<button class="cb-copy" data-tip="Copy" aria-label="Copy code">⧉</button>${body}</figure>`,
      );
      continue;
    }

    // headings
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const depth = h[1]!.length;
      const text = h[2]!.trim();
      let id = slugify(text);
      for (let k = 2; usedIds.has(id); k++) id = `${slugify(text)}-${k}`;
      usedIds.add(id);
      if (depth === 2 || depth === 3)
        headings.push({ depth, text: text.replace(/`/g, ""), id });
      flushPlain(text);
      const tag = `h${Math.min(depth + 1, 5)}`; // page <h1> is the doc title
      out.push(
        `<${tag} id="${id}">${inline(text, opts)}<a class="h-anchor" href="#${id}" aria-label="Link to section">#</a></${tag}>`,
      );
      i++;
      continue;
    }

    // hr
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // blockquote / callout
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        buf.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      const first = buf[0]?.match(/^\[!(\w+)\]\s*$/);
      const kind = first ? CALLOUTS[first[1]!.toLowerCase()] : undefined;
      const body = (kind ? buf.slice(1) : buf)
        .map((l) => inline(l, opts))
        .join("<br>");
      buf.forEach(flushPlain);
      out.push(
        kind
          ? `<div class="callout ${kind.cls}"><div class="callout-title">${kind.label}</div><div>${body}</div></div>`
          : `<blockquote>${body}</blockquote>`,
      );
      continue;
    }

    // table: header row + |---| separator
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!) &&
      lines[i + 1]!.includes("-")
    ) {
      const rowCells = (l: string) =>
        l
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => cell.trim());
      const head = rowCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|")) {
        rows.push(rowCells(lines[i]!));
        i++;
      }
      const th = head.map((c) => `<th>${inline(c, opts)}</th>`).join("");
      const trs = rows
        .map(
          (r) =>
            `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join("")}</tr>`,
        )
        .join("");
      head.forEach(flushPlain);
      rows.forEach((r) => r.forEach(flushPlain));
      out.push(
        `<div class="tablewrap"><table class="data"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`,
      );
      continue;
    }

    // lists (ordered + unordered, nested by 2-space indent). A wrapped item
    // continues on the next line (lazy continuation) — any non-blank line
    // that isn't a new bullet or block joins the item it belongs to.
    if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
      const items: Array<{ indent: number; ordered: boolean; text: string }> =
        [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m) {
          items.push({
            indent: Math.floor(m[1]!.length / 2),
            ordered: /\d/.test(m[2]!),
            text: m[3]!,
          });
          i++;
          continue;
        }
        const cont = lines[i]!;
        if (
          items.length &&
          cont.trim() &&
          !/^(#{1,4}\s|```|>|\||-{3,}\s*$)/.test(cont.trim())
        ) {
          items[items.length - 1]!.text += ` ${cont.trim()}`;
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(items, 0, opts));
      items.forEach((it) => flushPlain(it.text));
      continue;
    }

    // paragraph: greedy until a blank line or block starter
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4}\s|```|>|(\s*)([-*]|\d+\.)\s|-{3,}\s*$)/.test(lines[i]!)
    ) {
      buf.push(lines[i]!);
      i++;
    }
    const text = buf.join(" ");
    flushPlain(text);
    out.push(`<p>${inline(text, opts)}</p>`);
  }

  return { html: out.join("\n"), headings, plain: plainParts.join(" ") };
}

function renderList(
  items: Array<{ indent: number; ordered: boolean; text: string }>,
  depth: number,
  opts: MdOptions,
): string {
  if (!items.length) return "";
  const tag = items[0]!.ordered ? "ol" : "ul";
  let html = `<${tag}>`;
  let k = 0;
  while (k < items.length) {
    const it = items[k]!;
    if (it.indent < depth) break;
    // collect any deeper items following this one as its sublist
    const sub: typeof items = [];
    let j = k + 1;
    while (j < items.length && items[j]!.indent > depth) {
      sub.push(items[j]!);
      j++;
    }
    html += `<li>${inline(it.text, opts)}${renderList(sub, depth + 1, opts)}</li>`;
    k = j;
  }
  return `${html}</${tag}>`;
}
