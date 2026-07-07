import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Result, TaggedError, type Log } from "@op/core";
import { loadAgent, type RunAgent } from "@op/crew";
import { makeHeartbeat } from "./heartbeat.ts";

export class ReviewError extends TaggedError("ReviewError")<{
  message: string;
  step: string;
}>() {}

export type VerdictKind =
  | "pass"
  | "concerns"
  | "fail"
  | "untestable"
  | "unknown";
export interface Verdict {
  kind: VerdictKind;
  line: string;
  costUsd: number;
}

/** The verdict is the reviewer's final line, structurally required to start
 *  with one of four markers. Parse the LAST such line in its output. */
export function parseVerdict(text: string): {
  kind: VerdictKind;
  line: string;
} {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.startsWith("✅")) return { kind: "pass", line: l };
    if (l.startsWith("⚠️")) return { kind: "concerns", line: l };
    if (l.startsWith("❌") && /untestable/i.test(l))
      return { kind: "untestable", line: l };
    if (l.startsWith("❌")) return { kind: "fail", line: l };
  }
  return { kind: "unknown", line: text.slice(-200) };
}

// Obtain a signed-in QA session for the preview via OIDC-over-HTTP (the same
// dance a browser does, scripted): preview/login → authorize → platform login
// (which completes authz inline) → app callback → session cookie. Runs on the
// host, reaching preview + issuer through the gate (both resolve to 127.0.0.1
// via *.localtest.me). Returns the app's `sid` cookie value, or null.
export async function getQaSession(opts: {
  previewOrigin: string;
  issuerOrigin: string;
  qaUser: string;
  qaPass: string;
  ca: string;
}): Promise<string | null> {
  const tls = { ca: opts.ca };
  const noFollow = { tls, redirect: "manual" as const };
  try {
    const r1 = await fetch(`${opts.previewOrigin}/login`, noFollow);
    const authz = r1.headers.get("location");
    if (!authz) return null;
    const r2 = await fetch(authz, noFollow);
    const loginUrl = r2.headers.get("location");
    if (!loginUrl || !loginUrl.includes("/login?next=")) return null;
    const r3 = await fetch(loginUrl, {
      ...noFollow,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: opts.qaUser,
        password: opts.qaPass,
      }),
    });
    const cb = r3.headers.get("location");
    if (!cb || !cb.includes("/auth/callback")) return null;
    const r4 = await fetch(cb, noFollow);
    const setCookie = r4.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/sid=([^;]+)/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export interface ReviewerDeps {
  domain: string;
  httpsPort: number;
  genesisDir: string;
  caFile: string;
  runAgent: RunAgent;
  oauthToken: string;
  qaUser: string;
  qaPassword: string;
  log: Log;
  onProgress?: (line: string) => void;
}

/**
 * Review a crew PR's live preview: fetch a QA session, then run the caged
 * reviewer agent (bun + HTTP, no host access) which tries to break the feature
 * and emits a verdict line. Returns the parsed verdict.
 */
export async function runReviewer(
  deps: ReviewerDeps,
  args: {
    owner: string;
    repo: string;
    prNumber: number;
    issueBody: string;
    issueTitle: string;
  },
): Promise<Result<Verdict, ReviewError>> {
  const fail = (step: string) => (cause: unknown) =>
    new ReviewError({ message: String(cause), step });
  const port = deps.httpsPort === 443 ? "" : `:${deps.httpsPort}`;
  const previewHost = `pr-${args.prNumber}-${args.repo}-${args.owner}.${deps.domain}`;
  const previewOrigin = `https://${previewHost}${port}`;
  const issuerOrigin = `https://${deps.domain}${port}`;

  return Result.tryPromise({
    try: async () => {
      const ca = await readFile(deps.caFile, "utf8");
      const cookie = await getQaSession({
        previewOrigin,
        issuerOrigin,
        qaUser: deps.qaUser,
        qaPass: deps.qaPassword,
        ca,
      });

      const workRoot = join(homedir(), ".op-crew");
      await mkdir(workRoot, { recursive: true });
      const work = await mkdtemp(join(workRoot, "review-"));
      try {
        await writeFile(
          join(work, "ISSUE.md"),
          `# ${args.issueTitle}\n\n${args.issueBody || "(no description)"}\n`,
        );
        await writeFile(
          join(work, "REVIEW.md"),
          `# Review target\n\nPreview URL: ${previewOrigin}\nIssuer (platform): ${issuerOrigin}\n` +
            `You are testing over HTTP with Bun. Trust the platform CA via OP_CA_FILE.\n` +
            (cookie
              ? `A signed-in QA session cookie is in session-cookie.txt — send it as \`Cookie: sid=<value>\`.\n`
              : `NOTE: a QA session could not be pre-obtained; test unauthenticated behavior and report if sign-in is required to verify.\n`),
        );
        await writeFile(
          join(work, "session-cookie.txt"),
          cookie ? `sid=${cookie}` : "",
        );
        // The agent (uid 1000) needs to write scratch files here.
        await Bun.spawn(["chmod", "-R", "a+rwX", work], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited;

        const agent = await loadAgent(
          join(deps.genesisDir, "crew"),
          "reviewer",
        );
        if (agent.status === "error")
          throw new Error(`load reviewer: ${agent.error.message}`);

        deps.onProgress?.("🔍 reviewer starting");
        const run = await deps.runAgent({
          cwd: work,
          systemPrompt: agent.value.instructions,
          prompt:
            "Review the live preview per REVIEW.md and ISSUE.md. Try to break it (auth, injection, bad input, regressions). End with exactly one verdict line.",
          oauthToken: deps.oauthToken,
          allowedTools: [], // caged: the container is the boundary
          idleTimeoutMs: 6 * 60_000,
          hardTimeoutMs: 15 * 60_000,
          extraBinds: [`${deps.caFile}:/etc/op/ca.crt:ro`],
          // Reach the preview + issuer (both served by the host gate).
          extraHosts: [
            `${previewHost}:host-gateway`,
            `${deps.domain}:host-gateway`,
          ],
          ...(deps.onProgress
            ? { onLine: makeHeartbeat(deps.onProgress) }
            : {}),
          log: deps.log,
        });
        if (run.status === "error")
          throw new Error(`reviewer agent: ${run.error.message}`);
        const v = parseVerdict(run.value.result);
        return { kind: v.kind, line: v.line, costUsd: run.value.costUsd };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    catch: fail("runReviewer"),
  });
}
