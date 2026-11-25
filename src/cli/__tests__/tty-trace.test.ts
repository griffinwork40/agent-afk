/**
 * Unit tests for the TTY trace recorder (src/cli/tty-trace.ts).
 *
 * Uses the injectable FsOps interface instead of vi.spyOn on node:fs (ESM
 * named exports are non-configurable and cannot be spied on in Vitest).
 */

import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FsOps } from '../tty-trace.js';
import { installTtyTrace, uninstallTtyTrace, pauseTtyTrace, resumeTtyTrace } from '../tty-trace.js';

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
    fchmodSync(_fd: number, _mode: number): void {},
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
    // Output flushes the pending resize before recording its own event.
    process.stdout.write('after resize');

    const newLines = fs.lines.slice(before);
    const resizeLines = newLines.filter((l) => {
      try { const e = JSON.parse(l.trim()) as unknown[]; return e[1] === 'r'; } catch { return false; }
    });
    expect(resizeLines.length).toBeGreaterThanOrEqual(1);
    const evt = JSON.parse(resizeLines[0]!.trim()) as [number, string, string];
    expect(evt[1]).toBe('r');
    expect(evt[2]).toMatch(/\d+x\d+/);
  });

  it('coalesces a resize burst to its final size', () => {
    vi.useFakeTimers();
    try {
      const fs = makeFakeFsOps();
      installTtyTrace(fs);
      const before = fs.lines.length;
      for (let cols = 81; cols <= 120; cols++) {
        setTTYProps(true, cols, 40);
        process.stdout.emit('resize');
      }
      expect(fs.lines.length).toBe(before);
      vi.advanceTimersByTime(50);
      expect(fs.lines.slice(before).map((line) => JSON.parse(line))).toEqual([
        [expect.any(Number), 'r', '120x40'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a pending resize before output and on uninstall without late writes', () => {
    vi.useFakeTimers();
    try {
      const fs = makeFakeFsOps();
      installTtyTrace(fs);
      const before = fs.lines.length;
      setTTYProps(true, 100, 30);
      process.stdout.emit('resize');
      process.stdout.write('after resize');
      setTTYProps(true, 110, 35);
      process.stdout.emit('resize');
      uninstallTtyTrace();
      const events = fs.lines.slice(before).map((line) => JSON.parse(line));
      expect(events).toEqual([
        [expect.any(Number), 'r', '100x30'],
        [expect.any(Number), 'o', 'after resize'],
        [expect.any(Number), 'r', '110x35'],
      ]);
      expect(fs.closed).toBe(true);
      vi.runAllTimers();
      expect(fs.lines.length).toBe(before + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns when reinstall is attempted after failure, without throwing or reopening', () => {
    const stderrSpy = process.stderr.write as ReturnType<typeof vi.fn>;
    const fs = makeFakeFsOps();
    const openSpy = vi.spyOn(fs, 'openSync');
    const writeSpy = vi.spyOn(fs, 'writeSync');
    installTtyTrace(fs);
    fs.throwOnWrite = true;
    process.stdout.write('trigger failure');
    stderrSpy.mockClear();
    expect(() => installTtyTrace(fs)).not.toThrow();
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('uninstallTtyTrace'));
    // The disable/reinstall warnings must not be recorded into the cast.
    expect(fs.lines).toHaveLength(1);
    expect(writeSpy).toHaveBeenCalledTimes(2); // header + failed output, no warnings
  });

  it('disables safely when a deferred resize write fails', () => {
    vi.useFakeTimers();
    try {
      const fs = makeFakeFsOps();
      const stderrSpy = process.stderr.write as ReturnType<typeof vi.fn>;
      installTtyTrace(fs);
      stderrSpy.mockClear();
      process.stdout.emit('resize');
      fs.throwOnWrite = true;
      expect(() => vi.advanceTimersByTime(50)).not.toThrow();
      expect(fs.closed).toBe(true);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(fs.lines).toHaveLength(1);
      // A failed resize flush must not swallow the original output either.
      expect(() => process.stdout.write('still usable')).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('can reinstall after uninstalling a disabled recorder', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    fs.throwOnWrite = true;
    process.stdout.write('trigger failure');
    uninstallTtyTrace();
    const replacement = makeFakeFsOps();
    installTtyTrace(replacement);
    process.stdout.write('new recording');
    expect(replacement.lines).toHaveLength(2);
    expect(JSON.parse(replacement.lines[1]!)[2]).toBe('new recording');
  });

  it('serializes only the allowlisted TERM environment key', () => {
    const fs = makeFakeFsOps();
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('TTY_TRACE_TEST_SECRET', 'must-not-be-recorded');
    try {
      installTtyTrace(fs);
      expect(JSON.parse(fs.lines[0]!).env).toEqual({ TERM: 'xterm-256color' });
      expect(fs.lines[0]).not.toContain('must-not-be-recorded');
    } finally {
      vi.unstubAllEnvs();
    }
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

  // 14b. A pre-existing world-readable file is tightened to 0o600 (real fs)
  it('tightens a pre-existing 0o644 cast file to 0o600', () => {
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'afk-tty-trace-'));
    try {
      const file = path.join(dir, 'existing.cast');
      realFs.writeFileSync(file, 'old contents\n', { mode: 0o644 });
      realFs.chmodSync(file, 0o644); // defeat umask so the file really is 0o644
      process.env['AFK_TTY_TRACE'] = file;
      installTtyTrace();
      uninstallTtyTrace();
      const contents = realFs.readFileSync(file, 'utf8');
      expect(contents.startsWith('{"version":2')).toBe(true);
      // POSIX modes do not apply on Windows; only the mode assertion is guarded.
      if (process.platform !== 'win32') {
        expect(realFs.statSync(file).mode & 0o777).toBe(0o600);
      }
    } finally {
      realFs.rmSync(dir, { recursive: true, force: true });
    }
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

  // 17. ~/path expansion uses path.join (no double-slash, normalised)
  it('expands ~/path correctly without double slashes', () => {
    process.env['AFK_TTY_TRACE'] = '~/afk-tty.cast';
    const fs = makeFakeFsOps();
    let openedPath = '';
    fs.openSync = (p: string, _f: string, mode?: number): number => {
      openedPath = p;
      fs.lastOpenMode = mode;
      return 42;
    };
    installTtyTrace(fs);
    expect(openedPath).not.toContain('//');
    expect(openedPath).toMatch(/afk-tty\.cast$/);
    expect(openedPath).not.toMatch(/^~\//);
  });
});

// ── pause / resume ────────────────────────────────────────────────────────────

describe('tty-trace pause/resume', () => {
  it('is a no-op (never throws) when no recorder is installed', () => {
    expect(() => pauseTtyTrace()).not.toThrow();
    expect(() => resumeTtyTrace()).not.toThrow();
  });

  it('still passes output through to the terminal while paused', () => {
    const fs = makeFakeFsOps();
    const terminal = vi.fn().mockReturnValue(true);
    process.stdout.write = terminal as unknown as typeof process.stdout.write;
    installTtyTrace(fs);
    pauseTtyTrace();
    process.stdout.write('live output');
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]?.[0]).toBe('live output');
    resumeTtyTrace();
  });

  it('omits paused output from the cast and records it again after resume', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    pauseTtyTrace();
    process.stdout.write('secret-from-others');
    resumeTtyTrace();
    process.stdout.write('after-resume');
    const all = fs.lines.join('');
    expect(all).not.toContain('secret-from-others');
    expect(all).toContain('after-resume');
  });

  it('writes a visible marker only on the first pause per install', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    pauseTtyTrace();
    resumeTtyTrace();
    pauseTtyTrace();
    resumeTtyTrace();
    const markers = fs.lines.filter((l) => l.includes('output omitted for a private view'));
    expect(markers.length).toBe(1);
  });

  it('keeps recording paused until the outermost resume (nesting-safe)', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    pauseTtyTrace();
    pauseTtyTrace();
    resumeTtyTrace();
    process.stdout.write('still-paused');
    expect(fs.lines.join('')).not.toContain('still-paused');
    resumeTtyTrace();
    process.stdout.write('now-recording');
    expect(fs.lines.join('')).toContain('now-recording');
  });

  it('ignores extra resume calls without going negative', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    resumeTtyTrace();
    resumeTtyTrace();
    pauseTtyTrace();
    process.stdout.write('paused-once');
    expect(fs.lines.join('')).not.toContain('paused-once');
    resumeTtyTrace();
  });

  it('clears pause state on uninstall so a reinstall starts recording', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    pauseTtyTrace();
    uninstallTtyTrace();
    const fs2 = makeFakeFsOps();
    installTtyTrace(fs2);
    process.stdout.write('fresh');
    expect(fs2.lines.join('')).toContain('fresh');
    expect(fs2.lines.join('')).not.toContain('output omitted for a private view');
  });

  it('never throws when the recorder is disabled by a write error', () => {
    const fs = makeFakeFsOps();
    installTtyTrace(fs);
    fs.throwOnWrite = true;
    expect(() => pauseTtyTrace()).not.toThrow();
    expect(() => resumeTtyTrace()).not.toThrow();
  });
});
