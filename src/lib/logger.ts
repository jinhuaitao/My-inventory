// 结构化日志 —— 对应原 Go 版的 log/slog（生产 JSON、开发文本）。

import type { Config } from "../env";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function normalizeLevel(raw: string): LogLevel {
  const s = raw.toLowerCase();
  if (s === "debug" || s === "warn" || s === "warning" || s === "error") {
    return s === "warning" ? "warn" : (s as LogLevel);
  }
  return "info";
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly threshold: number,
    private readonly base: Record<string, unknown> = {},
  ) {}

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < this.threshold) return;
    const payload = { level, msg, ...this.base, ...(fields ?? {}) };
    const line = JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  debug(msg: string, fields?: Record<string, unknown>) {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>) {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.emit("error", msg, fields);
  }
  child(fields: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.threshold, { ...this.base, ...fields });
  }
}

/** 依据配置创建日志器。 */
export function newLogger(cfg: Config): Logger {
  return new ConsoleLogger(LEVELS[normalizeLevel(cfg.logLevel)]);
}

/** 无操作日志器（供离线脚本 / 测试使用）。 */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
