/**
 * Unit tests for the TTY trace recorder (src/cli/tty-trace.ts).
 *
 * Uses the injectable FsOps interface instead of vi.spyOn on node:fs (ESM
 * named exports are non-configurable and cannot be spied on in Vitest).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FsOps } from '../tty-trace.js';
import { installTtyTrace, uninstallTtyTrace } from '../tty-trace.js';

// ── Fake FsOps ────────────────────────────────────────────────────────────────

function makeFakeFsOps(): FsOps & { lines: string[]; closed: boolean; throwOnOpen: boolean; throwOnWrite: boolean; lastOpenMode: number | undefined } {
  const state = {
    lines: [] as string[],
    closed: false,
    throwOnOpen: false,
    throwOnWrite: false,
    lastOpenMode: undefined as number | undefined,
    openSync(_path: string, _flags: string, mode?: number): number {
      state.lastOpenMode = mode;
      if (state.throwOnOpen) throw new Error('EACCES: permission denied');
      return 42;
    },
    writeSync(_fd: number, data: string): number {
      if (state.throwOnWrite) throw new Error('EIO: write error');
      state.lines.push(data);
      return data.length;
    },
    closeSync(_fd: number): void {
      state.closed = true;
    },
  };
  return state;
}

// ── TTY property helpers ──────────────────────────────────────────────────────

function setTTYProps(isTTY: boolean, cols = 80, rows = 24): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let originalIsTTY: boolean | undefined;
let originalColumns: number | undefined;
let originalRows: number | undefined;

beforeEach(() => {
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  originalIsTTY = process.stdout.isTTY;
  originalColumns = process.stdout.columns;
  originalRows = process.stdout.rows;

  // Replace write with a noop that also invokes any callback argument,
  // which is what a real writable stream does. This makes the callback
  // forwarding test work correctly through the tee wrapper.
  process.stdout.write = vi.fn().mockImplementation(
    (_chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : (typeof cb === 'function' ? cb : undefined);
      if (typeof callback === 'function') callback();
      return true;
    },
  ) as unknown as typeof process.stdout.write;
  process.stderr.write = vi.fn().mockImplementation(
    (_chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : (typeof cb === 'function' ? cb : undefined);
      if (typeof callback === 'function') callback();
      return true;
    },
  ) as unknown as typeof process.stderr.write;

  setTTYProps(true);
  process.env['AFK_TTY_TRACE'] = '/tmp/afk-test.cast';
});

afterEach(() => {
  uninstallTtyTrace();
  delete process.env['AFK_TTY_TRACE'];
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true });
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('tty-trace', () => {
  // 1. Records header on install
  it('writes asciinema v2 header as first line', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);

    expect(fs.lines.length).toBeGreaterThanOrEqual(1);
    const header = JSON.parse(fs.lines[0]!.trim()) as Record<string, unknown>;
    expect(header['version']).toBe(2);
    expect(header['width']).toBe(80);
    expect(header['height']).toBe(24);
    expect(typeof header['timestamp']).toBe('number');
    expect(header['env']).toBeDefined();
  });

  // 2. Records "o" event for stdout writes
  it('records an "o" event for each write to stdout', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    const before = fs.lines.length;

    process.stdout.write('hello world');

    const newLines = fs.lines.slice(before);
    expect(newLines.length).toBeGreaterThanOrEqual(1);
    const evt = JSON.parse(newLines[0]!.trim()) as [number, string, string];
    expect(evt[1]).toBe('o');
    expect(evt[2]).toContain('hello world');
  });

  // 3. Records "o" event for stderr writes
  it('records an "o" event for each write to stderr', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    const before = fs.lines.length;

    process.stderr.write('err output');

    const newLines = fs.lines.slice(before);
    expect(newLines.length).toBeGreaterThanOrEqual(1);
    const evt = JSON.parse(newLines[0]!.trim()) as [number, string, string];
    expect(evt[1]).toBe('o');
    expect(evt[2]).toContain('err output');
  });

  // 4. Records resize events
  it('records an "r" event on stdout resize', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    const before = fs.lines.length;

    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
    process.stdout.emit('resize');

    const newLines = fs.lines.slice(before);
    const resizeLines = newLines.filter((l) => {
      try { const e = JSON.parse(l.trim()) as unknown[]; return e[1] === 'r'; } catch { return false; }
    });
    expect(resizeLines.length).toBeGreaterThanOrEqual(1);
    const evt = JSON.parse(resizeLines[0]!.trim()) as [number, string, string];
    expect(evt[1]).toBe('r');
    expect(evt[2]).toMatch(/\d+x\d+/);
  });

  // 5. Handles Buffer chunks without throwing
  it('handles Buffer chunks (multibyte passthrough) without throwing', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    const before = fs.lines.length;

    process.stdout.write(Buffer.from('café', 'utf8'));

    const newLines = fs.lines.slice(before);
    expect(newLines.length).toBeGreaterThanOrEqual(1);
    const evt = JSON.parse(newLines[0]!.trim()) as [number, string, string];
    expect(evt[1]).toBe('o');
    expect(evt[2]).toContain('caf');
  });

  // 6. Passthrough: original write is called
  it('calls the original write function (passthrough)', () => {
    const stdoutWriteSpy = process.stdout.write as ReturnType<typeof vi.fn>;
    const fs = makeFakeFsOps();
    installTtyTrace(fs);

    process.stdout.write('passthrough check');

    expect(stdoutWriteSpy).toHaveBeenCalled();
  });

  // 7. Return value is boolean
  it('returns the original return value', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    const result = process.stdout.write('test');
    expect(typeof result).toBe('boolean');
  });

  // 8. Callback is invoked
  it('invokes callback when provided', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    const cb = vi.fn();
    process.stdout.write('cb test', cb);
    expect(cb).toHaveBeenCalled();
  });

  // 9. Uninstall restores originals
  it('restores original write functions on uninstall', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);

    // Wrapper is now installed; writes go to fake fs.
    process.stdout.write('during recording');
    const linesDuring = fs.lines.length;
    expect(linesDuring).toBeGreaterThan(1); // header + event

    uninstallTtyTrace();

    // After uninstall nothing new is recorded.
    process.stdout.write('after uninstall');
    expect(fs.lines.length).toBe(linesDuring);
  });

  // 10. Open failure is non-fatal
  it('is non-fatal when fs.openSync throws', () => {
    const fs = makeFakeFsOps();
    fs.throwOnOpen = true;

    expect(() => installTtyTrace(fs)).not.toThrow();

    // No cast lines written (open failed before header).
    expect(fs.lines.length).toBe(0);

    // A warning was emitted to stderr.
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const warned = stderrCalls.some(([msg]) => typeof msg === 'string' && msg.includes('tty-trace'));
    expect(warned).toBe(true);
  });

  // 11. Write error disables recorder non-fatally
  it('disables silently on write error (non-fatal)', () => {
    const fs = makeFakeFsOps();
    // Capture the stderr mock BEFORE install (after install, stderr.write is the wrapper).
    const stderrSpy = process.stderr.write as ReturnType<typeof vi.fn>;
    installTtyTrace(fs);

    // Trigger a write error.
    fs.throwOnWrite = true;
    expect(() => process.stdout.write('trigger error')).not.toThrow();

    // A warning was emitted via the original stderr (the spy we captured above,
    // which the wrapper delegates to).
    const calls = stderrSpy.mock.calls as Array<[string]>;
    const warned = calls.some(([msg]) => typeof msg === 'string' && msg.includes('tty-trace'));
    expect(warned).toBe(true);
  });

  // 12. No-op when AFK_TTY_TRACE is unset
  it('is a no-op when AFK_TTY_TRACE is unset', () => {
    delete process.env['AFK_TTY_TRACE'];
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    expect(fs.lines.length).toBe(0);
  });

  // 13. No-op when stdout is not a TTY
  it('is a no-op when stdout is not a TTY', () => {
    setTTYProps(false);
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    expect(fs.lines.length).toBe(0);
  });

  // 14. Cast file is opened with mode 0o600 (owner-only)
  it('opens the cast file with mode 0o600', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    expect(fs.lastOpenMode).toBe(0o600);
  });

  // 15. Idempotent install
  it('does not double-install on repeated installTtyTrace calls', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    const linesAfterFirst = fs.lines.length;
    installTtyTrace(fs);
    // Second call is a no-op — no extra header.
    expect(fs.lines.length).toBe(linesAfterFirst);
  });

  // 16. Decoder state is clean after uninstall→reinstall
  it('decoder state is clean after uninstall and reinstall (no stale U+FFFD)', () => {
    // First session: write the first byte of a 2-byte UTF-8 sequence (0xC3 is the
    // first byte of 'é' = 0xC3 0xA9), leaving the decoder with pending state.
    const fs1 = makeFakeFsOps();
    installTtyTrace(fs1);
    process.stdout.write(Buffer.from([0xc3])); // incomplete 'é' prefix
    uninstallTtyTrace();

    // Second session: write plain ASCII only.
    const fs2 = makeFakeFsOps();
    installTtyTrace(fs2);
    const before = fs2.lines.length; // skip header
    process.stdout.write('ok');

    const newLines = fs2.lines.slice(before);
    expect(newLines.length).toBeGreaterThanOrEqual(1);
    const evt = JSON.parse(newLines[0]!.trim()) as [number, string, string];
    expect(evt[1]).toBe('o');
    // A stale decoder would prepend U+FFFD before 'ok'; a fresh one yields 'ok'.
    expect(evt[2]).not.toContain('\uFFFD');
    expect(evt[2]).toContain('ok');
  });
});
