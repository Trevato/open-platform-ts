import { describe, expect, test } from "bun:test";
import { createLog, Result } from "@op/core";
import type { UserRow } from "@op/store";
import {
  runGuide,
  type GuideDeps,
  type GuideEvent,
  type RunQuery,
} from "../src/crew/guide.ts";

// A fake SDK query() yielding scripted messages — no live model, no tools
// executed. Exercises the streaming/event contract deterministically. Deps
// that only tool HANDLERS touch stay null: with a fake query the SDK never
// calls a tool, so reaching one would correctly explode the test.
function fakeQuery(messages: unknown[]): RunQuery {
  return (() => {
    async function* gen() {
      for (const m of messages) yield m;
    }
    return gen();
  }) as unknown as RunQuery;
}

const user: UserRow = {
  id: "u1",
  username: "plat",
  password_hash: "",
  is_admin: 1,
  created_at: 0,
} as UserRow;

const deps: GuideDeps = {
  sd: null as never,
  store: null as never,
  forge: null as never,
  git: null as never,
  engine: null as never,
  docs: null as never,
  domain: "plat.localtest.me",
  srcDir: "/nonexistent",
  appPolicy: null as never,
  loadAgent: async () =>
    Result.err(
      new (class extends Error {
        override message = "no git";
      })() as never,
    ),
  oauthToken: "sk-ant-oat01-test",
  model: () => "claude-sonnet-5",
  log: createLog("t"),
};

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const toolStart = (name: string) => ({
  type: "stream_event",
  event: {
    type: "content_block_start",
    content_block: { type: "tool_use", name },
  },
});

async function collect(
  q: RunQuery,
  messages = [{ role: "user" as const, content: "why is my app red?" }],
) {
  const events: GuideEvent[] = [];
  const out = await runGuide(deps, {
    user,
    messages,
    onEvent: (ev) => events.push(ev),
    deadlineMs: 5_000,
    runQuery: q,
  });
  return { events, out };
}

describe("guide streaming", () => {
  test("streams text deltas, tool markers, and done-with-cost, in order", async () => {
    const { events, out } = await collect(
      fakeQuery([
        toolStart("mcp__platform__docs_search"),
        textDelta("Check the "),
        textDelta("build log."),
        { type: "result", subtype: "success", total_cost_usd: 0.0123 },
      ]),
    );
    expect(out.status).toBe("ok");
    expect(events).toEqual([
      { type: "tool", name: "docs_search", detail: "" },
      { type: "text", text: "Check the " },
      { type: "text", text: "build log." },
      { type: "done", costUsd: 0.0123 },
    ]);
  });

  test("non-streaming result text still reaches the client once", async () => {
    const { events } = await collect(
      fakeQuery([{ type: "result", subtype: "success", result: "All good." }]),
    );
    expect(events).toEqual([
      { type: "text", text: "All good." },
      { type: "done", costUsd: null },
    ]);
  });

  test("an errored run with no text is a GuideError, not a silent empty reply", async () => {
    const { out } = await collect(
      fakeQuery([{ type: "result", subtype: "error_during_execution" }]),
    );
    expect(out.status).toBe("error");
  });

  test("an errored run that already streamed text keeps the text (partial answer beats none)", async () => {
    const { events, out } = await collect(
      fakeQuery([
        textDelta("Half an answer"),
        { type: "result", subtype: "error_max_turns" },
      ]),
    );
    expect(out.status).toBe("ok");
    expect(events[0]).toEqual({ type: "text", text: "Half an answer" });
  });

  test("an empty conversation is rejected before any model call", async () => {
    const explode = (() => {
      throw new Error("must not be called");
    }) as unknown as RunQuery;
    const { out } = await collect(explode, [
      { role: "user" as const, content: "   " },
    ]);
    expect(out.status).toBe("error");
  });
});
