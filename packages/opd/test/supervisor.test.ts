import { describe, expect, test } from "bun:test";
import { createLog } from "@op/core";
import {
  HEALTH_GRACE_MS,
  nextAction,
  supervise,
  UPGRADE_EXIT,
} from "../src/supervisor.ts";

describe("nextAction", () => {
  test("UPGRADE_EXIT → upgrade", () => {
    expect(nextAction(UPGRADE_EXIT, 5_000, false)).toBe("upgrade");
  });
  test("0 → stop", () => {
    expect(nextAction(0, 100_000, false)).toBe("stop");
  });
  test("fast non-zero exit right after an upgrade → rollback", () => {
    expect(nextAction(1, 1_000, true)).toBe("rollback");
  });
  test("non-zero exit long after upgrade → restart (not rollback)", () => {
    expect(nextAction(1, HEALTH_GRACE_MS + 1, true)).toBe("restart");
  });
  test("crash with no pending upgrade → restart", () => {
    expect(nextAction(139, 500, false)).toBe("restart");
  });
});

describe("supervise loop", () => {
  const log = createLog("test");
  const io = (
    codes: (number | null)[],
    events: string[],
  ): Parameters<typeof supervise>[0] => {
    let i = 0;
    let head = "good-sha";
    return {
      src: "/src",
      domain: "d",
      log,
      now: (() => {
        let t = 0;
        return () => (t += 1); // each call advances 1ms → uptimes are ~1ms (fast)
      })(),
      sleep: async () => {},
      spawnDaemon: async () => codes[i++] ?? 0,
      headRef: async () => head,
      pullLatest: async () => {
        head = "new-sha";
        events.push("pull");
      },
      resetTo: async (_s, ref) => {
        head = ref;
        events.push(`reset:${ref}`);
      },
    };
  };

  test("upgrade then clean stop: pulls once, then stops", async () => {
    const events: string[] = [];
    const code = await supervise(io([UPGRADE_EXIT, 0], events));
    expect(code).toBe(0);
    expect(events).toEqual(["pull"]);
  });

  test("upgrade whose new daemon dies fast → rolls back to the last-good sha", async () => {
    const events: string[] = [];
    // run(good, exit UPGRADE) → pull → run(new, exit 1 fast) → rollback → run(good, exit 0)
    const code = await supervise(io([UPGRADE_EXIT, 1, 0], events));
    expect(code).toBe(0);
    expect(events).toEqual(["pull", "reset:good-sha"]);
  });
});
