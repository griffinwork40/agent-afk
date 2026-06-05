/**
 * Tests for clipboard image reader.
 *
 * Covers:
 *   - Non-darwin platform → null without spawning
 *   - PNG, JPEG, GIF, WebP magic byte detection (via TIFF/PNGf coercion paths)
 *   - TIFF clipboard data → transcoded to PNG via `sips` and returned as image/png
 *   - Empty file → null
 *   - Unknown magic bytes → null
 *   - osascript exits nonzero → null
 *   - osascript prints `no` (no image on clipboard) → null
 *   - spawn error → null
 *   - AFK_DEBUG_CLIPBOARD=1 → structured stderr output at each probe stage
 *   - AFK_DEBUG_CLIPBOARD unset → zero writes to stderr
 *
 * The reader spawns `osascript` to coerce the pasteboard to PNG/TIFF binary
 * and writes to a temp file. We mock both `child_process.spawn` (osascript
 * invocation) and `fs/promises` (file readback + cleanup).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
// Mock fs/promises. Note: factory runs once, but vi.resetAllMocks() in
// beforeEach wipes implementations, so we re-stub readFile/unlink before
// each test via stubReadFile() and the beforeEach hook.
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

import { readClipboardImage } from './clipboard-image.js';
import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';

const mockedSpawn = vi.mocked(spawn);
const mockedReadFile = vi.mocked(readFile);
const mockedUnlink = vi.mocked(unlink);

/**
 * Mock osascript child. `stdout` is the script's printed return value
 * ("ok" or "no"). `exitCode` defaults to 0. `shouldError` triggers an
 * 'error' event before close.
 */
function createOsaChild(options: {
  stdout?: string;
  exitCode?: number;
  shouldError?: boolean;
}): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  setImmediate(() => {
    if (options.shouldError) {
      child.emit('error', new Error('spawn failed'));
      return;
    }
    if (options.stdout) {
      child.stdout.emit('data', Buffer.from(options.stdout, 'utf8'));
    }
    child.emit('close', options.exitCode ?? 0);
  });

  return child as unknown as ChildProcess;
}

/** Make `readFile` return the given bytes for any path. */
function stubReadFile(bytes: Buffer): void {
  mockedReadFile.mockResolvedValue(bytes as unknown as Buffer);
}

/**
 * Make osascript spawn return a fresh OsaChild on every call so multiple
 * attempts (PNGf → TIFF fallback) each get their own EventEmitter and don't
 * share already-fired setImmediate callbacks.
 */
function stubOsa(options: Parameters<typeof createOsaChild>[0]): void {
  mockedSpawn.mockImplementation(() => createOsaChild(options));
}

/**
 * Stub the full TIFF→PNG pipeline. Sequence of mocked side effects:
 *   spawn #1: osascript (PNGf coerce) → exit 0 with stdout 'ok'
 *   readFile #1: returns `tiffBytes` (TIFF magic-byte branch fires)
 *   spawn #2: sips transcode → exit 0
 *   readFile #2: returns `pngBytes` (the transcoded PNG)
 *
 * The createOsaChild helper happens to also model `sips` since both are
 * spawn() processes whose only signal we read is `close(code)`. Both
 * osascript and sips paths in clipboard-image.ts treat code === 0 as
 * success and any stdout output as informational; createOsaChild covers
 * both.
 */
function stubTiffToPngPipeline(tiffBytes: Buffer, pngBytes: Buffer): void {
  let spawnCall = 0;
  mockedSpawn.mockImplementation(() => {
    spawnCall++;
    // osascript first, sips second; both succeed.
    return createOsaChild({ stdout: spawnCall === 1 ? 'ok' : '', exitCode: 0 });
  });
  let readCall = 0;
  mockedReadFile.mockImplementation(async () => {
    readCall++;
    return (readCall === 1 ? tiffBytes : pngBytes) as unknown as Buffer;
  });
}

describe('readClipboardImage', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-stub unlink → resolved noop (resetAllMocks clears the factory default).
    mockedUnlink.mockResolvedValue(undefined);
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  describe('platform check', () => {
    it('returns null on non-darwin without spawning', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const result = await readClipboardImage();
      expect(result).toBeNull();
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('returns null on win32 without spawning', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const result = await readClipboardImage();
      expect(result).toBeNull();
      expect(mockedSpawn).not.toHaveBeenCalled();
    });
  });

  describe('magic byte detection (PNGf class path)', () => {
    it('detects PNG bytes returned via PNGf coercion', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
      stubOsa({ stdout: 'ok' });
      stubReadFile(png);

      const result = await readClipboardImage();
      expect(result).not.toBeNull();
      expect(result?.mediaType).toBe('image/png');
      expect(result?.bytes).toEqual(png);
      expect(result?.sizeBytes).toBe(png.length);
      expect(result?.id).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('detects JPEG via fallback chain', async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      // First call (PNGf) succeeds and returns JPEG bytes — the detector
      // sniffs magic bytes independent of which apple-class we asked for.
      stubOsa({ stdout: 'ok' });
      stubReadFile(jpeg);

      const result = await readClipboardImage();
      expect(result?.mediaType).toBe('image/jpeg');
    });

    it('detects GIF magic bytes', async () => {
      const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      stubOsa({ stdout: 'ok' });
      stubReadFile(gif);
      const result = await readClipboardImage();
      expect(result?.mediaType).toBe('image/gif');
    });

    it('detects WebP magic bytes (RIFF....WEBP)', async () => {
      const webp = Buffer.from([
        0x52, 0x49, 0x46, 0x46,
        0x00, 0x01, 0x02, 0x03,
        0x57, 0x45, 0x42, 0x50,
        0xff, 0xfe, 0xfd,
      ]);
      stubOsa({ stdout: 'ok' });
      stubReadFile(webp);
      const result = await readClipboardImage();
      expect(result?.mediaType).toBe('image/webp');
    });

    // TIFF clipboard data is transcoded to PNG via `sips` because the
    // Anthropic API only accepts png/jpeg/gif/webp. The reader spawns
    // osascript first (clipboard coerce), then sips (TIFF→PNG transcode);
    // readFile is called twice — once for the TIFF buffer, once for the
    // PNG output of sips.
    it('detects TIFF little-endian magic bytes (II*\\0) and transcodes to PNG', async () => {
      const tiffLE = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
      const transcodedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);
      stubTiffToPngPipeline(tiffLE, transcodedPng);
      const result = await readClipboardImage();
      expect(result).not.toBeNull();
      expect(result?.mediaType).toBe('image/png');
      expect(result?.bytes).toEqual(transcodedPng);
    });

    it('detects TIFF big-endian magic bytes (MM\\0*) and transcodes to PNG', async () => {
      const tiffBE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
      const transcodedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xcc, 0xdd]);
      stubTiffToPngPipeline(tiffBE, transcodedPng);
      const result = await readClipboardImage();
      expect(result).not.toBeNull();
      expect(result?.mediaType).toBe('image/png');
      expect(result?.bytes).toEqual(transcodedPng);
    });

    it('returns null when TIFF transcode (sips) fails', async () => {
      const tiffLE = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
      // osascript succeeds (twice — once for PNGf attempt, once for TIFF),
      // sips fails (exit 1). readFile returns TIFF bytes both clipboard reads.
      let spawnCall = 0;
      mockedSpawn.mockImplementation(() => {
        spawnCall++;
        // calls 1 & 3: osascript (PNGf attempt, then TIFF attempt) → ok
        // call 2: sips after first TIFF detection → exit 1
        // call 4: sips after second TIFF detection → exit 1
        if (spawnCall === 2 || spawnCall === 4) {
          return createOsaChild({ exitCode: 1 });
        }
        return createOsaChild({ stdout: 'ok' });
      });
      mockedReadFile.mockResolvedValue(tiffLE as unknown as Buffer);
      const result = await readClipboardImage();
      expect(result).toBeNull();
    });

    it('returns null for unknown magic bytes', async () => {
      const unknown = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]);
      stubOsa({ stdout: 'ok' });
      stubReadFile(unknown);
      const result = await readClipboardImage();
      expect(result).toBeNull();
    });
  });

  describe('fallback PNGf → TIFF', () => {
    it('falls back to TIFF coercion when PNGf attempt yields no image', async () => {
      // First spawn (PNGf) returns "no"; second spawn (TIFF) returns "ok"
      // with PNG bytes (the apple-class label is independent of the
      // detected magic bytes — the pasteboard sometimes returns PNG-form
      // data even when coerced as TIFF in older flows).
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      mockedSpawn
        .mockImplementationOnce(() => createOsaChild({ stdout: 'no' }))
        .mockImplementationOnce(() => createOsaChild({ stdout: 'ok' }));
      // readFile is only called on the "ok" attempt (PNGf returns "no" so
      // its coerce call short-circuits before readback). One queued value.
      mockedReadFile.mockResolvedValueOnce(png as unknown as Buffer);

      const result = await readClipboardImage();
      expect(result).not.toBeNull();
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
    });

    it('returns null when both PNGf and TIFF attempts fail', async () => {
      mockedSpawn
        .mockImplementationOnce(() => createOsaChild({ stdout: 'no' }))
        .mockImplementationOnce(() => createOsaChild({ stdout: 'no' }));
      const result = await readClipboardImage();
      expect(result).toBeNull();
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
    });
  });

  describe('edge cases', () => {
    it('returns null when osascript exits nonzero', async () => {
      stubOsa({ stdout: 'ok', exitCode: 1 });
      const result = await readClipboardImage();
      expect(result).toBeNull();
    });

    it('returns null when osascript prints "no"', async () => {
      stubOsa({ stdout: 'no' });
      const result = await readClipboardImage();
      expect(result).toBeNull();
    });

    it('returns null when spawn errors', async () => {
      stubOsa({ shouldError: true });
      const result = await readClipboardImage();
      expect(result).toBeNull();
    });

    it('returns null when temp file readback is empty', async () => {
      stubOsa({ stdout: 'ok' });
      stubReadFile(Buffer.alloc(0));
      const result = await readClipboardImage();
      expect(result).toBeNull();
    });
  });

  describe('spawn invocation', () => {
    it('spawns osascript with -e and an AppleScript body', async () => {
      stubOsa({ stdout: 'no' });
      await readClipboardImage();
      expect(mockedSpawn).toHaveBeenCalled();
      const [cmd, args] = mockedSpawn.mock.calls[0];
      expect(cmd).toBe('osascript');
      expect(args?.[0]).toBe('-e');
      expect(typeof args?.[1]).toBe('string');
      expect(args?.[1]).toContain('clipboard');
    });

    it('embeds «class PNGf» in the first attempt', async () => {
      stubOsa({ stdout: 'no' });
      await readClipboardImage();
      const firstScript = mockedSpawn.mock.calls[0][1]?.[1] as string;
      expect(firstScript).toContain('PNGf');
    });

    it('embeds «class TIFF» in the second attempt', async () => {
      mockedSpawn
        .mockImplementationOnce(() => createOsaChild({ stdout: 'no' }))
        .mockImplementationOnce(() => createOsaChild({ stdout: 'no' }));
      await readClipboardImage();
      const secondScript = mockedSpawn.mock.calls[1][1]?.[1] as string;
      expect(secondScript).toContain('TIFF');
    });
  });

  describe('id generation', () => {
    it('generates a uuid id for each successful read', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      stubOsa({ stdout: 'ok' });
      stubReadFile(png);

      const r1 = await readClipboardImage();
      stubOsa({ stdout: 'ok' });
      stubReadFile(png);
      const r2 = await readClipboardImage();

      expect(r1?.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(r2?.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(r1?.id).not.toBe(r2?.id);
    });
  });
});

/**
 * Part B: AFK_DEBUG_CLIPBOARD env-var gating.
 *
 * Because `const DEBUG = !!process.env.AFK_DEBUG_CLIPBOARD` is evaluated at
 * module load time, each sub-test must reset modules and re-import the module
 * with the desired env state. We use vi.stubEnv + vi.resetModules() +
 * dynamic import for this.
 *
 * The child_process and fs/promises mocks are registered at the top of the
 * file with vi.mock() (hoisted), so they remain active across module resets.
 * We re-configure the spawn/readFile stubs via the already-mocked references.
 */
describe('AFK_DEBUG_CLIPBOARD logging (Part B)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetAllMocks();
    mockedUnlink.mockResolvedValue(undefined);
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('AFK_DEBUG_CLIPBOARD unset → zero writes to process.stderr', async () => {
    vi.unstubAllEnvs();
    vi.resetModules();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // Stub osascript → no image; both PNGf and TIFF return "no"
    mockedSpawn.mockImplementation(() => createOsaChild({ stdout: 'no' }));

    const { readClipboardImage: readFresh } = await import('./clipboard-image.js');
    await readFresh();

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('AFK_DEBUG_CLIPBOARD=1 → writes [afk-clipboard] lines to stderr on null probe', async () => {
    vi.stubEnv('AFK_DEBUG_CLIPBOARD', '1');
    vi.resetModules();

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    // Both PNGf and TIFF return "no" → null result
    mockedSpawn.mockImplementation(() => createOsaChild({ stdout: 'no' }));

    const { readClipboardImage: readFresh } = await import('./clipboard-image.js');
    await readFresh();

    // Must have written at least: entry log + per-class result logs + final null log
    expect(stderrLines.length).toBeGreaterThanOrEqual(3);
    const joined = stderrLines.join('');
    expect(joined).toContain('[afk-clipboard]');
    expect(joined).toContain('probing');
    expect(joined).toContain('class=PNGf');
    expect(joined).toContain('null');
  });

  it('AFK_DEBUG_CLIPBOARD=1 → logs magic-byte detection outcome on success', async () => {
    vi.stubEnv('AFK_DEBUG_CLIPBOARD', '1');
    vi.resetModules();

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    mockedSpawn.mockImplementation(() => createOsaChild({ stdout: 'ok' }));
    mockedReadFile.mockResolvedValue(png as unknown as Buffer);

    const { readClipboardImage: readFresh } = await import('./clipboard-image.js');
    const result = await readFresh();

    expect(result).not.toBeNull();
    const joined = stderrLines.join('');
    // Must log the magic-byte result and probe success
    expect(joined).toContain('image/png');
    expect(joined).toContain('probe success');
  });

  it('AFK_DEBUG_CLIPBOARD=1 → includes exitCode and stderr in per-class log', async () => {
    vi.stubEnv('AFK_DEBUG_CLIPBOARD', '1');
    vi.resetModules();

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    mockedSpawn.mockImplementation(() => createOsaChild({ stdout: 'no', exitCode: 0 }));

    const { readClipboardImage: readFresh } = await import('./clipboard-image.js');
    await readFresh();

    const joined = stderrLines.join('');
    // Per-class log must include exitCode field
    expect(joined).toContain('exitCode=0');
    expect(joined).toContain('ok=false');
  });
});
