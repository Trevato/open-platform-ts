import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLog, Result } from "@op/core";
import { draftIssue, type RunQuery } from "../src/crew/composer.ts";

// Ensure a stray real key in the env doesn't route the SDK-path tests to the API.
const savedKey = process.env["ANTHROPIC_API_KEY"];
beforeEach(() => delete process.env["ANTHROPIC_API_KEY"]);
afterEach(() => {
  if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedKey;
});

// A fake SDK query() that yields scripted messages — no live model. Exercises
// the parse/clamp/degrade contract deterministically.
function fakeQuery(messages: unknown[]): RunQuery {
  return (() => {
    async function* gen() {
      for (const m of messages) yield m;
    }
    return gen();
  }) as unknown as RunQuery;
}

const opts = (runQuery: RunQuery, idea = "add tags") => ({
  idea,
  oauthToken: "x",
  log: createLog("t"),
  deadlineMs: 5000,
  runQuery,
});

describe("composer draftIssue (SDK)", () => {
  test("reads structured_output and clamps to policy", async () => {
    const q = fakeQuery([
      { type: "system", subtype: "init" },
      {
        type: "result",
        subtype: "success",
        structured_output: {
          title: "Add tags to bookmarks",
          body: "Add a tags column…",
          labels: ["ui"], // agent-work missing — clamp must add it
          acceptanceChecks: ["unauth POST → 401", "tags escaped"],
        },
      },
    ]);
    const d = Result.unwrap(await draftIssue(opts(q)));
    expect(d.title).toBe("Add tags to bookmarks");
    expect(d.labels).toContain("agent-work"); // policy enforced
    expect(d.acceptanceChecks.length).toBe(2);
  });

  test("target contracts: self-repos and templates get their own build contract, apps keep theirs", async () => {
    const captured: string[] = [];
    const capturing = ((args: { options?: { systemPrompt?: string } }) => {
      captured.push(args.options?.systemPrompt ?? "");
      async function* gen() {
        yield {
          type: "result",
          subtype: "success",
          structured_output: {
            title: "t",
            body: "b",
            labels: [],
            acceptanceChecks: [],
          },
        };
      }
      return gen();
    }) as unknown as RunQuery;
    await draftIssue({ ...opts(capturing), target: "platform-source" });
    await draftIssue({ ...opts(capturing), target: "platform-config" });
    await draftIssue({ ...opts(capturing), target: "template" });
    await draftIssue(opts(capturing)); // default target = app
    expect(captured[0]).toContain("plat/opd");
    expect(captured[0]).toContain("PARKS FOR HUMAN REVIEW");
    expect(captured[1]).toContain("plat/platform");
    expect(captured[1]).toContain("platform.json");
    expect(captured[2]).toContain("plat/app-template");
    // The app contract survives target-awareness — the default draft still
    // speaks single-file Bun + preview + auto-merge.
    expect(captured[3]).toContain("single-file Bun + bun:sqlite");
    expect(captured[3]).toContain("live preview");
  });

  test("falls back to parsing text when there is no structured_output (tolerates fences)", async () => {
    const q = fakeQuery([
      {
        type: "result",
        subtype: "success",
        result:
          "```json\n" +
          JSON.stringify({
            title: "Dark mode",
            body: "b",
            labels: ["agent-work"],
            acceptanceChecks: [],
          }) +
          "\n```",
      },
    ]);
    const d = Result.unwrap(await draftIssue(opts(q)));
    expect(d.title).toBe("Dark mode");
  });

  test("degrades a junk response to a usable draft (title = the idea), never throws", async () => {
    const q = fakeQuery([
      { type: "result", subtype: "success", result: "not json at all" },
    ]);
    const d = Result.unwrap(await draftIssue(opts(q, "my great idea")));
    expect(d.title).toBe("my great idea");
    expect(d.labels).toContain("agent-work");
  });

  test("caps labels and checks; always includes agent-work", async () => {
    const q = fakeQuery([
      {
        type: "result",
        subtype: "success",
        structured_output: {
          title: "x",
          body: "y",
          labels: ["a", "b", "c", "d", "e", "f", "g", "h"],
          acceptanceChecks: Array.from({ length: 12 }, (_, i) => `c${i}`),
        },
      },
    ]);
    const d = Result.unwrap(await draftIssue(opts(q)));
    expect(d.labels.length).toBeLessThanOrEqual(6);
    expect(d.labels).toContain("agent-work");
    expect(d.acceptanceChecks.length).toBeLessThanOrEqual(8);
  });

  test("an error result with no content surfaces an error (→ console degrades)", async () => {
    const q = fakeQuery([
      { type: "result", subtype: "error_during_execution" },
    ]);
    const r = await draftIssue(opts(q));
    expect(r.status).toBe("error");
  });

  test("a real ANTHROPIC_API_KEY takes the raw Messages API fast lane (not the SDK)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-api-fake";
    let calledUrl = "";
    const fetchImpl = (async (url: string) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({
          content: [
            {
              text: JSON.stringify({
                title: "Fast draft",
                body: "b",
                labels: ["agent-work"],
                acceptanceChecks: ["c"],
              }),
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    // runQuery throws if reached — proves the SDK path was NOT taken.
    const explodeQuery = (() => {
      throw new Error("SDK path should not run when a real API key is present");
    }) as unknown as RunQuery;
    const d = Result.unwrap(
      await draftIssue({
        idea: "x",
        oauthToken: "x",
        log: createLog("t"),
        runQuery: explodeQuery,
        fetchImpl,
      }),
    );
    expect(calledUrl).toContain("api.anthropic.com");
    expect(d.title).toBe("Fast draft");
  });
});
