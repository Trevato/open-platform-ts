export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let threshold: number =
  LEVELS[(process.env["OP_LOG_LEVEL"] as LogLevel) ?? "info"] ?? 20;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

export interface Log {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLog(component: string): Log {
  const emit = (
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVELS[level] < threshold) return;
    const ts = new Date().toISOString().slice(11, 23);
    const extra =
      fields && Object.keys(fields).length > 0
        ? ` ${JSON.stringify(fields)}`
        : "";
    process.stderr.write(
      `${ts} ${level.padEnd(5)} ${component} ${msg}${extra}\n`,
    );
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
