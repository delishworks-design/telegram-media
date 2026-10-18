export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

// Keys whose values must never reach a log line.
const REDACT_KEYS =
  /(pass|secret|token|hash|otp|code|session|apihash|api_hash|authorization|cookie|key)/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}b]`;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? "[redacted]" : redactValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

export interface Logger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(level: LogLevel = "info", base: Record<string, unknown> = {}): Logger {
  const threshold = LEVELS[level];

  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] > threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...(base as Record<string, unknown>),
      ...(meta ? (redactValue(meta) as Record<string, unknown>) : {}),
    };
    const text = JSON.stringify(line);
    if (lvl === "error") process.stderr.write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
  };

  return {
    error: (m, meta) => emit("error", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    info: (m, meta) => emit("info", m, meta),
    debug: (m, meta) => emit("debug", m, meta),
    child: (bindings) => createLogger(level, { ...base, ...(redactValue(bindings) as object) }),
  };
}
