/**
 * Linux clipboard image reader — Wayland (wl-paste) and X11 (xclip) support.
 *
 * Extracted from clipboard-image.ts to keep that file under the 350-line
 * source ceiling. All Linux-specific logic lives here; the macOS path (osascript
 * / sips) stays in clipboard-image.ts.
 *
 * Strategy:
 *   1. Probe for `wl-paste` (Wayland-native) first.
 *   2. Fall back to `xclip` (X11 / XWayland) if wl-paste is absent.
 *   3. If neither tool is installed, return null (graceful no-op — user
 *      simply doesn't get clipboard-image paste on this system).
 *
 * Both tools are asked for `image/png` directly via MIME-type flags:
 *   wl-paste --type image/png --no-newline
 *   xclip    -selection clipboard -t image/png -o
 *
 * Magic-byte validation is shared with the macOS path via the caller.
 *
 * @module cli/input/clipboard-image-linux
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ImageAttachment } from './attachments.js';

/**
 * When AFK_DEBUG_CLIPBOARD=1, structured diagnostic messages are written to
 * stderr at each probe stage. Zero overhead when unset. Mirrors the pattern in
 * clipboard-image.ts — evaluated at module load so re-import is required to
 * toggle within a test (identical to the macOS module's behaviour).
 */
// Using dynamic env read rather than importing env.ts to avoid a circular dep
// through config → paths. The clipboard module already accesses env this way.
const DEBUG = !!(process.env['AFK_DEBUG_CLIPBOARD']);

function dbg(msg: string): void {
  process.stderr.write(`[afk-clipboard] ${msg}\n`);
}

/**
 * Check whether a command is available on PATH by attempting a version-style
 * probe via `spawn`. Returns true if the binary exists and can be exec'd; false
 * on ENOENT / EACCES. A non-zero exit code still proves the binary is present
 * (some tools like `wl-paste --version` exit 1 on certain distros).
 *
 * Uses `spawn` (not `execFile`) so the same mock used in clipboard-image.test.ts
 * (`vi.mock('child_process', () => ({ spawn: vi.fn() }))`) covers this probe
 * without extra mock plumbing.
 */
export function isCommandAvailable(cmd: string, args: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve(code !== 'ENOENT' && code !== 'EACCES');
    });
    child.on('close', () => resolve(true));
  });
}

/**
 * Spawn a clipboard reader tool and collect its stdout as a Buffer.
 * Returns null if the command exits non-zero or produces no bytes.
 */
export function linuxClipboardRead(cmd: string, args: string[]): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) { resolve(null); return; }
      const buf = Buffer.concat(chunks);
      resolve(buf.length > 0 ? buf : null);
    });
  });
}

/**
 * Detect image format by inspecting magic bytes at buffer start.
 * Subset of formats the Anthropic API accepts.
 */
export function detectMediaTypeLinux(
  buffer: Buffer,
): ImageAttachment['mediaType'] | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Read image data from the Linux clipboard.
 *
 * Probes for wl-paste (Wayland) first, then xclip (X11). Graceful no-op when
 * neither tool is installed or the clipboard holds no image data.
 */
export async function readClipboardImageLinux(): Promise<ImageAttachment | null> {
  if (DEBUG) dbg('linux: probing clipboard for image data');

  const hasWlPaste = await isCommandAvailable('wl-paste', ['--version']);
  const hasXclip   = await isCommandAvailable('xclip',    ['-version']);

  if (!hasWlPaste && !hasXclip) {
    if (DEBUG) dbg('linux: neither wl-paste nor xclip found, returning null');
    return null;
  }

  const probes: Array<{ cmd: string; args: string[] }> = [];
  if (hasWlPaste) probes.push({ cmd: 'wl-paste', args: ['--type', 'image/png', '--no-newline'] });
  if (hasXclip)   probes.push({ cmd: 'xclip',    args: ['-selection', 'clipboard', '-t', 'image/png', '-o'] });

  for (const { cmd, args } of probes) {
    const tmpPath = join(tmpdir(), `afk-clipboard-${randomUUID()}.bin`);
    try {
      const buffer = await linuxClipboardRead(cmd, args);
      if (DEBUG) dbg(`linux: ${cmd} returned ${buffer?.length ?? 0} bytes`);
      if (!buffer || buffer.length === 0) continue;

      const mediaType = detectMediaTypeLinux(buffer);
      if (DEBUG) dbg(`linux: magic-byte detection: ${mediaType ?? 'unrecognized'}`);
      if (!mediaType) continue;

      if (DEBUG) dbg(`linux: probe success: mediaType=${mediaType} size=${buffer.byteLength}`);
      return {
        id: randomUUID(),
        mediaType,
        bytes: buffer,
        sizeBytes: buffer.byteLength,
      };
    } catch {
      // Try next tool
    } finally {
      unlink(tmpPath).catch(() => undefined);
    }
  }

  if (DEBUG) dbg('linux: probe result: null (no image found on clipboard)');
  return null;
}
