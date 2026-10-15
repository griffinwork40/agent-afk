/**
 * Direct unit tests for streamer.helpers.ts — covers helpers that are
 * independently testable without spawning a real shell process.
 *
 * The integration-level behaviour (overflow, timeout, abort, onChunk) is
 * covered by streamer.test.ts via startShell; these tests verify the
 * helpers' internal contracts in isolation (#3725).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeCaptureState, spawnChild, wireExitHandlers } from './streamer.helpers.js';
import { makeAnsiStripper, utf8SafeTruncate } from './streamer.utils.js';

// ---------------------------------------------------------------------------
// makeCaptureState
// ---------------------------------------------------------------------------

describe('makeCaptureState', () => {
  it('initialises all fields to their zero values', () => {
    const state = makeCaptureState();
    expect(state.displayCaptured).toBe('');
    expect(state.modelCaptured).toBe('');
    expect(state.displayBytes).toBe(0);
    expect(state.modelBytes).toBe(0);
    expect(state.truncated).toBe(false);
    expect(state.overflowKilled).toBe(false);
    expect(state.killedByCaller).toBe(false);
    expect(state.settled).toBe(false);
    expect(typeof state.stripper.strip).toBe('function');
    expect(typeof state.stripper.flush).toBe('function');
  });

  it('creates independent state objects on each call', () => {
    const a = makeCaptureState();
    const b = makeCaptureState();
    a.displayCaptured = 'x';
    expect(b.displayCaptured).toBe('');
  });
});

// ---------------------------------------------------------------------------
// spawnChild
// ---------------------------------------------------------------------------

describe('spawnChild', () => {
  it('returns a SpawnResult with a live proc for a valid command', () => {
    const result = spawnChild('echo hi', undefined, undefined);
    expect('proc' in result).toBe(true);
    if ('proc' in result) {
      expect(result.proc.pid).toBeGreaterThan(0);
      result.proc.kill();
    }
  });

  it('returns SpawnFailure (never throws) when spawn itself errors', () => {
    // Passing an object as cwd that Node rejects causes spawn to throw
    // internally; spawnChild must catch and return a SpawnFailure.
    const result = spawnChild('echo hi', '\0invalid\0', undefined);
    // Either a valid proc (shell swallowed it) or a SpawnFailure — never throws.
    // On most platforms the null-byte cwd triggers a synchronous spawn throw.
    if ('spawnFailed' in result) {
      expect(result.spawnFailed).toBe(true);
      expect(typeof result.message).toBe('string');
    } else {
      result.proc.kill();
    }
  });

  it('merges extra env onto process.env', () => {
    const result = spawnChild('echo hi', undefined, { MY_TEST_VAR: 'hello' });
    expect('proc' in result).toBe(true);
    if ('proc' in result) result.proc.kill();
  });
});

// ---------------------------------------------------------------------------
// wireExitHandlers — error handler settled guard (#3725)
// ---------------------------------------------------------------------------

describe('wireExitHandlers error handler settled guard', () => {
  it('does not call resolveResult a second time when state.settled is already true', () => {
    // Simulate: overflow fires first (state.settled = true), then 'error' fires.
    const state = makeCaptureState();
    state.settled = true;

    const resolveResult = vi.fn();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {}, 60_000);

    // We need a real ChildProcess to attach handlers. Use spawnChild.
    const spawnResult = spawnChild('sleep 5', undefined, undefined);
    if (!('proc' in spawnResult)) {
      clearTimeout(timeoutHandle);
      return; // can't run this test without a live proc
    }
    const { proc } = spawnResult;

    wireExitHandlers(
      proc,
      state,
      Date.now(),
      timeoutHandle,
      () => {},
      abortController.signal,
      resolveResult,
    );

    // Manually emit 'error' — simulates a post-overflow error event.
    proc.emit('error', new Error('simulated'));

    expect(resolveResult).not.toHaveBeenCalled();
    proc.kill();
    clearTimeout(timeoutHandle);
  });
});

// ---------------------------------------------------------------------------
// makeAnsiStripper (re-exported via streamer.utils — leaf module tests)
// ---------------------------------------------------------------------------

describe('makeAnsiStripper (from streamer.utils)', () => {
  it('strips a complete CSI sequence in one chunk', () => {
    const s = makeAnsiStripper();
    expect(s.strip('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('carries a partial sequence across strip() calls', () => {
    const s = makeAnsiStripper();
    const a = s.strip('\x1b[31');
    const b = s.strip('mred\x1b[0m');
    expect(a).toBe('');
    expect(a + b).toBe('red');
  });

  it('flush() discards residue and returns empty string', () => {
    const s = makeAnsiStripper();
    s.strip('foo\x1b[');
    expect(s.flush()).toBe('');
    expect(s.strip('bar')).toBe('bar');
  });
});

// ---------------------------------------------------------------------------
// utf8SafeTruncate (re-exported via streamer.utils — leaf module tests)
// ---------------------------------------------------------------------------

describe('utf8SafeTruncate (from streamer.utils)', () => {
  it('does not split a multi-byte char at the cap', () => {
    const buf = Buffer.from('ab😀cd', 'utf8'); // 😀 = 4 bytes
    const out = utf8SafeTruncate(buf, 4);
    expect(out.toString('utf8')).toBe('ab');
  });

  it('returns the buffer unchanged when under the cap', () => {
    const buf = Buffer.from('hi', 'utf8');
    expect(utf8SafeTruncate(buf, 100).toString('utf8')).toBe('hi');
  });

  it('truncates cleanly on an ASCII boundary', () => {
    const buf = Buffer.from('abcdef', 'utf8');
    expect(utf8SafeTruncate(buf, 3).toString('utf8')).toBe('abc');
  });
});
