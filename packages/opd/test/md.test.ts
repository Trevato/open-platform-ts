import { describe, expect, test } from "bun:test";
import { CODE_REF_RE, parseFrontmatter, renderMd } from "../src/console/md.ts";

describe("frontmatter", () => {
  test("parses key: value block and strips it from the body", () => {
    const { meta, body } = parseFrontmatter(
      `---\ntitle: Quickstart\ndescription: "Boot a platform"\n---\n# Hi\n`,
    );
    expect(meta["title"]).toBe("Quickstart");
    expect(meta["description"]).toBe("Boot a platform");
    expect(body).toBe("# Hi\n");
  });

  test("no frontmatter → empty meta, untouched body", () => {
    const { meta, body } = parseFrontmatter("# Hi\n");
    expect(meta).toEqual({});
    expect(body).toBe("# Hi\n");
  });
});

describe("blocks", () => {
  test("headings get slug ids, anchors, and demoted tags (h2 → <h3>)", () => {
    const { html, headings } = renderMd("## Push to deploy\n### The gate");
    expect(html).toContain('<h3 id="push-to-deploy">');
    expect(html).toContain('<h4 id="the-gate">');
    expect(html).toContain('href="#push-to-deploy"');
    expect(headings).toEqual([
      { depth: 2, text: "Push to deploy", id: "push-to-deploy" },
      { depth: 3, text: "The gate", id: "the-gate" },
    ]);
  });

  test("duplicate heading text dedupes ids", () => {
    const { html } = renderMd("## Setup\n\n## Setup");
    expect(html).toContain('id="setup"');
    expect(html).toContain('id="setup-2"');
  });

  test("fenced code keeps language, title, and copy affordance", () => {
    const { html } = renderMd('```ts title="a.ts"\nconst x = 1;\n```');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('<span class="cb-title">a.ts</span>');
    expect(html).toContain('class="cb-copy"');
    expect(html).toContain('<span class="tk-k">const</span>');
  });

  test("callouts render typed; plain quotes stay blockquotes", () => {
    const co = renderMd("> [!warning]\n> Mind the gap").html;
    expect(co).toContain('class="callout warn"');
    expect(co).toContain("Mind the gap");
    const bq = renderMd("> just a quote").html;
    expect(bq).toContain("<blockquote>just a quote</blockquote>");
  });

  test("tables render header + rows inside the scroll wrapper", () => {
    const { html } = renderMd("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain('<div class="tablewrap">');
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  test("nested lists nest; ordered stays ordered", () => {
    const { html } = renderMd("- top\n  - inner\n\n1. one\n2. two");
    expect(html).toContain("<ul><li>top<ul><li>inner</li></ul></li></ul>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
  });

  test("paragraph joins wrapped lines", () => {
    const { html } = renderMd("one\ntwo");
    expect(html).toBe("<p>one two</p>");
  });
});

describe("inline", () => {
  test("emphasis, code, links", () => {
    const { html } = renderMd(
      "**bold** and *em* and `code` and [docs](/docs/quickstart) and [ext](https://bun.sh)",
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="/docs/quickstart">docs</a>');
    expect(html).toContain(
      '<a href="https://bun.sh" target="_blank" rel="noopener">ext</a>',
    );
  });

  test("unsafe or relative link targets render as bare text", () => {
    const { html } = renderMd("[x](javascript:alert(1)) [y](../up)");
    expect(html).not.toContain("<a");
    expect(html).toContain("x");
    expect(html).toContain("y");
  });

  test("codeLink turns matching inline code into a source link", () => {
    const { html } = renderMd("see `packages/opd/src/api.ts:42` here", {
      codeLink: (c) =>
        CODE_REF_RE.test(c) ? `/apps/plat/opd/blob/main/x` : null,
    });
    expect(html).toContain('class="code-ref"');
    expect(html).toContain("<code>packages/opd/src/api.ts:42</code>");
  });
});

describe("safety", () => {
  test("script/html is escaped in every position", () => {
    const evil = `<script>alert(1)</script>`;
    const { html } = renderMd(
      `# ${evil}\n\npara ${evil}\n\n- li ${evil}\n\n| ${evil} |\n|---|\n| c |\n\n> ${evil}\n\n\`\`\`\n${evil}\n\`\`\`\n\n\`${evil}\``,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("attribute injection via link href is escaped", () => {
    const { html } = renderMd(`[x](/docs/a"><script>alert(1)</script>)`);
    expect(html).not.toContain("<script>");
  });
});

describe("CODE_REF_RE", () => {
  const good = [
    "packages/opd/src/api.ts:42",
    "packages/opd/src/api.ts:42-60",
    "packages/core/src/ids.ts",
    "genesis/app-template/server.ts",
    "test/m1.e2e.test.ts:7",
    "docs/design/04-work-items.md",
  ];
  const bad = [
    "src/api.ts:42", // not repo-rooted
    "packages/opd/src/", // directory
    "packages/opd/src/api", // no extension
    "api.ts:42",
    "https://x.dev/a.ts:1",
    "packages/../etc/passwd.txt:1",
  ];
  for (const g of good)
    test(`accepts ${g}`, () => expect(CODE_REF_RE.test(g)).toBe(true));
  for (const b of bad)
    test(`rejects ${b}`, () => expect(CODE_REF_RE.test(b)).toBe(false));
});

describe("plain extraction", () => {
  test("prose survives, code bodies do not", () => {
    const { plain } = renderMd(
      "## Deploys\n\nPush and it ships.\n\n```ts\nconst secretish = 1;\n```",
    );
    expect(plain).toContain("Deploys");
    expect(plain).toContain("Push and it ships.");
    expect(plain).not.toContain("secretish");
  });
});

describe("formatter compatibility", () => {
  test("underscore emphasis (what prettier writes) renders", () => {
    const { html } = renderMd("a push _is_ the event, __always__");
    expect(html).toContain("<em>is</em>");
    expect(html).toContain("<strong>always</strong>");
  });

  test("snake_case identifiers stay literal", () => {
    const { html } = renderMd("the client_credentials grant and app_ports table");
    expect(html).not.toContain("<em>");
  });

  test("wrapped list items keep their continuation lines", () => {
    const { html } = renderMd(
      "- **Quickstart**: boot a platform and ship your first app\n  in a few minutes.\n- next item",
    );
    expect(html).toContain("ship your first app in a few minutes.");
    expect(html).not.toContain("<p>in a few minutes");
  });
});

describe("link href hardening", () => {
  test("protocol-relative and backslash paths never become links", () => {
    for (const bad of ["//evil.com/phish", "/\\evil.com", "//evil.com"]) {
      const { html } = renderMd(`[go](${bad})`);
      expect(html).not.toContain("<a");
      expect(html).toContain("go");
    }
  });
  test("genuine same-origin absolute paths still link", () => {
    const { html } = renderMd("[a](/docs/x) [b](/apps/o/a/blob/main/x.ts)");
    expect(html).toContain('<a href="/docs/x">a</a>');
    expect(html).toContain('<a href="/apps/o/a/blob/main/x.ts">b</a>');
  });
});
