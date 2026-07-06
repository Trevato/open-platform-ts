import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoPath, Result, TaggedError, type StateDir } from "@op/core";
import type { GitHost } from "@op/git";
import type { SecretsFile } from "@op/secrets";
import { admitSpec, type AppSpec } from "./policy.ts";

export class GitopsError extends TaggedError("GitopsError")<{
  message: string;
  op: string;
}>() {}

export const SYS = { owner: "sys", name: "gitops" } as const;
export const TEMPLATE = { owner: "plat", name: "app-template" } as const;
export const SECRETS_PATH = "secrets.age.json";

async function run(argv: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(argv, {
    ...(cwd ? { cwd } : {}),
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if ((await proc.exited) !== 0) {
    throw new Error(
      `${argv.join(" ")} failed: ${await new Response(proc.stderr).text()}`,
    );
  }
}

// Commit files into a bare repo the boring way: temp clone → write → push.
// Local-path clones are milliseconds; correctness beats cleverness here.
export async function commitFiles(
  sd: StateDir,
  repo: { owner: string; name: string },
  files: Record<string, string | null>, // null = delete
  message: string,
): Promise<Result<void, GitopsError>> {
  return Result.tryPromise({
    try: async () => {
      const bare = repoPath(sd, repo.owner, repo.name);
      const work = await mkdtemp(join(tmpdir(), "op-gitops-"));
      try {
        await run(["git", "clone", "-q", bare, "work"], work);
        const dir = join(work, "work");
        for (const [path, content] of Object.entries(files)) {
          if (path.includes("..")) throw new Error(`path rejected: ${path}`);
          const abs = join(dir, path);
          if (content === null) {
            await rm(abs, { force: true, recursive: true });
          } else {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, content);
          }
        }
        await run(["git", "add", "-A"], dir);
        await run(
          [
            "git",
            "-c",
            "user.email=op@platform",
            "-c",
            "user.name=op",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            message,
          ],
          dir,
        );
        await run(["git", "push", "-q", "origin", "HEAD:main"], dir);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    catch: (cause) =>
      new GitopsError({ message: String(cause), op: "commitFiles" }),
  });
}

export async function readAppSpecs(
  git: GitHost,
  domain: string,
): Promise<Result<AppSpec[], GitopsError>> {
  return Result.tryPromise({
    try: async () => {
      const files = await git.listFiles(SYS.owner, SYS.name, "main");
      if (files.status === "error") throw files.error;
      const specs: AppSpec[] = [];
      for (const path of files.value) {
        if (!/^apps\/[^/]+\/[^/]+\/app\.json$/.test(path)) continue;
        const bytes = await git.readFile(SYS.owner, SYS.name, "main", path);
        if (bytes.status === "error") throw bytes.error;
        const admitted = admitSpec(
          JSON.parse(new TextDecoder().decode(bytes.value)),
          { domain },
        );
        // Fail closed per-spec: a bad spec is skipped (and surfaced by the
        // reconciler as an error status), never deployed in a degraded form.
        if (admitted.status === "ok") specs.push(admitted.value);
      }
      return specs;
    },
    catch: (cause) =>
      new GitopsError({ message: String(cause), op: "readAppSpecs" }),
  });
}

export async function readSecretsFile(
  git: GitHost,
): Promise<Result<SecretsFile, GitopsError>> {
  return Result.tryPromise({
    try: async () => {
      const bytes = await git.readFile(
        SYS.owner,
        SYS.name,
        "main",
        SECRETS_PATH,
      );
      if (bytes.status === "error") throw bytes.error;
      return JSON.parse(new TextDecoder().decode(bytes.value)) as SecretsFile;
    },
    catch: (cause) =>
      new GitopsError({ message: String(cause), op: "readSecretsFile" }),
  });
}

export function appSpecPath(owner: string, app: string): string {
  return `apps/${owner}/${app}/app.json`;
}
