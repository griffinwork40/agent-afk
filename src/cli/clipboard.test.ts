/**
 * Tests for src/cli/clipboard.ts
 *
 * Selection logic is tested deterministically (no spawning). The spawn path
 * is exercised only via the never-throws contract — a bogus platform must
 * still resolve to a boolean rather than crash a caller like /fork.
 */

import { describe, it, expect } from 'vitest';
import { clipboardToolsFor, copyToClipboard } from './clipboard.js';

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
});
