import { createRequire } from "node:module";
import pino from "pino";
import type { Logger as PinoLogger, LoggerOptions } from "pino";

const DEFAULT_LEVEL = "info";

const DEV_TRANSPORT = {
  target: "pino-pretty",
  options: {
    colorize: true,
    translateTime: "SYS:HH:MM:ss.l",
    ignore: "pid,hostname",
  },
};

// Pretty transport runs in a pino worker thread that resolves the target
// against the consumer's `node_modules`. When `pino-pretty` isn't installed
// (e.g. production install via `npx github:...`), pino crashes with
// "unable to determine transport target". Probe for it once at module load
// so we silently fall back to JSON output instead of blowing up.
function isPinoPrettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

const PRETTY_AVAILABLE = isPinoPrettyAvailable();

/**
 * Variadic logger surface used by `@larksuiteoapi/node-sdk`. The SDK's
 * default implementation just calls `console.log("[info]:", ...msg)`, which
 * collides with our structured pino output. We adapt it onto a
 * {@link LarkLogger} so SDK-internal messages flow through the same
 * formatter as everything else.
 */
export interface LarkSdkLogger {
  error(...msg: unknown[]): void;
  warn(...msg: unknown[]): void;
  info(...msg: unknown[]): void;
  debug(...msg: unknown[]): void;
  trace(...msg: unknown[]): void;
}

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

function buildOptions(level?: string): LoggerOptions {
  const resolved = level ?? process.env.LOG_LEVEL ?? DEFAULT_LEVEL;
  if (!PRETTY_AVAILABLE) {
    return { level: resolved };
  }
  return { level: resolved, transport: DEV_TRANSPORT };
}

/**
 * Create a default pino-backed {@link LarkLogger}.
 *
 * - When `pino-pretty` is resolvable (dev install): pretty-printed.
 * - Otherwise (production / `npx` install without devDeps): structured JSON.
 * - Level resolution: explicit arg → `LOG_LEVEL` env → `"info"`.
 */
export function createPinoLogger(level?: string): LarkLogger {
  return pino(buildOptions(level)) as unknown as LarkLogger;
}

/**
 * Adapt a {@link LarkLogger} to the variadic surface expected by
 * `@larksuiteoapi/node-sdk`. The SDK's internal `LoggerProxy` always invokes
 * the underlying logger with a single array argument carrying the original
 * variadic parts (see `node-sdk`'s `LoggerProxy`). We unwrap that one level
 * and stringify into a single `msg` so pino formats SDK chatter the same way
 * as our own logs (`name=lark-sdk` is kept as a child binding).
 */
export function adaptToSdkLogger(logger: LarkLogger): LarkSdkLogger {
  const flatten = (msg: readonly unknown[]): unknown[] =>
    msg.length === 1 && Array.isArray(msg[0]) ? msg[0] : [...msg];
  const join = (msg: readonly unknown[]): string =>
    flatten(msg)
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
      .join(" ");
  return {
    error: (...msg) => logger.error(join(msg)),
    warn: (...msg) => logger.warn(join(msg)),
    info: (...msg) => logger.info(join(msg)),
    debug: (...msg) => logger.debug(join(msg)),
    trace: (...msg) => logger.debug(join(msg)),
  };
}

export type { PinoLogger };
