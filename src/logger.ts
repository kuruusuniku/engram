/**
 * Logger - Structured logging to stderr
 *
 * Outputs to stderr to avoid interfering with MCP stdio transport on stdout.
 * Supports configurable log levels and structured JSON output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoggerConfig {
  /** Minimum log level (default: "info") */
  level?: LogLevel;
  /** Output format: "json" for structured, "text" for human-readable (default: "text") */
  format?: "json" | "text";
  /** Whether logging is enabled (default: true) */
  enabled?: boolean;
}

class LoggerImpl {
  private level: LogLevel;
  private format: "json" | "text";
  private enabled: boolean;

  constructor(config?: LoggerConfig) {
    this.level = config?.level ?? ((process.env.MEMORY_LOG_LEVEL as LogLevel) || "info");
    this.format = config?.format ?? ((process.env.MEMORY_LOG_FORMAT as "json" | "text") || "text");
    this.enabled = config?.enabled ?? true;
  }

  configure(config: LoggerConfig): void {
    if (config.level !== undefined) this.level = config.level;
    if (config.format !== undefined) this.format = config.format;
    if (config.enabled !== undefined) this.enabled = config.enabled;
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.enabled) return false;
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private formatEntry(entry: LogEntry): string {
    if (this.format === "json") {
      return JSON.stringify(entry);
    }
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.module}] ${entry.message}${dataStr}`;
  }

  log(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      ...(data !== undefined && { data }),
    };

    const formatted = this.formatEntry(entry);
    process.stderr.write(formatted + "\n");
  }

  child(module: string): ModuleLogger {
    return new ModuleLogger(this, module);
  }
}

export class ModuleLogger {
  constructor(private parent: LoggerImpl, private module: string) {}

  debug(message: string, data?: Record<string, unknown>): void {
    this.parent.log("debug", this.module, message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.parent.log("info", this.module, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.parent.log("warn", this.module, message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.parent.log("error", this.module, message, data);
  }
}

/** Global logger instance */
export const logger = new LoggerImpl();

/**
 * Create a module-scoped logger
 */
export function createLogger(module: string): ModuleLogger {
  return logger.child(module);
}
