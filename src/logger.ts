/**
 * Unified logger for the IMA Sync plugin.
 *
 * - Keeps a single source of truth for the log prefix.
 * - Separates "user-facing" and "debug-only" log levels so we don't spam the
 *   devtools console when the plugin runs normally (Obsidian review guideline
 *   discourages chatty console output in production).
 */

const LOG_PREFIX = "[ima-sync]";

export function logDebug(...args: unknown[]): void {
  // Intentionally use console.debug so it's hidden unless users opt-in to the
  // "Verbose" log level in their devtools.
  console.debug(LOG_PREFIX, ...args);
}

export function logWarn(...args: unknown[]): void {
  console.warn(LOG_PREFIX, ...args);
}

export function logError(...args: unknown[]): void {
  console.error(LOG_PREFIX, ...args);
}

export { LOG_PREFIX };
