/**
 * Instance-aware logger factory for multi-pair copy trading.
 *
 * Creates logger instances that prefix all messages with a pair ID,
 * making it easy to distinguish logs from different copy trading pairs.
 */

import { logger, type Logger } from "./logger.js";

/**
 * Creates a logger instance that prefixes all messages with the pair ID.
 *
 * Example output:
 * [2026-01-15T10:30:00.000Z] [INFO] [smart-whale-1] Leader fill detected: BTC +0.5
 * [2026-01-15T10:30:00.100Z] [INFO] [smart-whale-2] Skipping historical position: ETH
 *
 * @param instanceId - Unique identifier for the copy trading pair
 * @param baseLogger - Base logger to wrap (defaults to global logger)
 * @returns Logger instance with prefixed messages
 */
export function createInstanceLogger(instanceId: string, baseLogger: Logger = logger): Logger {
  const prefix = `[${instanceId}]`;

  return {
    debug: (message: string, meta?: Record<string, unknown>) => {
      baseLogger.debug(`${prefix} ${message}`, meta);
    },
    info: (message: string, meta?: Record<string, unknown>) => {
      baseLogger.info(`${prefix} ${message}`, meta);
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      baseLogger.warn(`${prefix} ${message}`, meta);
    },
    error: (message: string, meta?: Record<string, unknown>) => {
      baseLogger.error(`${prefix} ${message}`, meta);
    },
  };
}

/**
 * Creates a child logger that adds additional context to all messages.
 *
 * Useful for creating sub-component loggers within a pair instance.
 *
 * @param parentLogger - Parent logger to extend
 * @param context - Additional context key-value pairs to include
 * @returns Logger with merged context
 */
export function createContextLogger(
  parentLogger: Logger,
  context: Record<string, unknown>,
): Logger {
  const mergeContext = (meta?: Record<string, unknown>) => ({
    ...context,
    ...meta,
  });

  return {
    debug: (message: string, meta?: Record<string, unknown>) => {
      parentLogger.debug(message, mergeContext(meta));
    },
    info: (message: string, meta?: Record<string, unknown>) => {
      parentLogger.info(message, mergeContext(meta));
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      parentLogger.warn(message, mergeContext(meta));
    },
    error: (message: string, meta?: Record<string, unknown>) => {
      parentLogger.error(message, mergeContext(meta));
    },
  };
}
