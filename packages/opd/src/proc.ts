export async function run(argv: string[], cwd?: string): Promise<void> {
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
