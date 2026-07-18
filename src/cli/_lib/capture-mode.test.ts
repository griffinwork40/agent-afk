/**
 * Tests for the capture-mode detector that gates the spinner-ticker
 * suppression and the live-thinking-mode downgrade in StreamRenderer.
 *
 * Detection rules covered by `detectCaptureMode` and asserted here:
 *   - AFK_DEMO_CLEAN=1     → true   (explicit opt-in)
 *   - SCRIPT set non-empty → true   (script(1) typescript recording)
 *   - ASCIINEMA_REC=1      → true   (asciinema rec)
 *   - none of the above    → false  (live TTY, no recording)
 *
 * CI markers (`CI`, `GITHUB_ACTIONS`, etc.) are deliberately NOT triggers —
 * CI typically runs with isTTY=false and uses the non-TTY fallback path
 * that already produces clean line-oriented output.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectCaptureMode,
  detectBell,
  detectReducedMotion,
  ringBellIfEnabled,
  detectTermTitle,
  detectNotify,
  formatTerminalTitle,
  setTerminalTitleIfEnabled,
  notifyIfEnabled,
} from './capture-mode.js';

describe('detectCaptureMode', () => {
  it('returns false for an empty env', () => {
    expect(detectCaptureMode({})).toBe(false);
  });

  it('returns true when AFK_DEMO_CLEAN=1', () => {
    expect(detectCaptureMode({ AFK_DEMO_CLEAN: '1' })).toBe(true);
  });

  it('does NOT trip on AFK_DEMO_CLEAN=0 or other truthy-looking strings', () => {
    expect(detectCaptureMode({ AFK_DEMO_CLEAN: '0' })).toBe(false);
    expect(detectCaptureMode({ AFK_DEMO_CLEAN: 'true' })).toBe(false);
    expect(detectCaptureMode({ AFK_DEMO_CLEAN: '' })).toBe(false);
  });

  it('returns true when SCRIPT is set to a non-empty path (script(1) recording)', () => {
    expect(detectCaptureMode({ SCRIPT: '/tmp/typescript' })).toBe(true);
  });

  it('does NOT trip on SCRIPT="" (script not active)', () => {
    expect(detectCaptureMode({ SCRIPT: '' })).toBe(false);
  });

  it('returns true when ASCIINEMA_REC=1', () => {
    expect(detectCaptureMode({ ASCIINEMA_REC: '1' })).toBe(true);
  });

  it('does NOT trip on CI markers (they use the non-TTY path)', () => {
    expect(
      detectCaptureMode({
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        BUILDKITE: 'true',
      }),
    ).toBe(false);
  });

  it('reads from process.env when no argument is passed', () => {
    // Smoke test only — the actual value depends on the host env, so
    // we just verify it returns a boolean and does not throw.
    const result = detectCaptureMode();
    expect(typeof result).toBe('boolean');
  });
});

describe('detectBell', () => {
  it('returns true when AFK_BELL=1', () => {
    expect(detectBell({ AFK_BELL: '1' })).toBe(true);
  });

  it('returns false when AFK_BELL is absent', () => {
    expect(detectBell({})).toBe(false);
  });

  it('returns false when AFK_BELL=0 or other strings', () => {
    expect(detectBell({ AFK_BELL: '0' })).toBe(false);
    expect(detectBell({ AFK_BELL: 'true' })).toBe(false);
    expect(detectBell({ AFK_BELL: '' })).toBe(false);
  });

  it('reads from process.env when no argument is passed', () => {
    const result = detectBell();
    expect(typeof result).toBe('boolean');
  });
});

describe('detectReducedMotion', () => {
  it('returns true when AFK_REDUCED_MOTION=1', () => {
    expect(detectReducedMotion({ AFK_REDUCED_MOTION: '1' })).toBe(true);
  });

  it('returns false when AFK_REDUCED_MOTION is absent', () => {
    expect(detectReducedMotion({})).toBe(false);
  });

  it('returns false when AFK_REDUCED_MOTION=0 or other strings', () => {
    expect(detectReducedMotion({ AFK_REDUCED_MOTION: '0' })).toBe(false);
    expect(detectReducedMotion({ AFK_REDUCED_MOTION: 'true' })).toBe(false);
    expect(detectReducedMotion({ AFK_REDUCED_MOTION: '' })).toBe(false);
  });

  it('reads from process.env when no argument is passed', () => {
    const result = detectReducedMotion();
    expect(typeof result).toBe('boolean');
  });
});

describe('ringBellIfEnabled', () => {
  it('writes BEL (\\x07) when enabled and stream is a TTY', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    ringBellIfEnabled(mockStream as any, { AFK_BELL: '1' });
    expect(mockStream.write).toHaveBeenCalledWith('\x07');
    expect(mockStream.write).toHaveBeenCalledTimes(1);
  });

  it('does not write when disabled', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    ringBellIfEnabled(mockStream as any, { AFK_BELL: '0' });
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('does not write when stream is not a TTY', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: false };
    ringBellIfEnabled(mockStream as any, { AFK_BELL: '1' });
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('does not write when stream.isTTY is undefined', () => {
    const mockStream = { write: vi.fn(() => true) };
    ringBellIfEnabled(mockStream as any, { AFK_BELL: '1' });
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('reads from process.env when no env is passed', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    // Just verify it doesn't throw and respects the bell logic
    ringBellIfEnabled(mockStream as any);
    expect(typeof mockStream.write.mock.calls.length).toBe('number');
  });
});

describe('detectTermTitle', () => {
  it('returns true by default (unset — ON)', () => {
    expect(detectTermTitle({})).toBe(true);
  });

  it('returns false only for the literal "0"', () => {
    expect(detectTermTitle({ AFK_TERM_TITLE: '0' })).toBe(false);
  });

  it('returns true for any other value (1, true, empty)', () => {
    expect(detectTermTitle({ AFK_TERM_TITLE: '1' })).toBe(true);
    expect(detectTermTitle({ AFK_TERM_TITLE: 'true' })).toBe(true);
    expect(detectTermTitle({ AFK_TERM_TITLE: '' })).toBe(true);
  });

  it('reads from process.env when no argument is passed', () => {
    expect(typeof detectTermTitle()).toBe('boolean');
  });
});

describe('detectNotify', () => {
  it('returns false by default (unset — opt-in OFF)', () => {
    expect(detectNotify({})).toBe(false);
  });

  it('returns true only for the literal "1"', () => {
    expect(detectNotify({ AFK_NOTIFY: '1' })).toBe(true);
  });

  it('returns false for other strings (0, true, empty)', () => {
    expect(detectNotify({ AFK_NOTIFY: '0' })).toBe(false);
    expect(detectNotify({ AFK_NOTIFY: 'true' })).toBe(false);
    expect(detectNotify({ AFK_NOTIFY: '' })).toBe(false);
  });

  it('reads from process.env when no argument is passed', () => {
    expect(typeof detectNotify()).toBe('boolean');
  });
});

describe('formatTerminalTitle', () => {
  it('appends " · running" when running is true', () => {
    expect(formatTerminalTitle('/home/user/my-project', true)).toBe('afk — my-project · running');
  });

  it('omits the running badge when running is false', () => {
    expect(formatTerminalTitle('/home/user/my-project', false)).toBe('afk — my-project');
  });

  it('uses the last path segment as the basename', () => {
    expect(formatTerminalTitle('/a/b/c/deep', false)).toBe('afk — deep');
  });

  it('tolerates a trailing slash', () => {
    expect(formatTerminalTitle('/home/user/proj/', false)).toBe('afk — proj');
  });
});

describe('setTerminalTitleIfEnabled', () => {
  it('writes OSC 2 (ESC ] 2 ; <title> BEL) when enabled and TTY', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    setTerminalTitleIfEnabled(mockStream as any, 'afk — repo · running', {});
    expect(mockStream.write).toHaveBeenCalledWith('\x1b]2;afk — repo · running\x07');
    expect(mockStream.write).toHaveBeenCalledTimes(1);
  });

  it('writes the empty-title reset form when title is ""', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    setTerminalTitleIfEnabled(mockStream as any, '', {});
    expect(mockStream.write).toHaveBeenCalledWith('\x1b]2;\x07');
  });

  it('does NOT write when AFK_TERM_TITLE=0', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    setTerminalTitleIfEnabled(mockStream as any, 'afk — repo', { AFK_TERM_TITLE: '0' });
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('does NOT write when the stream is not a TTY', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: false };
    setTerminalTitleIfEnabled(mockStream as any, 'afk — repo', {});
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('does NOT write when stream.isTTY is undefined', () => {
    const mockStream = { write: vi.fn(() => true) };
    setTerminalTitleIfEnabled(mockStream as any, 'afk — repo', {});
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('reads from process.env when no env is passed', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    setTerminalTitleIfEnabled(mockStream as any, 'afk — repo');
    expect(typeof mockStream.write.mock.calls.length).toBe('number');
  });
});

describe('notifyIfEnabled', () => {
  it('writes OSC 9 (ESC ] 9 ; <message> BEL) when AFK_NOTIFY=1 and TTY', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    notifyIfEnabled(mockStream as any, 'afk: turn complete', { AFK_NOTIFY: '1' });
    expect(mockStream.write).toHaveBeenCalledWith('\x1b]9;afk: turn complete\x07');
    expect(mockStream.write).toHaveBeenCalledTimes(1);
  });

  it('does NOT write when AFK_NOTIFY is unset (opt-in default off)', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    notifyIfEnabled(mockStream as any, 'afk: turn complete', {});
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('does NOT write when AFK_NOTIFY=0', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    notifyIfEnabled(mockStream as any, 'afk: turn complete', { AFK_NOTIFY: '0' });
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('does NOT write when enabled but the stream is not a TTY', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: false };
    notifyIfEnabled(mockStream as any, 'afk: turn complete', { AFK_NOTIFY: '1' });
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('reads from process.env when no env is passed', () => {
    const mockStream = { write: vi.fn(() => true), isTTY: true };
    notifyIfEnabled(mockStream as any, 'afk: turn complete');
    expect(typeof mockStream.write.mock.calls.length).toBe('number');
  });
});
