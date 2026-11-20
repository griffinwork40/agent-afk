/**
 * Tests for the macOS desktop backend.
 *
 * Invariant: NO real screen capture is performed. The child process is mocked
 * via `vi.mock('node:child_process')`. All file I/O is mocked via
 * `vi.mock('node:fs/promises')`.
 *
 * @module desktop/backend.macos.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as nodePath from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before the module under test is imported
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';

/** Build a minimal valid PNG buffer (33 bytes, IHDR only). */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const SIDECAR = nodePath.join(os.tmpdir(), 'test-sidecar.png');

beforeEach(() => {
  vi.clearAllMocks();
});

// Helper: set up execFile mock to succeed for screencapture, then optionally
// for system_profiler.
function setupExecFile(
  screencaptureResult: { stdout: string; stderr: string } | Error,
  profilerResult?: { stdout: string; stderr: string } | Error,
) {
  let callCount = 0;
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (cmd: string, _args: unknown, _opts: unknown, cb: Function) => {
      callCount++;
      if (cmd === 'screencapture' || (callCount === 1 && cmd !== 'system_profiler')) {
        if (screencaptureResult instanceof Error) {
          cb(screencaptureResult);
        } else {
          cb(null, screencaptureResult);
        }
      } else {
        // system_profiler call
        if (!profilerResult) {
          cb(new Error('system_profiler not mocked'));
        } else if (profilerResult instanceof Error) {
          cb(profilerResult);
        } else {
          cb(null, profilerResult);
        }
      }
    },
  );
}

describe('macOS backend — buildArgs / screencapture invocation', () => {
  it('passes -D 1 for display index 0 (1-based)', async () => {
    const pngBuf = makePng(1920, 1080);
    setupExecFile(
      { stdout: '', stderr: '' },
      { stdout: JSON.stringify({ SPDisplaysDataType: [] }), stderr: '' },
    );
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    await backend.screenshot({ displayIndex: 0 }, SIDECAR);

    const calls = (execFile as ReturnType<typeof vi.fn>).mock.calls;
    const screencaptureCall = calls.find((c: unknown[]) => c[0] === 'screencapture');
    expect(screencaptureCall).toBeDefined();
    const args = screencaptureCall![1] as string[];
    expect(args).toContain('-D');
    expect(args[args.indexOf('-D') + 1]).toBe('1');
    expect(args).not.toContain('-R');
  });

  it('passes -D 3 for display index 2', async () => {
    const pngBuf = makePng(1920, 1080);
    setupExecFile(
      { stdout: '', stderr: '' },
      { stdout: JSON.stringify({ SPDisplaysDataType: [] }), stderr: '' },
    );
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    await backend.screenshot({ displayIndex: 2 }, SIDECAR);

    const calls = (execFile as ReturnType<typeof vi.fn>).mock.calls;
    const sc = calls.find((c: unknown[]) => c[0] === 'screencapture');
    const args = sc![1] as string[];
    expect(args[args.indexOf('-D') + 1]).toBe('3');
  });

  it('passes -R x,y,w,h for a region capture', async () => {
    const pngBuf = makePng(400, 300);
    setupExecFile({ stdout: '', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    await backend.screenshot({ displayIndex: 0, region: { x: 10, y: 20, width: 400, height: 300 } }, SIDECAR);

    const calls = (execFile as ReturnType<typeof vi.fn>).mock.calls;
    const sc = calls.find((c: unknown[]) => c[0] === 'screencapture');
    const args = sc![1] as string[];
    expect(args).toContain('-R');
    expect(args[args.indexOf('-R') + 1]).toBe('10,20,400,300');
  });
});

describe('macOS backend — scale reporting', () => {
  it('derives scale from region: 2x for a 400×300 logical region producing 800×600 PNG', async () => {
    const pngBuf = makePng(800, 600);
    setupExecFile({ stdout: '', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    const result = await backend.screenshot(
      { displayIndex: 0, region: { x: 0, y: 0, width: 400, height: 300 } },
      SIDECAR,
    );

    expect('aborted' in result).toBe(false);
    if (!('aborted' in result)) {
      expect(result.scaleFactor).toBe(2);
      expect(result.logicalWidth).toBe(400);
      expect(result.logicalHeight).toBe(300);
    }
  });

  it('reports scaleFactor from system_profiler for full-display capture', async () => {
    const pngBuf = makePng(3456, 2234);
    // system_profiler returns logical 1728×1117, physical 3456×2234 → scale 2
    const profilerOut = JSON.stringify({
      SPDisplaysDataType: [{
        spdisplays_ndrvs: [{
          _spdisplays_pixels: '3456 x 2234',
          _spdisplays_resolution: '1728 x 1117 @ 120.00Hz',
        }],
      }],
    });
    setupExecFile({ stdout: '', stderr: '' }, { stdout: profilerOut, stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    const result = await backend.screenshot({ displayIndex: 0 }, SIDECAR);

    expect('aborted' in result).toBe(false);
    if (!('aborted' in result)) {
      expect(result.scaleFactor).toBeCloseTo(2, 5);
      expect(result.logicalWidth).toBe(1728);
      expect(result.logicalHeight).toBe(1117);
    }
  });

  it('matches the display by captured pixel size, not by list position', async () => {
    // system_profiler lists the built-in Retina panel first, but the capture
    // (display index 0, the main display) came from the external 1x monitor.
    const pngBuf = makePng(2560, 1440);
    const profilerOut = JSON.stringify({
      SPDisplaysDataType: [{
        spdisplays_ndrvs: [
          { _spdisplays_pixels: '3456 x 2234', _spdisplays_resolution: '1728 x 1117 @ 120.00Hz' },
          { _spdisplays_pixels: '2560 x 1440', _spdisplays_resolution: '2560 x 1440 @ 60.00Hz' },
        ],
      }],
    });
    setupExecFile({ stdout: '', stderr: '' }, { stdout: profilerOut, stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const result = await createMacOsBackend().screenshot({ displayIndex: 0 }, SIDECAR);

    expect('aborted' in result).toBe(false);
    if (!('aborted' in result)) {
      expect(result.scaleFactor).toBe(1);
      expect(result.logicalWidth).toBe(2560);
      expect(result.logicalHeight).toBe(1440);
    }
  });

  it('reports scaleFactor null when no listed display has the captured size', async () => {
    const pngBuf = makePng(1920, 1080);
    const profilerOut = JSON.stringify({
      SPDisplaysDataType: [{
        spdisplays_ndrvs: [
          { _spdisplays_pixels: '3456 x 2234', _spdisplays_resolution: '1728 x 1117 @ 120.00Hz' },
        ],
      }],
    });
    setupExecFile({ stdout: '', stderr: '' }, { stdout: profilerOut, stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const result = await createMacOsBackend().screenshot({ displayIndex: 0 }, SIDECAR);

    expect('aborted' in result).toBe(false);
    if (!('aborted' in result)) expect(result.scaleFactor).toBeNull();
  });

  it('reports scaleFactor null when two displays of the captured size disagree on logical size', async () => {
    const pngBuf = makePng(3840, 2160);
    const profilerOut = JSON.stringify({
      SPDisplaysDataType: [{
        spdisplays_ndrvs: [
          { _spdisplays_pixels: '3840 x 2160', _spdisplays_resolution: '1920 x 1080 @ 60.00Hz' },
          { _spdisplays_pixels: '3840 x 2160', _spdisplays_resolution: '3840 x 2160 @ 60.00Hz' },
        ],
      }],
    });
    setupExecFile({ stdout: '', stderr: '' }, { stdout: profilerOut, stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const result = await createMacOsBackend().screenshot({ displayIndex: 0 }, SIDECAR);

    expect('aborted' in result).toBe(false);
    if (!('aborted' in result)) expect(result.scaleFactor).toBeNull();
  });

  it('reports scaleFactor null when system_profiler returns no match', async () => {
    const pngBuf = makePng(2560, 1440);
    setupExecFile(
      { stdout: '', stderr: '' },
      { stdout: JSON.stringify({ SPDisplaysDataType: [] }), stderr: '' },
    );
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    const result = await backend.screenshot({ displayIndex: 0 }, SIDECAR);

    expect('aborted' in result).toBe(false);
    if (!('aborted' in result)) {
      expect(result.scaleFactor).toBeNull();
    }
  });
});

describe('macOS backend — error mapping', () => {
  it('throws PERMISSION_DENIED when screencapture message contains "permission"', async () => {
    setupExecFile(new Error('Operation not permitted (permission denied)'));
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makePng(100, 100));

    const { createMacOsBackend } = await import('./backend.macos.js');
    const { DesktopBackendError } = await import('./types.js');
    const backend = createMacOsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toBeInstanceOf(DesktopBackendError);
  });

  it('throws CAPTURE_FAILED on generic screencapture error', async () => {
    setupExecFile(new Error('screencapture: command not found'));

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  });

  it('throws CAPTURE_FAILED on truncated PNG (< 24 bytes)', async () => {
    setupExecFile({ stdout: '', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.alloc(10));

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  });

  it('throws CAPTURE_FAILED on empty PNG', async () => {
    setupExecFile({ stdout: '', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.alloc(0));

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  });

  it('throws CAPTURE_FAILED when readFile fails after capture', async () => {
    setupExecFile({ stdout: '', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  });
});

describe('macOS backend — cleanup on failure', () => {
  it('calls unlink on the sidecar path when screencapture fails', async () => {
    setupExecFile(new Error('screencapture failed'));

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR)).rejects.toThrow();
    expect(unlink).toHaveBeenCalledWith(SIDECAR);
  });

  it('calls unlink on the sidecar path when readFile fails', async () => {
    setupExecFile({ stdout: '', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR)).rejects.toThrow();
    expect(unlink).toHaveBeenCalledWith(SIDECAR);
  });
});

describe('macOS backend — abort', () => {
  it('returns aborted result when signal is already aborted before spawn', async () => {
    const ac = new AbortController();
    ac.abort('test-reason');

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    const result = await backend.screenshot({ displayIndex: 0, signal: ac.signal }, SIDECAR);

    expect('aborted' in result).toBe(true);
    if ('aborted' in result) {
      expect(result.aborted).toBe(true);
      expect(result.reason).toContain('test-reason');
    }
    // execFile should NOT have been called
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns aborted result and cleans up when signal fires during capture', async () => {
    const ac = new AbortController();
    // Make execFile call the abort during the callback
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: Function) => {
        ac.abort('mid-capture');
        cb(new Error('The operation was aborted'));
      },
    );
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makePng(100, 100));

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    const result = await backend.screenshot({ displayIndex: 0, signal: ac.signal }, SIDECAR);

    expect('aborted' in result).toBe(true);
    expect(unlink).toHaveBeenCalledWith(SIDECAR);
  });
});

describe('macOS backend — displayIndex in result', () => {
  it('reports the requested displayIndex in the result', async () => {
    const pngBuf = makePng(2560, 1440);
    setupExecFile(
      { stdout: '', stderr: '' },
      { stdout: JSON.stringify({ SPDisplaysDataType: [] }), stderr: '' },
    );
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createMacOsBackend } = await import('./backend.macos.js');
    const backend = createMacOsBackend();
    const result = await backend.screenshot({ displayIndex: 1 }, SIDECAR);

    expect('aborted' in result).toBe(false);
    if (!('aborted' in result)) {
      expect(result.displayIndex).toBe(1);
    }
  });
});
