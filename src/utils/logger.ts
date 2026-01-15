/**
 * Simple structured logger with level-based filtering.
 *
 * Log level can be controlled via:
 * 1. Configuration file (logLevel field in pairs.json)
 * 2. LOG_LEVEL environment variable (overrides config file)
 * 3. Programmatically via setLogLevel() function
 *
 * Levels (in order of verbosity):
 * - debug: Detailed diagnostic information (recommended for troubleshooting)
 * - info: General informational messages (default)
 * - warn: Warning messages for recoverable issues
 * - error: Error messages for failures
 */

/** Available log levels */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Numeric weights for log levels (higher = more severe).
 * Used for filtering based on minimum level.
 */
const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Current log level state (mutable, can be changed at runtime)
let currentLogLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";
let minWeight = levelWeights[currentLogLevel] ?? levelWeights.info;

/**
 * Sets the minimum log level for filtering.
 * Call this early in application startup with the config file value.
 *
 * @param level - New minimum log level
 */
export function setLogLevel(level: LogLevel): void {
  if (levelWeights[level] === undefined) {
    // eslint-disable-next-line no-console
    console.warn(`Invalid log level: ${level}, keeping current level: ${currentLogLevel}`);
    return;
  }
  currentLogLevel = level;
  minWeight = levelWeights[level];
}

/**
 * Gets the current log level.
 */
export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

/**
 * Core logging function that filters by level and writes to console.
 *
 * @param level - Log level
 * @param message - Log message
 * @param meta - Optional structured metadata to include in log
 */
function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  // Filter out logs below the minimum level
  if (levelWeights[level] < minWeight) {
    return;
  }

  const time = new Date().toISOString();
  const payload = meta && Object.keys(meta).length > 0 ? { message, ...meta } : { message };

  // Use console.log for debug, otherwise use level-specific console method
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](`[${time}] [${level.toUpperCase()}]`, payload);
}

/**
 * Singleton logger instance with level-specific methods.
 */
export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
};

/** Type alias for the logger interface (useful for dependency injection) */
export type Logger = typeof logger;
