/**
 * Closed-router credential rotation: shell out to `closed-router rotate --once
 * --json` on a subscription-limit 429 to rotate to a fresh OAuth account before
 * entering the multi-hour park loop.
 *
 * Gated behind `AFK_CLOSED_ROUTER=1`. When the env var is unset (the default),
 * this module exits immediately without spawning any subprocess — zero overhead
 * on the hot 429 path.
 *
 * Contract: never throws. All failures are caught and logged to stderr; the
 * caller always receives a typed result and falls through to the normal park
 * behavior on any non-success kind.
 *
 * @module agent/providers/anthropic-direct/query/closed-router-rotate
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { env } from '../../../../config/env.js';

const execFileAsync = promisify(execFile);

/** Kinds returned by `closed-router rotate --once --json`. */
export type ClosedRouterKind = 'rotated' | 'reset' | 'no-action' | 'all-hot' | 'error';

export type ClosedRouterResult =
  | { rotated: true;  kind: 'rotated' | 'reset' }
  | { rotated: false; kind: Exclude<ClosedRouterKind, 'rotated' | 'reset'> };

/** Cached PATH check: undefined = not yet resolved, null = not found. */
let _closedRouterOnPath: boolean | undefined;

function isClosedRouterOnPath(): boolean {
  if (_closedRouterOnPath !== undefined) return _closedRouterOnPath;
  // `which` is POSIX; closed-router targets macOS/Linux OAuth flows so this is fine.
  try {
    execFileSync('which', ['closed-router'], { stdio: 'ignore' });
    _closedRouterOnPath = true;
  } catch {
    _closedRouterOnPath = false;
  }
  return _closedRouterOnPath;
}

/**
 * Attempt a closed-router credential rotation.
 *
 * Returns `{ rotated: true, kind: 'rotated' | 'reset' }` when the rotation
 * succeeded and a fresh credential was written to the keychain. The caller
 * should invalidate its keychain read cache and replay the turn.
 *
 * Returns `{ rotated: false, kind: ... }` on `no-action`, `all-hot`, or any
 * error. The caller should fall through to the normal park behavior.
 */
export async function tryClosedRouterRotate(): Promise<ClosedRouterResult> {
  // Gate 1: env var must be explicitly enabled.
  if (env.AFK_CLOSED_ROUTER !== '1') {
    return { rotated: false, kind: 'no-action' };
  }

  // Gate 2: binary must be on PATH (cached after first check).
  if (!isClosedRouterOnPath()) {
    process.stderr.write(
      'agent-afk: AFK_CLOSED_ROUTER=1 but `closed-router` not found on PATH — skipping rotation.\n',
    );
    return { rotated: false, kind: 'error' };
  }

  try {
    const { stdout } = await execFileAsync(
      'closed-router',
      ['rotate', '--once', '--json'],
      { timeout: 10_000 },
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      process.stderr.write(
        `agent-afk: closed-router returned non-JSON output — skipping rotation.\n`,
      );
      return { rotated: false, kind: 'error' };
    }

    const kind =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['kind']
        : undefined;

    if (kind === 'rotated' || kind === 'reset') {
      return { rotated: true, kind };
    }
    if (kind === 'no-action' || kind === 'all-hot' || kind === 'error') {
      return { rotated: false, kind };
    }

    process.stderr.write(
      `agent-afk: closed-router returned unexpected kind ${JSON.stringify(kind)} — skipping rotation.\n`,
    );
    return { rotated: false, kind: 'error' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `agent-afk: closed-router rotate failed: ${msg} — skipping rotation.\n`,
    );
    return { rotated: false, kind: 'error' };
  }
}
