import pino from "pino";
import type { Logger as PinoLogger, LoggerOptions } from "pino";

const DEFAULT_LEVEL = "info";
const PRODUCTION_NODE_ENV = "production";

const DEV_TRANSPORT = {
  target: "pino-pretty",
  options: {
    colorize: true,
    translateTime: "SYS:HH:MM:ss.l",
    ignore: "pid,hostname",
  },
};

/**
 * Minimal structured logger interface used throughout `lark-acp`.
 *
 * Compatible with pino but intentionally narrower so callers can plug in
 * any structured logger (winston, bunyan, custom) without dragging in
 * pino's full surface area.
 *
 * Each method accepts either a message string or an object of structured
 * fields followed by an optional message — matching pino's calling
 * convention.
 */
export interface LarkLogger {
  debug(msg: string): void;
  debug(obj: object, msg?: string): void;

  info(msg: string): void;
  info(obj: object, msg?: string): void;

  warn(msg: string): void;
  warn(obj: object, msg?: string): void;

  error(msg: string): void;
  error(obj: object, msg?: string): void;

  /**
   * Return a child logger with `bindings` merged into every record.
   * `bindings.name` is conventional for naming a subsystem scope.
   */
  child(bindings: { name: string } & Record<string, unknown>): LarkLogger;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === PRODUCTION_NODE_ENV;
}

function buildOptions(level?: string): LoggerOptions {
  const resolved = level ?? process.env.LOG_LEVEL ?? DEFAULT_LEVEL;
  if (isProduction()) {
    return { level: resolved };
  }
  return { level: resolved, transport: DEV_TRANSPORT };
}

/**
 * Create a default pino-backed {@link LarkLogger}.
 *
 * - Development (NODE_ENV !== "production"): pretty-printed via pino-pretty.
 * - Production: structured JSON.
 * - Level resolution: explicit arg → `LOG_LEVEL` env → `"info"`.
 */
export function createPinoLogger(level?: string): LarkLogger {
  return pino(buildOptions(level)) as unknown as LarkLogger;
}

export type { PinoLogger };
