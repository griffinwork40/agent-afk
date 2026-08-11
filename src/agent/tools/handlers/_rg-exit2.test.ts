import { describe, it, expect } from 'vitest';
import { classifyRgExit2 } from './_rg-exit2.js';

const PATH = '/repo/src/cli/session-stats.ts';

describe('classifyRgExit2', () => {
  it('classifies the single-path ENOENT shape as no-such-target', () => {
    // rg's spelling when it is handed exactly one path that is absent.
    const stderr = `rg: ${PATH}: IO error for operation on ${PATH}: No such file or directory (os error 2)\n`;
    const result = classifyRgExit2(stderr, PATH);

    expect(result.failureClass).toBe('no-such-target');
    expect(result.isError).toBe(true);
    expect(result.content).toContain(PATH);
    // The remedy must be actionable: name the tool that resolves paths.
    expect(result.content).toContain('glob');
    expect(result.content).not.toContain('grep error');
  });

  it('classifies the short ENOENT shape as no-such-target', () => {
    const stderr = `rg: ${PATH}: No such file or directory (os error 2)`;
    const result = classifyRgExit2(stderr, PATH);

    expect(result.failureClass).toBe('no-such-target');
    expect(result.content).toContain(PATH);
  });

  it('tolerates surrounding whitespace and blank lines', () => {
    const stderr = `\n  rg: ${PATH}: No such file or directory (os error 2)  \n\n`;
    expect(classifyRgExit2(stderr, PATH).failureClass).toBe('no-such-target');
  });

  it('leaves a permission failure unclassified (os error 13 is not os error 2)', () => {
    // Shaped almost identically to the ENOENT line — the trailing-sentinel
    // anchor is what keeps it out of the benign bucket.
    const stderr = `rg: ${PATH}: Permission denied (os error 13)`;
    const result = classifyRgExit2(stderr, PATH);

    expect(result.failureClass).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content).toContain('grep error');
    expect(result.content).toContain('Permission denied');
  });

  it('leaves a regex parse error unclassified', () => {
    const stderr = 'rg: regex parse error:\n    (unclosed\n    ^\nerror: unclosed group';
    const result = classifyRgExit2(stderr, PATH);

    expect(result.failureClass).toBeUndefined();
    expect(result.content).toContain('grep error');
    expect(result.content).toContain('unclosed group');
  });

  it('stays generic when a missing path is mixed with another failure', () => {
    // A mixed stderr means something beyond a bad path went wrong; reporting it
    // as merely a missing path would hide the real fault.
    const stderr =
      `rg: ${PATH}: No such file or directory (os error 2)\n` +
      'rg: /repo/other.ts: Permission denied (os error 13)';
    const result = classifyRgExit2(stderr, PATH);

    expect(result.failureClass).toBeUndefined();
    expect(result.content).toContain('grep error');
  });

  it('stays generic when the ENOENT line names some other path', () => {
    const stderr = 'rg: /elsewhere/gone.ts: No such file or directory (os error 2)';
    expect(classifyRgExit2(stderr, PATH).failureClass).toBeUndefined();
  });

  it('stays generic on empty or whitespace-only stderr', () => {
    for (const stderr of ['', '   ', '\n\n']) {
      const result = classifyRgExit2(stderr, PATH);
      expect(result.failureClass).toBeUndefined();
      expect(result.isError).toBe(true);
      expect(result.content).toContain('grep error');
    }
  });
});
