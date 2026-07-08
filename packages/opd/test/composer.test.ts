import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, Result } from "@op/core";
import { draftIssue } from "../src/crew/composer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  delete process.env["OP_CLAUDE_BIN"];
});

// A fake `claude` that FIRST drains stdin (`cat` blocks forever if stdin is an
// open pipe) then prints the stream-json wrapper the composer expects. It
// exercises the two fixes at once: the composer must close stdin (or this hangs
// past the deadline) and must parse the fenced JSON the model returns.
function fakeClaude(resultJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fakeclaude-"));
  dirs.push(dir);
  const bin = join(dir, "claude");
  const payload = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: resultJson,
  });
  writeFileSync(
    bin,
    `#!/bin/sh\ncat >/dev/null\ncat <<'PAYLOAD'\n${payload}\nPAYLOAD\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("composer draftIssue", () => {
  test("parses the model JSON (tolerating markdown fences) and never hangs on stdin", async () => {
    process.env["OP_CLAUDE_BIN"] = fakeClaude(
      "```json\n" +
        JSON.stringify({
          title: "Add tags to bookmarks",
          body: "Add a tags column…",
          labels: ["agent-work"],
          acceptanceChecks: ["unauth POST → 401", "tags render escaped"],
        }) +
        "\n```",
    );
    const r = await draftIssue({
      idea: "add tags",
      oauthToken: "x",
      log: createLog("t"),
      deadlineMs: 8000, // if stdin weren't closed, `cat` hangs and this fires
    });
    expect(r.status).toBe("ok");
    const d = Result.unwrap(r);
    expect(d.title).toBe("Add tags to bookmarks");
    expect(d.labels).toContain("agent-work");
    expect(d.acceptanceChecks.length).toBe(2);
  });

  test("always includes agent-work and clamps to the schema", async () => {
    process.env["OP_CLAUDE_BIN"] = fakeClaude(
      JSON.stringify({
        title: "x",
        body: "y",
        labels: ["custom"],
        acceptanceChecks: [],
      }),
    );
    const d = Result.unwrap(
      await draftIssue({
        idea: "z",
        oauthToken: "x",
        log: createLog("t"),
        deadlineMs: 8000,
      }),
    );
    expect(d.labels).toContain("agent-work");
  });

  test("degrades a junk model response to a usable draft (title = the idea)", async () => {
    process.env["OP_CLAUDE_BIN"] = fakeClaude("not json at all");
    const d = Result.unwrap(
      await draftIssue({
        idea: "my great idea",
        oauthToken: "x",
        log: createLog("t"),
        deadlineMs: 8000,
      }),
    );
    expect(d.title).toBe("my great idea");
    expect(d.labels).toContain("agent-work");
  });
});
