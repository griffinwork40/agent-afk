/**
 * Real-PowerShell test for the Windows desktop backend. No mocks.
 *
 * `backend.windows.test.ts` mocks the child process, so it cannot tell whether
 * the capture script runs on Windows at all. This file runs the real script on
 * win32 and checks the PNG it leaves on disk. CI executes it on the
 * `windows-2022` shards; on macOS and Linux it reports as skipped.
 *
 * The platform gate is declared in `.posix-guard-baseline.json` (rule R4).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as fs from 'node:fs/promises';

import { createWindowsBackend } from './backend.windows.js';
import { DesktopBackendError } from './types.js';
import type { DesktopScreenshotAborted, DesktopScreenshotResult } from './types.js';

const PNG_SIGNATURE_HEX = '89504e470d0a1a0a';

// Above the backend's own 20s child timeout, so a slow or hung PowerShell is
// reported by the backend's error (which carries stderr) and not by vitest.
const TEST_TIMEOUT_MS = 60_000;

function headHex(buf: Buffer, n = 16): string {
  return buf.subarray(0, n).toString('hex');
}

let sidecarDir: string | undefined;

afterEach(async () => {
  if (sidecarDir !== undefined) {
    await fs.rm(sidecarDir, { recursive: true, force: true });
    sidecarDir = undefined;
  }
});

/** Run the real capture; on failure, rethrow with everything needed to diagnose it from one CI log. */
async function captureOrExplain(sidecarPath: string): Promise<DesktopScreenshotResult | DesktopScreenshotAborted> {
  try {
    return await createWindowsBackend().screenshot({ displayIndex: 0 }, sidecarPath);
  } catch (err) {
    const code = err instanceof DesktopBackendError ? err.code : 'NOT_A_BACKEND_ERROR';
    // The backend's message embeds Node's execFile message, which carries the
    // command line and PowerShell's stderr.
    const message = err instanceof Error ? err.message : String(err);
    const leftover = await fs.readFile(sidecarPath).then(
      (buf) => `present, ${buf.length} bytes, head ${headHex(buf)}`,
      () => 'absent',
    );
    throw new Error(
      `Real Windows capture failed (code=${code}).\n` +
        `Backend message (includes PowerShell stderr):\n${message}\n` +
        `Sidecar after failure: ${leftover}\n` +
        `If this is a hosted CI runner, the likely cause is no capturable desktop session.`,
    );
  }
}

describe('Windows backend, real PowerShell capture', () => {
  it.runIf(process.platform === 'win32')(
    'captures display 0 to a PNG whose bytes and dimensions match the reported result',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      sidecarDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'afk-desktop-win-'));
      const sidecarPath = nodePath.join(sidecarDir, 'capture.png');

      const result = await captureOrExplain(sidecarPath);
      if ('aborted' in result) {
        throw new Error(`Capture reported aborted with no signal passed: ${result.reason}`);
      }

      const summary =
        `width=${result.width} height=${result.height} bytes=${result.bytes} ` +
        `displayIndex=${result.displayIndex} logical=${result.logicalWidth}x${result.logicalHeight} ` +
        `scaleFactor=${String(result.scaleFactor)}`;
      // Printed on success too: the first green run is the only record of what
      // a hosted Windows runner actually reports.
      console.log(`[desktop win32 real capture] ${summary}`);

      expect(result.width, summary).toBeGreaterThan(0);
      expect(result.height, summary).toBeGreaterThan(0);
      expect(result.mediaType).toBe('image/png');
      expect(result.displayIndex).toBe(0);
      expect(result.path).toBe(sidecarPath);

      const onDisk = await fs.readFile(sidecarPath);
      expect(headHex(onDisk, 8), `sidecar head ${headHex(onDisk)}, ${onDisk.length} bytes`).toBe(PNG_SIGNATURE_HEX);
      expect(onDisk.length, 'bytes on disk vs reported bytes').toBe(result.bytes);
      expect(onDisk.readUInt32BE(16), 'PNG IHDR width vs reported width').toBe(result.width);
      expect(onDisk.readUInt32BE(20), 'PNG IHDR height vs reported height').toBe(result.height);
      expect(Buffer.from(result.dataBase64, 'base64').equals(onDisk), 'dataBase64 round-trips to the sidecar bytes').toBe(true);
    },
  );
});
