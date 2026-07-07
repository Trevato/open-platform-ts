import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "@op/core";
import { CrewError } from "./runner.ts";

// Agent-as-directory (the one convention worth taking from eve): an agent role
// is a directory — instructions.md is the system prompt, skills/*.md are
// procedures loaded on demand. Versioned in git, forkable, seed-carried.
export interface AgentDef {
  role: string;
  instructions: string;
  skills: string[];
}

export async function loadAgent(
  crewDir: string,
  role: string,
): Promise<Result<AgentDef, CrewError>> {
  return Result.tryPromise({
    try: async () => {
      const dir = join(crewDir, role);
      const instructions = await readFile(join(dir, "instructions.md"), "utf8");
      let skills: string[] = [];
      try {
        const skillDir = join(dir, "skills");
        const files = await readdir(skillDir);
        skills = await Promise.all(
          files
            .filter((f) => f.endsWith(".md"))
            .map((f) => readFile(join(skillDir, f), "utf8")),
        );
      } catch {
        /* skills are optional */
      }
      return { role, instructions, skills };
    },
    catch: (cause) =>
      new CrewError({ message: String(cause), op: "loadAgent" }),
  });
}
