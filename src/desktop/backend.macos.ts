/**
 * macOS screenshot backend — Tranche 1.
 *
 * Uses the system `screencapture` binary (present on every macOS install).
 * Flags used: `-x` (no sound), `-D <n>` (display index, 1-based for
 * screencapture), `-R <x,y,w,h>` (region), output path as positional arg.
 *
 * # What is NOT claimed here
 * - That `screencapture` will succeed on every Mac in every context. The
 *   responsible process must hold Screen Recording permission. The Step 0M
 *   feasibility spike (see spec §4.1) produces the written verdict. This
 *   code implements the method; Step 0M tests it on real hardware.
 * - That a locked-screen capture is possible. DP1 answer: ship a clean refusal
 *   ("locked-use: unsupported in v1"). Detecting a locked screen reliably would
 *   require a method we can justify and unit-test; none was found during
 *   Tranche 1 research, so the check is left out per the owner's instruction.
 *
 * # Scale factor
 * For a region capture: derived from (captured PNG pixel width) / (region
 * logical width). This is exact.
 *
 * For a full-display capture: queried via `system_profiler SPDisplaysDataType
 * -json`, which is available on every macOS version we target, requires no
 * permission prompt, and reports `_spdisplays_pixels` (physical pixels) and
 * `_spdisplays_resolution` (logical pixels). When the query returns a usable
 * result for the requested display, the scale is computed from those values;
 * when it does not (unexpected output shape, display not found, spawn error),
 * the result carries `scaleFactor: null` rather than a silently wrong value.
 *
 * # File permissions
 * The sidecar PNG is written by `screencapture` directly. After a successful
 * capture we chmod it to 0o600 (owner-read/write, nothing else). The
 * screenshots directory is created with mode 0o700 by the handler, not here.
 *
 * @module desktop/backend.macos
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, chmod } from 'node:fs/promises';
import { DesktopBackendError } from './types.js';
import type {
  DesktopBackend,
  DesktopScreenshotInput,
  DesktopScreenshotResult,
  DesktopScreenshotAborted,
} from './types.js';

const execFileAsync = promisify(execFile);

/** Width of PNG in pixels, read from the IHDR chunk (bytes 16-23). */
function readPngDimensions(buf: Buffer): { width: number; height: number } {
  // PNG signature (8) + IHDR length (4) + 'IHDR' (4) = 16 bytes before width
  if (buf.length < 24) throw new Error('PNG too short to read IHDR');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

/**
 * Build the `screencapture` argument list.
 *
 * Contract: Invariant: a sidecarPath containing shell-special characters would
 * break the argument list. execFile passes args as an array, NOT via a shell,
 * so the path is safe as-is — no shell injection is possible.
 */
function buildArgs(
  input: DesktopScreenshotInput,
  sidecarPath: string,
): string[] {
  const args: string[] = [
    '-x',    // No screenshot sound
    '-t', 'png',  // Force PNG output
  ];

  // screencapture uses 1-based display index; our interface uses 0-based.
  const displayIndex = input.displayIndex ?? 0;
  args.push('-D', String(displayIndex + 1));

  if (input.region) {
    const { x, y, width, height } = input.region;
    args.push('-R', `${x},${y},${width},${height}`);
  }

  args.push(sidecarPath);
  return args;
}

/**
 * Query the logical and physical pixel dimensions of a display using
 * `system_profiler SPDisplaysDataType -json`. No permission prompt is required.
 *
 * Returns `{ logicalW, logicalH, physicalW, physicalH }` for the given
 * zero-based display index, or `null` when the query cannot determine the
 * values (unexpected output format, display index out of range, spawn error).
 */
async function queryDisplayDimensions(
  displayIndex: number,
): Promise<{ logicalW: number; logicalH: number; physicalW: number; physicalH: number } | null> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      'system_profiler',
      ['SPDisplaysDataType', '-json'],
      { timeout: 5_000 },
    );
    stdout = result.stdout;
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  const dataType = root['SPDisplaysDataType'];
  if (!Array.isArray(dataType)) return null;

  // Collect all display entries from all adapters.
  const displays: Record<string, unknown>[] = [];
  for (const adapter of dataType) {
    if (!adapter || typeof adapter !== 'object') continue;
    const ndrvs = (adapter as Record<string, unknown>)['spdisplays_ndrvs'];
    if (!Array.isArray(ndrvs)) continue;
    for (const disp of ndrvs) {
      if (disp && typeof disp === 'object') {
        displays.push(disp as Record<string, unknown>);
      }
    }
  }

  const disp = displays[displayIndex];
  if (!disp) return null;

  // `_spdisplays_pixels` = "3456 x 2234" (physical pixels)
  // `_spdisplays_resolution` = "1728 x 1117 @ 120.00Hz" (logical pixels)
  const physStr = typeof disp['_spdisplays_pixels'] === 'string' ? disp['_spdisplays_pixels'] as string : null;
  const logStr = typeof disp['_spdisplays_resolution'] === 'string' ? disp['_spdisplays_resolution'] as string : null;
  if (!physStr || !logStr) return null;

  const physMatch = /^(\d+)\s*x\s*(\d+)$/.exec(physStr.trim());
  const logMatch = /^(\d+)\s*x\s*(\d+)/.exec(logStr.trim());
  if (!physMatch || !logMatch) return null;

  return {
    physicalW: parseInt(physMatch[1]!, 10),
    physicalH: parseInt(physMatch[2]!, 10),
    logicalW: parseInt(logMatch[1]!, 10),
    logicalH: parseInt(logMatch[2]!, 10),
  };
}

class MacOsDesktopBackend implements DesktopBackend {
  async screenshot(
    input: DesktopScreenshotInput,
    sidecarPath: string,
  ): Promise<DesktopScreenshotResult | DesktopScreenshotAborted> {
    // Check the signal before spawning anything.
    if (input.signal?.aborted) {
      return { aborted: true, reason: String(input.signal.reason ?? 'aborted') };
    }

    const args = buildArgs(input, sidecarPath);
    const displayIndex = input.displayIndex ?? 0;

    try {
      await execFileAsync('screencapture', args, {
        timeout: 15_000,
        signal: input.signal,
      });
    } catch (err) {
      // Check abort first — the signal fires inside execFile as an AbortError.
      if (input.signal?.aborted) {
        await unlink(sidecarPath).catch(() => undefined);
        return { aborted: true, reason: String(input.signal.reason ?? 'aborted') };
      }
      const msg = err instanceof Error ? err.message : String(err);
      await unlink(sidecarPath).catch(() => undefined);
      if (msg.includes('permission') || msg.includes('not permitted') || msg.includes('1001')) {
        throw new DesktopBackendError(
          'macOS Screen Recording permission is required. ' +
          'Grant it in System Settings → Privacy & Security → Screen Recording ' +
          'to the app responsible for this terminal session, then retry.',
          'PERMISSION_DENIED',
        );
      }
      throw new DesktopBackendError(
        `screencapture failed: ${msg}`,
        'CAPTURE_FAILED',
      );
    }

    // Read the PNG back from disk.
    let buf: Buffer;
    try {
      buf = await readFile(sidecarPath);
    } catch (err) {
      await unlink(sidecarPath).catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      throw new DesktopBackendError(
        `screencapture ran but sidecar PNG is unreadable: ${msg}`,
        'CAPTURE_FAILED',
      );
    }

    if (buf.length < 24) {
      await unlink(sidecarPath).catch(() => undefined);
      throw new DesktopBackendError(
        'screencapture produced an empty or truncated PNG (fewer than 24 bytes). ' +
        'The process may lack Screen Recording permission.',
        'CAPTURE_FAILED',
      );
    }

    // Restrict permissions: owner-only read/write (harmless no-op on Windows).
    await chmod(sidecarPath, 0o600).catch(() => undefined);

    const { width, height } = readPngDimensions(buf);

    // Derive scale factor:
    //   - Region capture: exact from (PNG pixels) / (region logical pixels).
    //   - Full-display capture: query system_profiler; null when unavailable.
    let logicalWidth: number;
    let logicalHeight: number;
    let scaleFactor: number | null;

    if (input.region) {
      logicalWidth = input.region.width;
      logicalHeight = input.region.height;
      scaleFactor = logicalWidth > 0 ? width / logicalWidth : null;
    } else {
      const dims = await queryDisplayDimensions(displayIndex);
      if (dims && dims.logicalW > 0) {
        logicalWidth = dims.logicalW;
        logicalHeight = dims.logicalH;
        scaleFactor = dims.physicalW / dims.logicalW;
      } else {
        // Cannot determine logical dimensions without system_profiler data.
        // Report physical pixels as logical and scaleFactor as null so the
        // caller knows this is unresolved, not assumed.
        logicalWidth = width;
        logicalHeight = height;
        scaleFactor = null;
      }
    }

    const dataBase64 = buf.toString('base64');

    return {
      path: sidecarPath,
      bytes: buf.length,
      width,
      height,
      scaleFactor,
      displayIndex,
      logicalWidth,
      logicalHeight,
      dataBase64,
      mediaType: 'image/png',
    };
  }
}

export function createMacOsBackend(): DesktopBackend {
  return new MacOsDesktopBackend();
}
