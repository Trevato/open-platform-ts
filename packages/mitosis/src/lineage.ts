import { appendFile, readFile, writeFile } from "node:fs/promises";
import { Result } from "@op/core";
import { MitosisError } from "./seed.ts";

// Dumb on purpose: a plain-text family tree, one line per germination,
// readable and editable by humans forever. Ported from mitosis ORIGIN.
export async function recordLineage(
  originFile: string,
  entry: { domain: string; parentDomain: string; seedFile: string },
): Promise<Result<void, MitosisError>> {
  return Result.tryPromise({
    try: async () => {
      const exists = await Bun.file(originFile).exists();
      if (!exists) {
        await writeFile(originFile, "root: open-platform-ts\n");
      }
      const base = entry.seedFile.split("/").at(-1) ?? entry.seedFile;
      await appendFile(
        originFile,
        `${entry.domain} germinated-from ${entry.parentDomain} ${new Date().toISOString()} seed=${base}\n`,
      );
    },
    catch: (cause) =>
      new MitosisError({ message: String(cause), op: "recordLineage" }),
  });
}

export async function readLineage(originFile: string): Promise<string[]> {
  try {
    const text = await readFile(originFile, "utf8");
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
