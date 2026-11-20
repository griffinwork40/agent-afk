/**
 * Windows screenshot backend — Tranche 1.
 *
 * # WARNING: NOT VERIFIED ON REAL WINDOWS HARDWARE
 * This backend is a proposal. It has not been run on a real Windows machine.
 * Step 0W (spec §4.3) is the acceptance gate: a consented test on real native
 * Windows hardware with a person present. Until Step 0W produces a written
 * verdict, this code makes no capability claim. Do not assert "Windows
 * screenshot works" based on this file alone.
 *
 * # Method
 * PowerShell child process, no compiled binary (Option W-A from spec §4.3).
 * Uses the .NET `System.Windows.Forms` / `System.Drawing` API to copy the
 * screen (or a region) to a PNG via a temporary file. PowerShell ships with
 * every supported Windows version.
 *
 * # Open questions (all deferred to Step 0W)
 * - Start-up latency per call; whether a persistent PowerShell child is needed.
 * - DPI awareness and multi-monitor coordinate mapping.
 * - Script execution policy, Constrained Language Mode, endpoint security
 *   software blocking the .NET API on managed machines.
 * - Whether a Windows daemon or Telegram service context can see the
 *   interactive desktop (service-context refusals are deferred — unknown until
 *   Step 0W; this backend does not assert service-context support).
 *
 * @module desktop/backend.windows
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { DesktopBackendError } from './types.js';
import type { DesktopBackend, DesktopScreenshotInput, DesktopScreenshotResult } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * PowerShell script that captures the requested display / region to a PNG.
 *
 * Contract: `__SIDECAR_PATH__`, `__DISPLAY_INDEX__`, `__USE_REGION__`,
 * `__X__`, `__Y__`, `__W__`, `__H__` are replaced with sanitized values
 * before the script is passed to PowerShell. All substituted values are
 * either numeric literals or a path validated by the caller — no shell
 * metacharacter injection is possible through template replacement on
 * those types.
 */
const CAPTURE_SCRIPT_TEMPLATE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = __DISPLAY_INDEX__
if ($idx -ge $screens.Length) { $idx = 0 }
$screen = $screens[$idx]
$useRegion = __USE_REGION__
if ($useRegion) {
  $x = __X__; $y = __Y__; $w = __W__; $h = __H__
  $bounds = [System.Drawing.Rectangle]::new($x, $y, $w, $h)
} else {
  $bounds = $screen.Bounds
}
$bmp = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save('__SIDECAR_PATH__', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "$($bounds.Width)x$($bounds.Height)"
`.trim();

/** Build the PowerShell capture script with concrete values substituted. */
function buildScript(input: DesktopScreenshotInput, sidecarPath: string): string {
  const displayIndex = input.displayIndex ?? 0;
  // Escape single quotes in the path by doubling them (PowerShell string rule).
  const escapedPath = sidecarPath.replace(/'/g, "''");
  const hasRegion = input.region !== undefined;

  let script = CAPTURE_SCRIPT_TEMPLATE
    .replace(/__SIDECAR_PATH__/g, escapedPath)
    .replace(/__DISPLAY_INDEX__/g, String(displayIndex))
    .replace(/__USE_REGION__/g, hasRegion ? '$true' : '$false');

  if (hasRegion && input.region) {
    const { x, y, width, height } = input.region;
    script = script
      .replace(/__X__/g, String(Math.round(x)))
      .replace(/__Y__/g, String(Math.round(y)))
      .replace(/__W__/g, String(Math.round(width)))
      .replace(/__H__/g, String(Math.round(height)));
  } else {
    // Replace placeholders with harmless zeros — the branch is never reached
    // when useRegion is $false.
    script = script
      .replace(/__X__|__Y__|__W__|__H__/g, '0');
  }

  return script;
}

/** Width of PNG in pixels, read from the IHDR chunk (bytes 16-23). */
function readPngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) throw new Error('PNG too short to read IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

class WindowsDesktopBackend implements DesktopBackend {
  async screenshot(
    input: DesktopScreenshotInput,
    sidecarPath: string,
  ): Promise<DesktopScreenshotResult> {
    const script = buildScript(input, sidecarPath);
    const displayIndex = input.displayIndex ?? 0;

    let stdout = '';
    try {
      const result = await execFileAsync(
        'powershell',
        ['-NonInteractive', '-NoProfile', '-Command', script],
        { timeout: 20_000 },
      );
      stdout = result.stdout.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UnauthorizedAccess') || msg.includes('Access is denied')) {
        throw new DesktopBackendError(
          'Windows denied access to the screen. Ensure this session runs in a ' +
          'native interactive terminal (not a Windows service context) and that ' +
          'no security policy blocks .NET screen capture.',
          'PERMISSION_DENIED',
        );
      }
      throw new DesktopBackendError(
        `PowerShell screen capture failed: ${msg}`,
        'CAPTURE_FAILED',
      );
    }

    let buf: Buffer;
    try {
      buf = await readFile(sidecarPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DesktopBackendError(
        `PowerShell ran but sidecar PNG is unreadable: ${msg}`,
        'CAPTURE_FAILED',
      );
    }

    const { width, height } = readPngDimensions(buf);

    // Try to parse logical dimensions from the script's stdout ("WxH").
    let logicalWidth = width;
    let logicalHeight = height;
    const match = /^(\d+)x(\d+)$/.exec(stdout);
    if (match) {
      logicalWidth = parseInt(match[1]!, 10);
      logicalHeight = parseInt(match[2]!, 10);
    }
    const scaleFactor = logicalWidth > 0 ? width / logicalWidth : 1;

    return {
      path: sidecarPath,
      bytes: buf.length,
      width,
      height,
      scaleFactor,
      displayIndex,
      logicalWidth,
      logicalHeight,
      dataBase64: buf.toString('base64'),
      mediaType: 'image/png',
    };
  }
}

export function createWindowsBackend(): DesktopBackend {
  return new WindowsDesktopBackend();
}
