/**
 * Shared provider-acquisition preamble for the `desktop_*` tool handlers.
 *
 * Mirrors `browser-provider.ts` for the desktop tool group. Every desktop
 * handler needs:
 *   1. A validated `AFK_SESSION_ID` from env.
 *   2. The `AFK_DESKTOP_ENABLED` gate check.
 *   3. A resolved native `DesktopBackend` (or an injected test double).
 *
 * Lazy-load: the backend is resolved on first call, not at import time, so
 * sessions that never invoke a desktop tool pay zero runtime cost.
 *
 * @module agent/tools/handlers/desktop-provider
 */

import { env } from '../../../config/env.js';
import { isDesktopEnabled } from '../desktop-surface.js';
import { errorMessage } from '../../../utils/errors.js';
import { resolveNativeBackend } from '../../../desktop/platform.js';
import { DesktopBackendError } from '../../../desktop/types.js';
import type { DesktopBackend } from '../../../desktop/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options accepted by every `create*DesktopHandler()` factory. */
export interface DesktopHandlerOptions {
  /**
   * Inject a backend factory for tests without spawning a real screen capture
   * process. When set, skips `AFK_DESKTOP_ENABLED` check too (tests control
   * the gate explicitly by passing or not passing this option).
   */
  getBackend?: () => Promise<DesktopBackend>;
}

/** Successful result of `acquireDesktopBackend()`. */
export interface AcquiredDesktopBackend {
  ok: true;
  sessionId: string;
  backend: DesktopBackend;
}

/** Error result returned when acquisition fails. */
export interface AcquireDesktopError {
  ok: false;
  isError: true;
  content: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Setup instructions shown when `AFK_DESKTOP_ENABLED` is not set. */
export const DESKTOP_SETUP_INSTRUCTIONS =
  'Desktop tools are disabled. ' +
  'The operator enables them by setting AFK_DESKTOP_ENABLED in afk.env. ' +
  'On macOS, also grant Screen Recording permission to the terminal app ' +
  'in System Settings → Privacy & Security → Screen Recording. ' +
  'On Windows (not yet verified), run afk in a native interactive terminal (not WSL2).';

/**
 * Acquire the desktop backend for a tool handler call.
 *
 * Returns `AcquiredDesktopBackend` on success or `AcquireDesktopError` on
 * failure (capability disabled, platform unsupported, backend error).
 */
export async function acquireDesktopBackend(
  toolName: string,
  opts: DesktopHandlerOptions,
): Promise<AcquiredDesktopBackend | AcquireDesktopError> {
  // 1. Validate session id.
  const sessionId = env.AFK_SESSION_ID ?? 'default';
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return {
      ok: false,
      isError: true,
      content: `${toolName}: invalid AFK_SESSION_ID: must match /^[a-zA-Z0-9_-]+$/, got: ${JSON.stringify(sessionId)}`,
    };
  }

  // 2. Test injection path: skip the enabled gate and use the injected backend.
  if (opts.getBackend) {
    try {
      const backend = await opts.getBackend();
      return { ok: true, sessionId, backend };
    } catch (err) {
      return { ok: false, isError: true, content: `${toolName}: backend init failed: ${errorMessage(err)}` };
    }
  }

  // 3. Capability gate: refuse when AFK_DESKTOP_ENABLED is not set.
  if (!isDesktopEnabled()) {
    return { ok: false, isError: true, content: DESKTOP_SETUP_INSTRUCTIONS };
  }

  // 4. Resolve the native backend for this platform.
  let backend: DesktopBackend;
  try {
    backend = await resolveNativeBackend();
  } catch (err) {
    if (err instanceof DesktopBackendError) {
      return { ok: false, isError: true, content: err.message };
    }
    return { ok: false, isError: true, content: `${toolName}: failed to get desktop backend: ${errorMessage(err)}` };
  }

  return { ok: true, sessionId, backend };
}
