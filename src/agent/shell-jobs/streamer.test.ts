import { describe, it, expect } from 'vitest';
import { startShell, makeAnsiStripper, utf8SafeTruncate } from './streamer.js';

function newAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('startShell', () => {
  it('runs a simple command and returns exit 0', async () => {
    const handle = startShell({
      command: 'echo hello',
      abort: newAbortSignal(),
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.errorReason).toBeUndefined();
    expect(result.displayCaptured).toContain('hello');
    expect(result.modelCaptured).toContain('hello');
    expect(result.truncated).toBe(false);
  });

  it('captures stderr alongside stdout', async () => {
    const handle = startShell({
      command: 'echo out; echo err 1>&2',
      abort: newAbortSignal(),
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.displayCaptured).toContain('out');
    expect(result.displayCaptured).toContain('err');
  });

  it('streams chunks via onChunk before the promise settles', async () => {
    const chunks: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
    const handle = startShell({
      command: 'echo first; echo second',
      abort: newAbortSignal(),
      onChunk: (buf, stream) => {
        chunks.push({ text: buf.toString('utf8'), stream });
      },
    });
    await handle.promise;
    expect(chunks.length).toBeGreaterThan(0);
    const combined = chunks.map((c) => c.text).join('');
    expect(combined).toContain('first');
    expect(combined).toContain('second');
  });

  it('reports nonzero exit code with errorReason=nonzero-exit', async () => {
    const handle = startShell({
      command: 'exit 7',
      abort: newAbortSignal(),
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(7);
    expect(result.errorReason).toBe('nonzero-exit');
    expect(result.errorMessage).toContain('7');
  });

  it('reports signal-killed when the process dies from an unrequested signal', async () => {
    // `kill -9 $$` makes the spawned shell SIGKILL itself: `close` fires with
    // code=null + a signal, and we never called handle.kill()/abort. This is
    // the segfault / OOM-killer / external-kill / self-signal path. Without the
    // M2 guard it would fall through to a success resolve and tell the model a
    // crashed command "succeeded". (PR #565 review: M2.)
    const handle = startShell({
      command: 'kill -9 $$',
      abort: newAbortSignal(),
    });
    const result = await handle.promise;
    expect(result.exitCode).toBeNull();
    expect(result.errorReason).toBe('signal-killed');
    expect(result.errorMessage).toMatch(/signal/i);
  });

  it('honours cwd', async () => {
    const handle = startShell({
      command: 'pwd',
      cwd: '/tmp',
      abort: newAbortSignal(),
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    // macOS resolves /tmp to /private/tmp; accept either.
    expect(result.displayCaptured).toMatch(/(^|\/)tmp/);
  });

  it('honours an extra env entry', async () => {
    const handle = startShell({
      command: 'echo "$AFK_SHELL_TEST"',
      abort: newAbortSignal(),
      env: { AFK_SHELL_TEST: 'pingback' },
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.displayCaptured).toContain('pingback');
  });

  it('times out and reports errorReason=timeout', async () => {
    const handle = startShell({
      command: 'sleep 2',
      abort: newAbortSignal(),
      timeoutMs: 100,
    });
    const result = await handle.promise;
    expect(result.errorReason).toBe('timeout');
    expect(result.errorMessage).toContain('100');
  });

  it('aborts via the abort signal', async () => {
    const ac = new AbortController();
    const handle = startShell({
      command: 'sleep 5',
      abort: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    const result = await handle.promise;
    expect(result.errorReason).toBe('abort');
  });

  it('kill() cancels a running process and reports abort', async () => {
    const handle = startShell({
      command: 'sleep 5',
      abort: newAbortSignal(),
    });
    setTimeout(() => handle.kill(), 50);
    const result = await handle.promise;
    expect(result.errorReason).toBe('abort');
    expect(result.errorMessage).toContain('killed');
  });

  it('strips ANSI escape sequences from the model buffer only', async () => {
    // Build the ESC sequence at runtime so the source file stays printable.
    const cmd = `printf '\\033[31mred\\033[0m\\n'`;
    const handle = startShell({
      command: cmd,
      abort: newAbortSignal(),
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    // Display buffer keeps ANSI; model buffer is clean.
    expect(result.displayCaptured).toContain('\x1b[31m');
    expect(result.modelCaptured).toBe('red\n');
  });

  it('caps captured output at maxBytes and marks truncated', async () => {
    // Emit ~5000 bytes with a 1000-byte cap.
    const handle = startShell({
      command: 'yes hello | head -c 5000',
      abort: newAbortSignal(),
      maxBytes: 1000,
    });
    const result = await handle.promise;
    // We can hit either:
    //   - cap before exit → overflowKilled (errorReason='overflow')
    //   - cap after exit (rare for fast commands) → truncated:true, no error
    // Either way the captured size should not exceed the cap.
    expect(result.displayCaptured.length).toBeLessThanOrEqual(1000);
    expect(result.modelCaptured.length).toBeLessThanOrEqual(1000);
    expect(result.truncated).toBe(true);
  });

  it('survives a throwing onChunk callback', async () => {
    const handle = startShell({
      command: 'echo ok',
      abort: newAbortSignal(),
      onChunk: () => {
        throw new Error('boom');
      },
    });
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
    expect(result.displayCaptured).toContain('ok');
  });

  it('reports spawn-failed for an invalid command path', async () => {
    // With shell: true the OS shell runs and exits nonzero rather than
    // spawn() failing; assert nonzero-exit instead.
    const handle = startShell({
      command: '/this/path/does/not/exist/at/all',
      abort: newAbortSignal(),
    });
    const result = await handle.promise;
    expect(result.errorReason).toBe('nonzero-exit');
  });

  it('kills the child and reports errorReason=overflow when the cap is crossed mid-run (L2)', async () => {
    // A long-running flood (cap crossed BEFORE the child would exit on its
    // own) must hit the overflow kill path — not merely post-exit truncation.
    // `yes` never terminates, so the only way this promise settles is the
    // cap-crossing kill. This locks the hardening the prior round landed.
    const handle = startShell({
      command: 'yes overflowing-line',
      abort: newAbortSignal(),
      maxBytes: 2000,
    });
    const result = await handle.promise;
    expect(result.errorReason).toBe('overflow');
    expect(result.truncated).toBe(true);
    expect(result.errorMessage).toContain('2000');
    // Killed by signal → no clean exit code.
    expect(result.exitCode).toBeNull();
    // Neither buffer exceeds the cap.
    expect(result.displayCaptured.length).toBeLessThanOrEqual(2000);
    expect(result.modelCaptured.length).toBeLessThanOrEqual(2000);
  });
});

describe('makeAnsiStripper (cross-chunk split — H-2 fix, L3)', () => {
  it('stitches an ESC sequence split across two strip() calls', () => {
    const strip = makeAnsiStripper();
    // CSI red split between the "[31" and the "m" terminator.
    const a = strip.strip('\x1b[31');
    const b = strip.strip('mred\x1b[0m');
    // The partial sequence must be held, not emitted, on the first call.
    expect(a).toBe('');
    // Once completed on the second call, the whole sequence is stripped.
    expect(a + b).toBe('red');
  });

  it('holds an OSC sequence split mid-body across calls', () => {
    const strip = makeAnsiStripper();
    // OSC hyperlink, split before the BEL terminator.
    const a = strip.strip('before\x1b]8;;http://x');
    const b = strip.strip('\x07after');
    expect(a).toBe('before');
    expect(a + b).toBe('beforeafter');
  });

  it('holds a DCS sequence split right after the ESC P introducer', () => {
    // Regression for the single-char-ESC-alt bug: `ESC P` (0x50) is inside the
    // naive 0x40-0x5F single-char range, so a too-greedy regex would strip the
    // 2-byte introducer and leak the body. The introducer must be held instead.
    const strip = makeAnsiStripper();
    const a = strip.strip('x\x1bP1;2');
    const b = strip.strip('data\x1b\\y'); // ST = ESC backslash
    expect(a).toBe('x');
    expect(a + b).toBe('xy');
  });

  it('holds an APC sequence split right after the ESC _ introducer', () => {
    const strip = makeAnsiStripper();
    const a = strip.strip('p\x1b_payload');
    const b = strip.strip('\x07q');
    expect(a).toBe('p');
    expect(a + b).toBe('pq');
  });

  it('still strips a complete window-title OSC in one chunk', () => {
    const strip = makeAnsiStripper();
    expect(strip.strip('\x1b]0;my-title\x07done')).toBe('done');
  });

  it('still strips a single-char ESC final that is NOT a string introducer', () => {
    // ESC M (reverse index, 0x4D) must remain a stripped single-char sequence.
    const strip = makeAnsiStripper();
    expect(strip.strip('a\x1bMb')).toBe('ab');
  });

  it('flush() discards a dangling partial sequence rather than leaking raw bytes', () => {
    const strip = makeAnsiStripper();
    const out = strip.strip('foo\x1b[');
    expect(out).toBe('foo'); // partial CSI held back
    expect(strip.flush()).toBe(''); // residue discarded, not surfaced
    // After flush the stripper is reusable and starts clean.
    expect(strip.strip('bar')).toBe('bar');
  });

  it('passes through plain text untouched', () => {
    const strip = makeAnsiStripper();
    expect(strip.strip('hello world\n')).toBe('hello world\n');
  });
});

describe('utf8SafeTruncate (multi-byte boundary — H-5 fix, L4)', () => {
  it('does not split a multi-byte char straddling the byte cap', () => {
    // '😀' is 4 bytes (F0 9F 98 80). Place text so the cap lands mid-emoji.
    const text = 'ab😀cd';
    const buf = Buffer.from(text, 'utf8');
    // 'ab' = 2 bytes; cap at 4 lands 2 bytes into the 4-byte emoji.
    const out = utf8SafeTruncate(buf, 4);
    const decoded = out.toString('utf8');
    // Must NOT contain the U+FFFD replacement char (no mid-codepoint cut).
    expect(decoded).not.toContain('\uFFFD');
    // The emoji's leading bytes were dropped cleanly back to the 'ab' boundary.
    expect(decoded).toBe('ab');
  });

  it('keeps a multi-byte char that fits exactly at the cap', () => {
    const buf = Buffer.from('ab😀', 'utf8'); // 2 + 4 = 6 bytes
    const out = utf8SafeTruncate(buf, 6);
    expect(out.toString('utf8')).toBe('ab😀');
  });

  it('returns the buffer unchanged when under the cap', () => {
    const buf = Buffer.from('short', 'utf8');
    const out = utf8SafeTruncate(buf, 1000);
    expect(out.toString('utf8')).toBe('short');
  });

  it('truncates cleanly on an ASCII boundary', () => {
    const buf = Buffer.from('abcdef', 'utf8');
    expect(utf8SafeTruncate(buf, 3).toString('utf8')).toBe('abc');
  });
});
