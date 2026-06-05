/**
 * Debug logging utility - only logs when AFK_DEBUG=1 or DEBUG=1.
 * Env is read on every call so flags set at CLI startup take effect.
 * @module utils/debug
 */

import { env } from '../config/env.js';

/**
 * Whether debug mode is currently enabled. Read live from process.env so
 * that CLI flags setting the env var at runtime are honored.
 */
export function isDebugEnabled(): boolean {
  return env.AFK_DEBUG === '1' || env.DEBUG === '1';
}

/**
 * Log debug messages only when debug mode is enabled.
 * @param args - Arguments to pass to console.log
 */
export function debugLog(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(...args);
  }
}
