/**
 * Tests for the Windows desktop backend.
 *
 * Invariant: NO real screen capture is performed. The child process is mocked
 * via `vi.mock('node:child_process')`. All file I/O is mocked via
 * `vi.mock('node:fs/promises')`.
 *
 * NOTE: NOT VERIFIED ON REAL WINDOWS HARDWARE. These tests exercise the
 * script-building logic and error-mapping paths only.
 *
 * @module desktop/backend.windows.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as nodePath from 'node:path';

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

const SIDECAR = nodePath.join(os.tmpdir(), 'test-sidecar-win.png');

function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function setupExecFile(result: { stdout: string; stderr: string } | Error) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: Function) => {
      if (result instanceof Error) {
        cb(result);
      } else {
        cb(null, result);
      }
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Windows backend — script building', () => {
  it('script contains the display index', async () => {
    const pngBuf = makePng(1920, 1080);
    setupExecFile({ stdout: 'OK:2:0,0,1920,1080:1920x1080', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await backend.screenshot({ displayIndex: 2 }, SIDECAR);

    const calls = (execFile as ReturnType<typeof vi.fn>).mock.calls;
    const script = (calls[0]![1] as string[])[3]!;
    expect(script).toContain('$idx = 2');
  });

  it('script uses $true for useRegion when region is supplied', async () => {
    const pngBuf = makePng(400, 300);
    setupExecFile({ stdout: 'OK:0:0,0,1920,1080:400x300', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await backend.screenshot({ displayIndex: 0, region: { x: 10, y: 20, width: 400, height: 300 } }, SIDECAR);

    const script = ((execFile as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[])[3]!;
    expect(script).toContain('$useRegion = $true');
    expect(script).toContain('$rx = 10');
    expect(script).toContain('$ry = 20');
    expect(script).toContain('$rw = 400');
    expect(script).toContain('$rh = 300');
  });

  it('script uses $false for useRegion when no region', async () => {
    const pngBuf = makePng(1920, 1080);
    setupExecFile({ stdout: 'OK:0:0,0,1920,1080:1920x1080', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await backend.screenshot({ displayIndex: 0 }, SIDECAR);

    const script = ((execFile as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[])[3]!;
    expect(script).toContain('$useRegion = $false');
  });

  it('region is applied relative to display origin (absX = screen.Bounds.X + rx)', async () => {
    const pngBuf = makePng(400, 300);
    setupExecFile({ stdout: 'OK:1:1920,0,1920,1080:400x300', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await backend.screenshot({ displayIndex: 1, region: { x: 50, y: 60, width: 400, height: 300 } }, SIDECAR);

    const script = ((execFile as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[])[3]!;
    // The script adds screen.Bounds.X to rx — verify the formula is present
    expect(script).toContain('$absX = $screen.Bounds.X + $rx');
    expect(script).toContain('$absY = $screen.Bounds.Y + $ry');
  });
});

describe('Windows backend — display index validation', () => {
  it('throws DISPLAY_NOT_FOUND when script reports ERROR:DISPLAY_NOT_FOUND', async () => {
    setupExecFile({ stdout: 'ERROR:DISPLAY_NOT_FOUND:2', stderr: '' });

    const { createWindowsBackend } = await import('./backend.windows.js');
    const { DesktopBackendError } = await import('./types.js');
    const backend = createWindowsBackend();
    await expect(backend.screenshot({ displayIndex: 5 }, SIDECAR))
      .rejects.toBeInstanceOf(DesktopBackendError);
    await expect(backend.screenshot({ displayIndex: 5 }, SIDECAR))
      .rejects.toMatchObject({ code: 'DISPLAY_NOT_FOUND' });
  });

  it('error message names the requested index and available count', async () => {
    setupExecFile({ stdout: 'ERROR:DISPLAY_NOT_FOUND:2', stderr: '' });

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await expect(backend.screenshot({ displayIndex: 5 }, SIDECAR))
      .rejects.toMatchObject({ message: expect.stringContaining('5') });
  });

  it('reports the actual display index used from the OK line', async () => {
    const pngBuf = makePng(1920, 1080);
    setupExecFile({ stdout: 'OK:1:1920,0,1920,1080:1920x1080', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    const result = await backend.screenshot({ displayIndex: 1 }, SIDECAR);

    expect('aborted' in result).toBe(false);
    if (!('aborted' in result)) {
      expect(result.displayIndex).toBe(1);
    }
  });
});

describe('Windows backend — error mapping', () => {
  it('throws PERMISSION_DENIED on UnauthorizedAccess', async () => {
    setupExecFile(new Error('UnauthorizedAccess: Access is denied'));

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('throws CAPTURE_FAILED on generic PowerShell error', async () => {
    setupExecFile(new Error('PowerShell execution policy prevented script'));

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  });

  it('throws CAPTURE_FAILED on truncated/empty PNG', async () => {
    setupExecFile({ stdout: 'OK:0:0,0,1920,1080:1920x1080', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.alloc(5));

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  });

  it('throws CAPTURE_FAILED when readFile fails', async () => {
    setupExecFile({ stdout: 'OK:0:0,0,1920,1080:1920x1080', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  });
});

describe('Windows backend — cleanup on failure', () => {
  it('calls unlink when PowerShell fails', async () => {
    setupExecFile(new Error('script error'));

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR)).rejects.toThrow();
    expect(unlink).toHaveBeenCalledWith(SIDECAR);
  });

  it('calls unlink when readFile fails', async () => {
    setupExecFile({ stdout: 'OK:0:0,0,1920,1080:1920x1080', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await expect(backend.screenshot({ displayIndex: 0 }, SIDECAR)).rejects.toThrow();
    expect(unlink).toHaveBeenCalledWith(SIDECAR);
  });

  it('calls unlink when DISPLAY_NOT_FOUND', async () => {
    setupExecFile({ stdout: 'ERROR:DISPLAY_NOT_FOUND:1', stderr: '' });

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    await expect(backend.screenshot({ displayIndex: 5 }, SIDECAR)).rejects.toThrow();
    expect(unlink).toHaveBeenCalledWith(SIDECAR);
  });
});

describe('Windows backend — abort', () => {
  it('returns aborted before spawn when signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort('win-abort');

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    const result = await backend.screenshot({ displayIndex: 0, signal: ac.signal }, SIDECAR);

    expect('aborted' in result).toBe(true);
    if ('aborted' in result) {
      expect(result.aborted).toBe(true);
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns aborted and cleans up when signal fires during capture', async () => {
    const ac = new AbortController();
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: Function) => {
        ac.abort('mid-win');
        cb(new Error('The operation was aborted'));
      },
    );
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(makePng(100, 100));

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    const result = await backend.screenshot({ displayIndex: 0, signal: ac.signal }, SIDECAR);

    expect('aborted' in result).toBe(true);
    expect(unlink).toHaveBeenCalledWith(SIDECAR);
  });
});

describe('Windows backend — scale reporting', () => {
  it('derives scale 1 for a non-HiDPI display (1920x1080 logical = physical)', async () => {
    const pngBuf = makePng(1920, 1080);
    setupExecFile({ stdout: 'OK:0:0,0,1920,1080:1920x1080', stderr: '' });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pngBuf);

    const { createWindowsBackend } = await import('./backend.windows.js');
    const backend = createWindowsBackend();
    const result = await backend.screenshot({ displayIndex: 0 }, SIDECAR);

    expect('aborted' in result).toBe(false);
    if (!('aborted' in result)) {
      expect(result.scaleFactor).toBe(1);
      expect(result.logicalWidth).toBe(1920);
    }
  });
});
