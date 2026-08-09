/**
 * Option resolution for `afk web`.
 *
 * Contract: precedence is flag → env → default, matching daemon-options.ts.
 * These are pure functions so the precedence rules are unit-testable without
 * starting a server.
 */

import { env } from '../config/env.js';
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT } from '../web-server/server.js';

export { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT };

/** Resolve the listen port. Invalid values fall back to the default. */
export function resolveWebPort(flag?: string | number): number {
  const fromFlag = coercePort(flag);
  if (fromFlag !== undefined) return fromFlag;
  const fromEnv = coercePort(env.AFK_WEB_PORT);
  if (fromEnv !== undefined) return fromEnv;
  return DEFAULT_WEB_PORT;
}

/** Resolve the bind host. */
export function resolveWebHost(flag?: string): string {
  const trimmedFlag = flag?.trim();
  if (trimmedFlag) return trimmedFlag;
  const fromEnv = env.AFK_WEB_HOST?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_WEB_HOST;
}

/**
 * Resolve the bearer token, and report whether it was EXPLICIT.
 *
 * Invariant: explicitness is load-bearing, not cosmetic — the server refuses a
 * non-loopback bind unless the operator deliberately supplied a token. An
 * auto-minted token must therefore never be reported as explicit.
 */
export function resolveWebToken(flag?: string): { token?: string; explicit: boolean } {
  const trimmedFlag = flag?.trim();
  if (trimmedFlag) return { token: trimmedFlag, explicit: true };
  const fromEnv = env.AFK_WEB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, explicit: true };
  return { explicit: false };
}

function coercePort(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined;
  return n;
}
