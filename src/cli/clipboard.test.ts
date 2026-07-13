/**
 * Tests for src/cli/clipboard.ts
 *
 * Selection logic and the OSC 52 encoder / DCS wrapper / $TMUX gating / TTY
 * gating are tested deterministically (no spawning, no real terminal — the
 * write sink is injected). The external-tool spawn path is exercised only via
 * the never-throws contract — a bogus platform must still resolve to a boolean
 * rather than crash a caller like /fork.
 */

import { describe, it, expect } from 'vitest';
import {
  clipboardToolsFor,
  copyToClipboard,
  copyViaOsc52,
  osc52ClipboardSequence,
  osc52Copy,
  wrapTmuxPassthrough,
  type Osc52Sink,
} from './clipboard.js';

/** A recording write sink; `isTTY` controls the OSC 52 gate. */
function makeSink(isTTY: boolean | undefined): Osc52Sink & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    isTTY,
    chunks,
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
  };
}

describe('clipboardToolsFor', () => {
  it('uses pbcopy on macOS', () => {
    const tools = clipboardToolsFor('darwin');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.cmd).toBe('pbcopy');
  });

  it('uses clip on Windows', () => {
    expect(clipboardToolsFor('win32')[0]!.cmd).toBe('clip');
  });

  it('prefers wl-copy then xclip then xsel on Linux', () => {
    const cmds = clipboardToolsFor('linux').map((t) => t.cmd);
    expect(cmds).toEqual(['wl-copy', 'xclip', 'xsel']);
  });
});

describe('osc52Copy (OSC 52 encoder)', () => {
  it('encodes text as base64 in a "c"-selection sequence terminated by BEL', () => {
    // 'hi' → base64 'aGk=' ; wire format ESC ] 52 ; c ; <b64> BEL.
    expect(osc52Copy('hi')).toBe('\x1b]52;c;aGk=\x07');
  });

  it('base64 round-trips arbitrary utf8 (newlines, spaces, unicode)', () => {
    const text = 'line1\nlíne2 🚀';
    const seq = osc52Copy(text);
    const m = /^\x1b\]52;c;(.*)\x07$/.exec(seq);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1]!, 'base64').toString('utf8')).toBe(text);
  });

  it('carries exactly one ESC (the introducer) — base64 + BEL add none', () => {
    // Load-bearing for tmux passthrough: only the leading ESC needs doubling.
    expect(osc52Copy('anything at all').split('\x1b')).toHaveLength(2);
  });
});

describe('wrapTmuxPassthrough (DCS envelope)', () => {
  it('wraps a sequence in ESC P tmux ; … ESC \\ and doubles the ESC', () => {
    expect(wrapTmuxPassthrough('\x1b]52;c;aGk=\x07')).toBe(
      '\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\',
    );
  });

  it('doubles every ESC byte in a multi-ESC payload', () => {
    expect(wrapTmuxPassthrough('\x1bA\x1bB')).toBe('\x1bPtmux;\x1b\x1bA\x1b\x1bB\x1b\\');
  });
});

describe('osc52ClipboardSequence ($TMUX gating)', () => {
  it('returns the bare OSC 52 sequence when $TMUX is unset', () => {
    expect(osc52ClipboardSequence('hi', {})).toBe(osc52Copy('hi'));
  });

  it('wraps in the tmux DCS passthrough envelope when $TMUX is set', () => {
    expect(osc52ClipboardSequence('hi', { TMUX: '/tmp/tmux-1000/default,123,0' })).toBe(
      wrapTmuxPassthrough(osc52Copy('hi')),
    );
  });

  it('treats an empty-string $TMUX as "not in tmux" (matches detectTerminal truthiness)', () => {
    expect(osc52ClipboardSequence('hi', { TMUX: '' })).toBe(osc52Copy('hi'));
  });
});

describe('copyViaOsc52 (TTY-gated emitter)', () => {
  it('writes the bare sequence to a TTY sink and returns true (no tmux)', () => {
    const sink = makeSink(true);
    expect(copyViaOsc52('hi', {}, sink)).toBe(true);
    expect(sink.chunks.join('')).toBe(osc52Copy('hi'));
  });

  it('writes the tmux-wrapped sequence when $TMUX is set', () => {
    const sink = makeSink(true);
    expect(copyViaOsc52('hi', { TMUX: 'x' }, sink)).toBe(true);
    expect(sink.chunks.join('')).toBe(wrapTmuxPassthrough(osc52Copy('hi')));
  });

  it('is a no-op (false, writes nothing) when isTTY is undefined — piped output', () => {
    const sink = makeSink(undefined);
    expect(copyViaOsc52('hi', {}, sink)).toBe(false);
    expect(sink.chunks).toHaveLength(0);
  });

  it('is a no-op when isTTY is false', () => {
    const sink = makeSink(false);
    expect(copyViaOsc52('hi', {}, sink)).toBe(false);
    expect(sink.chunks).toHaveLength(0);
  });

  it('never throws — a write() that throws resolves to false', () => {
    const throwingSink: Osc52Sink = {
      isTTY: true,
      write(): boolean {
        throw new Error('backpressure explosion');
      },
    };
    let result: unknown;
    expect(() => {
      result = copyViaOsc52('hi', {}, throwingSink);
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

describe('copyToClipboard', () => {
  it('always returns a boolean and never throws (best-effort contract)', () => {
    // Platform-agnostic: whatever the host, a missing utility resolves to
    // false rather than crashing the caller. Asserting the type (not a fixed
    // value) keeps this non-flaky across dev machines that may have xclip etc.
    let result: unknown;
    expect(() => {
      result = copyToClipboard('hello', 'win32');
    }).not.toThrow();
    expect(typeof result).toBe('boolean');
  });

  // The win32 tool (`clip`) is absent on the POSIX test hosts (CI = ubuntu,
  // dev = macOS), so the external-tool loop exhausts and the OSC 52 fallback
  // fires deterministically. Skipped on Windows, where a real `clip` would
  // intercept before the fallback is reached.
  it.skipIf(process.platform === 'win32')(
    'falls back to OSC 52 when no local tool succeeds',
    () => {
      const sink = makeSink(true);
      const ok = copyToClipboard('hi', 'win32', {}, sink);
      expect(ok).toBe(true);
      expect(sink.chunks.join('')).toBe(osc52Copy('hi'));
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not emit OSC 52 into a non-TTY sink (piped output stays clean)',
    () => {
      const sink = makeSink(false);
      const ok = copyToClipboard('hi', 'win32', {}, sink);
      expect(sink.chunks).toHaveLength(0);
      expect(ok).toBe(false);
    },
  );
});
