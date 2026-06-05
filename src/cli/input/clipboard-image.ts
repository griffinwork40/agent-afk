/**
 * Read image data from macOS system clipboard.
 *
 * History: this originally shelled out to `pbpaste -Prefer image`, but that
 * command does NOT extract binary image bytes from NSPasteboard — it only
 * returns text representations. A screenshot taken via Cmd+Shift+Ctrl+4 sits
 * on the pasteboard as `«class PNGf»` (and friends), and `pbpaste` returns
 * zero bytes for it. Verified live against a clipboard known to contain a
 * valid PNG: `pbpaste -Prefer image | wc -c` → 0.
 *
 * The fix uses AppleScript to coerce the clipboard to `«class PNGf»` /
 * `«class TIFF»` and write the binary bytes to a temp file (osascript stdout
 * mangles null bytes, so we round-trip through disk). The temp file is read
 * back and deleted in the same call.
 *
 * @module cli/input/clipboard-image
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ImageAttachment } from './attachments.js';
import { env } from '../../config/env.js';

/**
 * When AFK_DEBUG_CLIPBOARD=1 (or any truthy value), structured diagnostic
 * messages are written to stderr at each probe stage. Zero overhead when unset.
 */
const DEBUG = !!env.AFK_DEBUG_CLIPBOARD;

function dbg(msg: string): void {
  process.stderr.write(`[afk-clipboard] ${msg}\n`);
}

/**
 * Read clipboard image data from the macOS system pasteboard.
 *
 * Strategy:
 *   1. Try `«class PNGf»` — Cmd+Shift+Ctrl+4 screenshots and most modern
 *      copy-image flows place a PNG representation on the pasteboard.
 *   2. Fall back to `«class TIFF»` — older flows and some apps. If the bytes
 *      are TIFF, transcode to PNG via `sips` because the Anthropic API only
 *      accepts png/jpeg/gif/webp as image media types.
 *   3. Validate result by magic-byte sniffing (we trust nothing the
 *      pasteboard claims about its own type).
 *
 * @returns ImageAttachment if the pasteboard holds a supported image,
 *          else null. All failure modes (no image, non-darwin, osascript
 *          missing, permissions denied, etc.) return null silently.
 *
 * Supported formats: PNG, JPEG, GIF, WebP. TIFF clipboard data is transcoded
 * to PNG before returning.
 */
export async function readClipboardImage(): Promise<ImageAttachment | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  if (DEBUG) dbg('probing clipboard for image data');

  // Try PNG class first, then TIFF (covers most clipboard image sources).
  // Each attempt writes to its own temp path; cleanup happens whether or not
  // the read succeeded.
  for (const klass of ['PNGf', 'TIFF'] as const) {
    const tmpPath = join(tmpdir(), `afk-clipboard-${randomUUID()}.bin`);
    try {
      const { ok, exitCode, stderr: osaStderr } = await coerceClipboardToFile(klass, tmpPath);
      if (DEBUG) {
        dbg(`class=${klass} osascript exitCode=${exitCode} stderr=${JSON.stringify(osaStderr)} ok=${ok}`);
      }
      if (!ok) continue;

      let buffer: Buffer = await readFile(tmpPath);
      if (buffer.length === 0) continue;

      // If the bytes are TIFF (the pasteboard genuinely held TIFF-only data),
      // transcode to PNG so the result is sendable to the Anthropic API.
      if (isTiff(buffer)) {
        if (DEBUG) dbg(`class=${klass} magic=TIFF detected, transcoding via sips`);
        const transcoded = await transcodeTiffToPng(tmpPath);
        if (!transcoded) {
          if (DEBUG) dbg(`class=${klass} sips transcode failed, skipping`);
          continue;
        }
        buffer = transcoded;
      }

      const mediaType = detectMediaType(buffer);
      if (DEBUG) {
        dbg(`class=${klass} magic-byte detection result: ${mediaType ?? 'unrecognized'}`);
      }
      if (!mediaType) continue;

      if (DEBUG) dbg(`probe success: mediaType=${mediaType} size=${buffer.byteLength}`);
      return {
        id: randomUUID(),
        mediaType,
        bytes: buffer,
        sizeBytes: buffer.byteLength,
      };
    } catch {
      // Try next class
    } finally {
      // Best-effort cleanup; ignore ENOENT etc.
      unlink(tmpPath).catch(() => undefined);
    }
  }

  if (DEBUG) dbg('probe result: null (no image found on clipboard)');
  return null;
}

/** Magic-byte check for TIFF (little-endian II*\0 or big-endian MM\0*). */
function isTiff(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  // LE: 49 49 2A 00
  if (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) return true;
  // BE: 4D 4D 00 2A
  if (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a) return true;
  return false;
}

/**
 * Transcode a TIFF file at `inputPath` to PNG using macOS `sips`. Writes the
 * PNG to a sibling temp path, reads it back, and best-effort deletes it.
 * Returns the PNG buffer on success, or null on any failure (sips missing,
 * non-zero exit, read failure).
 */
async function transcodeTiffToPng(inputPath: string): Promise<Buffer | null> {
  const outPath = join(tmpdir(), `afk-clipboard-${randomUUID()}.png`);
  const sipsOk = await new Promise<boolean>((resolve) => {
    const child = spawn('sips', ['-s', 'format', 'png', inputPath, '--out', outPath], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!sipsOk) {
    unlink(outPath).catch(() => undefined);
    return null;
  }
  try {
    const buf = await readFile(outPath);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    unlink(outPath).catch(() => undefined);
  }
}

interface CoerceResult {
  ok: boolean;
  exitCode: number | null;
  stderr: string;
}

/**
 * Run an osascript that coerces the system clipboard to the named Apple
 * pasteboard class and writes the raw bytes to `outPath`. Returns a result
 * object with `ok` (true if osascript exited 0 AND printed `ok`), the raw
 * exit code, and any stderr output (used by AFK_DEBUG_CLIPBOARD logging).
 *
 * The AppleScript intentionally returns the literal string "ok" on success
 * and "no" on the catch path — anything else (e.g. osascript missing) is
 * treated as failure by the surrounding try/catch.
 */
async function coerceClipboardToFile(klass: 'PNGf' | 'TIFF', outPath: string): Promise<CoerceResult> {
  // NOTE: `«class PNGf»` is the literal AppleScript syntax for the
  // PNG pasteboard type. We embed the four-char code in the script body.
  const script = `
    try
      set imgData to the clipboard as «class ${klass}»
      set fileRef to open for access POSIX file ${jsonForOsa(outPath)} with write permission
      set eof of fileRef to 0
      write imgData to fileRef
      close access fileRef
      return "ok"
    on error
      try
        close access fileRef
      end try
      return "no"
    end try
  `;

  return new Promise<CoerceResult>((resolve) => {
    const child = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', () => resolve({ ok: false, exitCode: null, stderr }));
    child.on('close', (code) => {
      resolve({ ok: code === 0 && stdout.trim() === 'ok', exitCode: code, stderr });
    });
  });
}

/**
 * Encode a string as an AppleScript string literal. AppleScript uses
 * double-quoted strings with `\\` and `"` as the only escapes that matter
 * for filesystem paths produced by `path.join(tmpdir(), ...)`.
 */
function jsonForOsa(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Detect image format by inspecting magic bytes at buffer start.
 * @returns mediaType string or null if format is not recognized
 */
function detectMediaType(buffer: Buffer): ImageAttachment['mediaType'] | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: 47 49 46 38 (GIF8)
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }

  // WebP: 52 49 46 46 <4 size bytes> 57 45 42 50 (RIFF....WEBP)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}
