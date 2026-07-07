// Turn the agent's stream-json into occasional human-readable progress lines
// for the issue feed. Throttled so a burst of tool calls doesn't spam. The
// console classifies these: a leading tool name → a collapsed tool block, prose
// → narration. Emitting `<Tool> <command/file>` keeps each row informative.

interface ToolInput {
  command?: string;
  file_path?: string;
  pattern?: string;
  url?: string;
}

function toolDetail(name: string, input?: ToolInput): string {
  if (!input) return "";
  if (name === "Bash")
    return String(input.command ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 80);
  if (
    name === "Read" ||
    name === "Write" ||
    name === "Edit" ||
    name === "MultiEdit"
  )
    return (
      String(input.file_path ?? "")
        .split("/")
        .pop() ?? ""
    );
  if (name === "Grep" || name === "Glob")
    return String(input.pattern ?? "").slice(0, 60);
  if (name === "WebFetch") return String(input.url ?? "").slice(0, 60);
  return "";
}

export function makeHeartbeat(
  emit: (line: string) => void,
): (line: string) => void {
  let lastEmit = 0;
  return (line) => {
    try {
      const msg = JSON.parse(line) as {
        type?: string;
        message?: {
          content?: Array<{
            type?: string;
            text?: string;
            name?: string;
            input?: ToolInput;
          }>;
        };
      };
      if (msg.type !== "assistant" || !msg.message?.content) return;
      const now = Date.now();
      if (now - lastEmit < 18_000) return; // throttle
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          emit(`… ${block.text.trim().slice(0, 140).replace(/\s+/g, " ")}`);
          lastEmit = now;
          return;
        }
        if (block.type === "tool_use" && block.name) {
          const detail = toolDetail(block.name, block.input);
          emit(`… ${block.name}${detail ? ` ${detail}` : ""}`);
          lastEmit = now;
          return;
        }
      }
    } catch {
      /* ignore */
    }
  };
}
