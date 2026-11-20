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
 * We derive the scale factor from the output PNG pixel dimensions vs the
 * requested logical dimensions. `screencapture` writes native-resolution pixels
 * on Retina displays; dividing the PNG pixel width by the display's logical
 * width gives the effective scale factor without needing any native API call.
 *
 * @module desktop/backend.macos
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { DesktopBackendError } from './types.js';
import type { DesktopBackend, DesktopScreenshotInput, DesktopScreenshotResult } from './types.js';

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

class MacOsDesktopBackend implements DesktopBackend {
  async screenshot(
    input: DesktopScreenshotInput,
    sidecarPath: string,
  ): Promise<DesktopScreenshotResult> {
    const args = buildArgs(input, sidecarPath);
    const displayIndex = input.displayIndex ?? 0;

    try {
      await execFileAsync('screencapture', args, { timeout: 15_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
      const msg = err instanceof Error ? err.message : String(err);
      throw new DesktopBackendError(
        `screencapture ran but sidecar PNG is unreadable: ${msg}`,
        'CAPTURE_FAILED',
      );
    }

    const { width, height } = readPngDimensions(buf);

    // Derive logical dimensions from the region (if given) or assume the
    // physical dimensions equal the logical ones (scale = 1) when no region
    // is set, since we have no native API call to query display resolution here.
    // The Step 0M feasibility spike will confirm whether this assumption holds
    // and whether a resolution query is worth adding in a later tranche.
    const logicalWidth = input.region ? input.region.width : width;
    const logicalHeight = input.region ? input.region.height : height;
    const scaleFactor = logicalWidth > 0 ? width / logicalWidth : 1;

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
