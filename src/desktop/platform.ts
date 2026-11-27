/**
 * Platform detection and backend factory for desktop tools.
 *
 * Invariant: this module is the ONLY place that reads platform-detection env
 * vars for desktop capability routing. All callers go through
 * `resolveNativeBackend()`. Tests inject a mock via `DesktopProviderOptions`.
 *
 * Platform support matrix (Tranche 1):
 *   - darwin  → macOS backend (`screencapture`)
 *   - win32   → Windows backend (PowerShell/.NET) — UNVERIFIED, see Step 0W
 *   - linux   → Refused: "Linux desktop tools are not supported in v1."
 *   - WSL2    → Refused: "Desktop tools require native Windows. Run afk in a
 *               native Windows interactive terminal, not WSL2."
 *
 * WSL2 detection: on WSL2, `process.platform` is `linux` AND the environment
 * carries `WSL_DISTRO_NAME` or `WSL_INTEROP`. Both vars are read through
 * `env` (the single process.env read-point) rather than raw `process.env`.
 *
 * @module desktop/platform
 */

import { env } from '../config/env.js';
import { DesktopBackendError } from './types.js';
import type { DesktopBackend } from './types.js';

/** Detect whether the current process is running inside WSL2. */
export function isWsl2(): boolean {
  // WSL2 sets at least one of these vars; bare Linux does not.
  return (
    env.WSL_DISTRO_NAME !== undefined ||
    env.WSL_INTEROP !== undefined
  );
}

/**
 * Resolve the native backend for the current platform, or throw a
 * `DesktopBackendError` with a clear message if the platform is unsupported.
 *
 * Lazy imports keep the platform-specific modules out of cold-start code paths
 * on operating systems where they are never used.
 */
export async function resolveNativeBackend(): Promise<DesktopBackend> {
  if (process.platform === 'linux') {
    if (isWsl2()) {
      throw new DesktopBackendError(
        'Desktop tools require native Windows. ' +
        'Run afk in a native Windows interactive terminal, not WSL2.',
        'UNSUPPORTED_PLATFORM',
      );
    }
    throw new DesktopBackendError(
      'Desktop tools are not supported on Linux in v1. ' +
      'macOS is supported; native Windows is not yet verified (Step 0W pending).',
      'UNSUPPORTED_PLATFORM',
    );
  }

  if (process.platform === 'darwin') {
    const { createMacOsBackend } = await import('./backend.macos.js');
    return createMacOsBackend();
  }

  if (process.platform === 'win32') {
    const { createWindowsBackend } = await import('./backend.windows.js');
    return createWindowsBackend();
  }

  throw new DesktopBackendError(
    `Desktop tools are not supported on platform "${process.platform}". ` +
    'macOS is supported; native Windows is not yet verified (Step 0W pending).',
    'UNSUPPORTED_PLATFORM',
  );
}
