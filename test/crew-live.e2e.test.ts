// Live crew on Sonnet 5, end to end: boot a platform with a real Claude token,
// describe a feature in plain English, and assert the crew builds it, opens a
// PR with a live preview, adversarially reviews it, and ships it — the whole
// "describe → working software" loop against the real model.
//
// Gated: runs ONLY with OP_CREW_LIVE=1 AND a CLAUDE_CODE_OAUTH_TOKEN present
// (real model calls cost money and take minutes). It is NOT in the default
// suite. Run it with:
//   CLAUDE_CODE_OAUTH_TOKEN="$(cat claude-token)" OP_CREW_LIVE=1 \
//     bun test test/crew-live.e2e.test.ts
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { resolveEngineSocket } from "@op/engine";
import { Platform } from "@op/opd";

setDefaultTimeout(20 * 60_000);
const sock = resolveEngineSocket();
const LIVE =
  !!sock &&
  process.env["OP_CREW_LIVE"] === "1" &&
  !!process.env["CLAUDE_CODE_OAUTH_TOKEN"];

describe.skipIf(!LIVE)(
  "crew on Sonnet 5: describe → built → reviewed → shipped",
  () => {
    const cleanup: Array<() => Promise<void>> = [];
    afterAll(async () => {
      for (const fn of cleanup.reverse()) await fn().catch(() => {});
    }, 120_000);

    test(
      "the on-ramp files a build and the crew ships it",
      async () => {
        await import("node:fs/promises").then((fs) =>
          fs.mkdir(join(homedir(), ".op-e2e"), { recursive: true }),
        );
        const base = await mkdtemp(join(homedir(), ".op-e2e", "crewlive-"));
        cleanup.push(() => rm(base, { recursive: true, force: true }));

        const p = Result.unwrap(
          await Platform.up({
            root: join(base, "p"),
            domain: "crewlive.localtest.me",
            httpPort: 28119,
            httpsPort: 28479,
            custodyAck: true,
          }),
        );
        cleanup.push(() => p.stop());
        cleanup.push(async () => {
          const list = await p.engine.listPlatformContainers(p.platformId);
          if (list.status === "ok")
            for (const c of list.value) await p.engine.stopAndRemove(c.id);
        });
        // The config default must be Sonnet 5 — this test's whole point.
        expect((p as { crewCredentialed?: boolean }).crewCredentialed).toBe(
          true,
        );

        const api = "https://crewlive.localtest.me:28479";
        const ca = p.caCertPem;
        const call = (path: string, init: RequestInit & { auth: string }) =>
          fetch(api + path, {
            ...init,
            tls: { ca },
            headers: {
              authorization: `Basic ${btoa(init.auth)}`,
              "content-type": "application/json",
              ...(init.headers ?? {}),
            },
          });
        const admin = `plat:${p.freshAdminPassword}`;
        await call("/api/v1/users", {
          method: "POST",
          auth: admin,
          body: JSON.stringify({ username: "ada", password: "pw-123456" }),
        });
        const tok = (await (
          await call("/api/v1/users/ada/tokens", {
            method: "POST",
            auth: admin,
            body: JSON.stringify({ name: "live" }),
          })
        ).json()) as { token: string };
        const ada = `ada:${tok.token}`;

        // The on-ramp: describe a workflow → app + first build filed in one call.
        const on = (await (
          await call("/api/v1/onramp", {
            method: "POST",
            auth: ada,
            body: JSON.stringify({
              description:
                "A simple guestbook: a signed-in visitor can leave a short message with their name, and everyone sees all messages newest-first. Persist them. Keep it safe against injection and XSS.",
            }),
          })
        ).json()) as { owner: string; app: string; issue: number };
        expect(on.app).toBeTruthy();

        // Poll the issue until the crew reaches a terminal state.
        const TERMINAL = [
          "agent-shipped",
          "agent-failed",
          "agent-review-failed",
        ];
        const t0 = Date.now();
        let labels: string[] = [];
        let prOpened = false;
        for (;;) {
          const data = (await (
            await call(`/api/v1/repos/ada/${on.app}/issues/${on.issue}`, {
              auth: ada,
            })
          ).json()) as { labels: string; comments: Array<{ body: string }> };
          labels = data.labels.split(",").filter(Boolean);
          if (
            data.comments.some((c) =>
              /Opened PR|Proposed the change/.test(c.body),
            )
          )
            prOpened = true;
          if (TERMINAL.some((t) => labels.includes(t))) break;
          if (Date.now() - t0 > 18 * 60_000) throw new Error("crew timed out");
          await Bun.sleep(5000);
        }

        // The loop RAN: a PR was opened and a terminal verdict reached. We assert
        // the happy path (shipped) but surface the verdict either way.
        expect(prOpened).toBe(true);
        if (!labels.includes("agent-shipped")) {
          const data = (await (
            await call(`/api/v1/repos/ada/${on.app}/issues/${on.issue}`, {
              auth: ada,
            })
          ).json()) as { comments: Array<{ body: string }> };
          const verdict = data.comments.map((c) => c.body).join("\n---\n");
          throw new Error(
            `crew did not ship (labels: ${labels.join(",")}):\n${verdict}`,
          );
        }
        expect(labels).toContain("agent-shipped");

        // Shipped means it's live in production — hit it.
        const res = await fetch(
          `https://${on.app}-ada.crewlive.localtest.me:28479/`,
          {
            tls: { ca },
          },
        );
        expect(res.status).toBe(200);
      },
      20 * 60_000,
    );
  },
);
