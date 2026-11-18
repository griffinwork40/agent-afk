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
import type { TraceSink } from '../../../trace/writer.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { promisify } from 'util';
import { env } from '../../../../config/env.js';

const execFileAsync = promisify(execFile);

/** Kinds returned by `closed-router rotate --once --json --on-limit`. */
export type ClosedRouterKind = 'rotated' | 'reset' | 'no-action' | 'all-hot' | 'error';

export type ClosedRouterResult =
  | { rotated: true;  kind: 'rotated' | 'reset' }
  | { rotated: false; kind: Exclude<ClosedRouterKind, 'rotated' | 'reset'> };

/** Cached PATH check: undefined = not yet resolved. Only a positive result is cached. */
let _closedRouterOnPath: boolean | undefined;

/** Reset the PATH cache — for test isolation only. */
export function _resetClosedRouterPathCache(): void {
  _closedRouterOnPath = undefined;
}

function isClosedRouterOnPath(): boolean {
  if (_closedRouterOnPath === true) return true;
  // `which` is POSIX; closed-router targets macOS/Linux OAuth flows so this is fine.
  try {
    execFileSync('which', ['closed-router'], { stdio: 'ignore' });
    _closedRouterOnPath = true;
  } catch {
    // Do NOT cache the negative result — leave undefined so the next call re-checks PATH.
  }
  return _closedRouterOnPath === true;
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
export async function tryClosedRouterRotate(
  traceWriter?: TraceSink,
  signal?: AbortSignal,
): Promise<ClosedRouterResult> {
  // Gate 1: env var must be explicitly enabled.
  if (env.AFK_CLOSED_ROUTER !== '1') {
    return { rotated: false, kind: 'no-action' };
  }

  // Gate 2: binary must be on PATH (only a positive result is cached).
  if (!isClosedRouterOnPath()) {
    void emitSessionPhase(traceWriter, {
      phase: 'closed_router_rotate',
      metadata: { kind: 'error', reason: 'binary-not-found' },
    });
    return { rotated: false, kind: 'error' };
  }

  try {
    const { stdout } = await execFileAsync(
      'closed-router',
      ['rotate', '--once', '--json', '--on-limit'],
      { signal, timeout: 10_000, maxBuffer: 64 * 1024 },
    );

    // Re-check abort after the subprocess returns: the rotation already wrote
    // to the shared keychain, but the caller should not replay on an aborted
    // signal — it will check isClosed() || signal.aborted and return early.
    if (signal?.aborted) {
      return { rotated: false, kind: 'no-action' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      void emitSessionPhase(traceWriter, {
        phase: 'closed_router_rotate',
        metadata: { kind: 'error', reason: 'non-json-output' },
      });
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

    void emitSessionPhase(traceWriter, {
      phase: 'closed_router_rotate',
      metadata: { kind: 'error', reason: 'unexpected-kind', receivedKind: JSON.stringify(kind) },
    });
    return { rotated: false, kind: 'error' };
  } catch (err) {
    // Log a fixed message + exit code — do NOT echo the raw child error message,
    // which may include child-process stderr and could contain credential material.
    const exitCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    void emitSessionPhase(traceWriter, {
      phase: 'closed_router_rotate',
      metadata: { kind: 'error', reason: 'subprocess-failed', ...(exitCode !== undefined ? { exitCode } : {}) },
    });
    return { rotated: false, kind: 'error' };
  }
}
