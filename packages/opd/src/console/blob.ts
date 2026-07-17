// The source viewer: any file, any readable repo, at any ref — with line
// anchors (#L42, #L42-60) so docs, work items, and the guide can point at the
// exact lines they mean. This is the link target that makes a docs code
// reference a first-class citizen instead of a string.

import type { GitHost } from "@op/git";
import { esc } from "./layout.ts";
import { highlight } from "./md.ts";

const MAX_BLOB_BYTES = 512 * 1024;

// A git ref may carry slashes (branch names like `agent/issue-1`), so we can't
// forbid `/` — but `..` is never a legitimate ref token and is the traversal
// shape the git layer's own sibling guards (diffRefs) reject. Match that here.
const REF_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,128}$/;

function langOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return (
    {
      ts: "ts",
      tsx: "ts",
      js: "ts",
      jsx: "ts",
      mjs: "ts",
      json: "json",
      sh: "sh",
      bash: "sh",
      yml: "yaml",
      yaml: "yaml",
      toml: "toml",
      sql: "sql",
      md: "",
    }[ext] ?? ""
  );
}

export interface BlobView {
  /** The page body, or null when the path can't be shown (caller 404s). */
  body: string | null;
  title: string;
}

export async function blobView(
  git: GitHost,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<BlobView> {
  const title = `${path.split("/").pop() ?? path} · ${owner}/${repo}`;
  if (!REF_RE.test(ref) || path.includes("..") || path.startsWith("/"))
    return { body: null, title };

  const read = await git.readFile(owner, repo, ref, path);
  if (read.status === "error") return { body: null, title };
  const bytes = read.value;

  const header = (note: string) => `
<div class="row between blob-head">
  <span class="mono blob-path">${esc(path)}</span>
  <span class="row" style="gap:8px">${note}</span>
</div>`;

  if (bytes.length > MAX_BLOB_BYTES)
    return {
      body:
        header(
          `<span class="mut">${(bytes.length / 1024).toFixed(0)} KB</span>`,
        ) +
        `<div class="empty">Too large to display — <code>git clone</code> the repo to read it.</div>`,
      title,
    };
  if (bytes.includes(0))
    return {
      body:
        header(`<span class="mut">binary</span>`) +
        `<div class="empty">Binary file (${(bytes.length / 1024).toFixed(1)} KB).</div>`,
      title,
    };

  const text = new TextDecoder().decode(bytes);
  const lines = highlight(text, langOf(path)).split("\n");
  const rows = lines
    .map(
      (l, i) =>
        `<div class="bl" id="L${i + 1}"><a class="bln" href="#L${i + 1}">${i + 1}</a><span class="blc">${l || " "}</span></div>`,
    )
    .join("");
  const body =
    header(
      `<button class="btn ghost sm" id="blobcopy" type="button" data-tip="Copy file">⧉ Copy</button>` +
        `<span class="mut nowrap">${lines.length} lines · ${esc(ref)}</span>`,
    ) + `<div class="blob mono" id="blob">${rows}</div>`;
  return { body, title };
}

// Highlight + scroll the anchored line or range (#L12, #L12-40, #L12-L40) —
// hash-driven so a pasted docs link lands on the exact lines it names.
export const BLOB_JS = `
(function(){
  var el=document.getElementById('blob');if(!el)return;
  function mark(){
    var m=location.hash.match(/^#L(\\d+)(?:-L?(\\d+))?$/);
    [].forEach.call(el.querySelectorAll('.bl.hl'),function(x){x.classList.remove('hl')});
    if(!m)return;
    var a=+m[1],b=+(m[2]||m[1]);if(b<a){var t=a;a=b;b=t;}
    for(var i=a;i<=b;i++){var r=document.getElementById('L'+i);if(r)r.classList.add('hl');}
    var first=document.getElementById('L'+a);
    if(first)first.scrollIntoView({block:'center'});
  }
  addEventListener('hashchange',mark);mark();
  var c=document.getElementById('blobcopy');
  if(c)c.addEventListener('click',function(){
    var t=[].map.call(el.querySelectorAll('.blc'),function(x){return x.textContent}).join('\\n');
    navigator.clipboard.writeText(t).then(function(){toast('file copied')});
  });
})();
`;
