// The docs truth gate: documentation that lies cannot merge. Every page in
// genesis/platform/docs is held to its claims —
//   • every code reference (`packages/…/file.ts:line`) must name a real file
//     and an in-range line in THIS tree,
//   • near-miss references (un-rooted paths, path:line typos) fail loudly
//     instead of silently rendering as dead text,
//   • every internal /docs/... link must resolve to a listed page (and its
//     #anchor to a real heading),
//   • every page carries the title + description the console renders.
// This is the mechanism that lets docs pages cite exact code locations: the
// citation is checked here, at merge time, against the same grammar the
// renderer uses to link it (CODE_REF_RE — one definition, two duties).
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CODE_REF_RE,
  parseFrontmatter,
  renderMd,
} from "../packages/opd/src/console/md.ts";

const ROOT = join(import.meta.dir, "..");
const DOCS_DIR = join(ROOT, "genesis", "platform", "docs");

interface Manifest {
  sections: Array<{ title: string; pages: string[] }>;
}

const manifest = (await Bun.file(
  join(DOCS_DIR, "docs.json"),
).json()) as Manifest;
const slugs = manifest.sections.flatMap((s) => s.pages);

interface Page {
  slug: string;
  meta: Record<string, string>;
  body: string;
  headingIds: Set<string>;
}

async function loadPage(slug: string): Promise<Page> {
  const src = await Bun.file(join(DOCS_DIR, `${slug}.md`)).text();
  const { meta, body } = parseFrontmatter(src);
  const rendered = renderMd(body);
  return {
    slug,
    meta,
    body,
    headingIds: new Set(rendered.headings.map((h) => h.id)),
  };
}

// Missing files are a FAILURE (the manifest test names them), not a crash —
// the rest of the suite still checks every page that does exist.
const pages = new Map<string, Page>();
for (const slug of slugs)
  if (await Bun.file(join(DOCS_DIR, `${slug}.md`)).exists())
    pages.set(slug, await loadPage(slug));

/** Inline code spans outside fenced blocks — the only place code refs live. */
function inlineSpans(body: string): string[] {
  const noFences = body.replace(/^```.*$[\s\S]*?^```\s*$/gm, "");
  return [...noFences.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

/** A span that is trying to be a code reference, even if malformed. Bare
 *  directory mentions (`docs/`, `crew/guide/`) are prose, exactly as the
 *  renderer treats them — a reference names a FILE, with an extension. The
 *  detector is deliberately LOOSER than CODE_REF_RE: it fires on any
 *  repo-rooted file path however its line suffix is spelled (`:15,20`, `#L15`,
 *  `:L15`), so a near-miss citation is force-tested by the strict grammar and
 *  fails CI instead of silently rendering as dead text. */
function looksLikeRef(span: string): boolean {
  return (
    /^(packages|genesis|test|docs)\/\S+\.[A-Za-z0-9]+([:#].*)?$/.test(span) ||
    /^[A-Za-z0-9._/-]+\.[a-z]+[:#][A-Za-z0-9,-]+$/.test(span)
  );
}

describe("docs manifest", () => {
  test("slugs are unique and every page file exists", async () => {
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs)
      expect(
        await Bun.file(join(DOCS_DIR, `${slug}.md`)).exists(),
        `manifest lists '${slug}' but docs/${slug}.md is missing`,
      ).toBe(true);
  });

  test("no orphan pages — every md file is in the manifest", () => {
    const files = readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
    const listed = new Set(slugs);
    expect(files.filter((f) => !listed.has(f))).toEqual([]);
  });
});

describe("docs frontmatter", () => {
  for (const [slug, pg] of pages) {
    test(`${slug}: title + description present`, () => {
      expect(pg.meta["title"], `${slug}.md needs a title`).toBeTruthy();
      expect(
        pg.meta["description"],
        `${slug}.md needs a description`,
      ).toBeTruthy();
    });
  }
});

describe("docs code references", () => {
  for (const [slug, pg] of pages) {
    test(`${slug}: every code reference resolves in this tree`, async () => {
      for (const span of inlineSpans(pg.body)) {
        if (!looksLikeRef(span)) continue;
        expect(
          CODE_REF_RE.test(span),
          `${slug}.md: '${span}' looks like a code reference but doesn't match the grammar (repo-rooted path, optional :line or :line-line)`,
        ).toBe(true);
        const m = span.match(/^(.*?)(?::(\d+)(?:-(\d+))?)?$/)!;
        const [, path, startRaw, endRaw] = m;
        const file = Bun.file(join(ROOT, path!));
        expect(
          await file.exists(),
          `${slug}.md references '${path}' which does not exist`,
        ).toBe(true);
        if (startRaw) {
          const lineCount = (await file.text()).split("\n").length;
          const start = Number(startRaw);
          const end = Number(endRaw ?? startRaw);
          expect(
            start >= 1 && end >= start && end <= lineCount,
            `${slug}.md: '${span}' is out of range (${path} has ${lineCount} lines)`,
          ).toBe(true);
        }
      }
    });
  }
});

describe("docs internal links", () => {
  for (const [slug, pg] of pages) {
    test(`${slug}: /docs links resolve (pages and anchors)`, () => {
      for (const m of pg.body.matchAll(
        /\]\(\/docs\/([a-z0-9-]+)(#[^)\s]+)?\)/g,
      )) {
        const target = m[1]!;
        expect(
          pages.has(target),
          `${slug}.md links to /docs/${target} which is not a page`,
        ).toBe(true);
        const anchor = m[2]?.slice(1);
        if (anchor)
          expect(
            pages.get(target)!.headingIds.has(anchor),
            `${slug}.md links to /docs/${target}#${anchor} — no such heading`,
          ).toBe(true);
      }
    });
  }
});
