import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printWarnings } from './print-warnings.js';

describe('printWarnings', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false and prints nothing when warnings is empty', () => {
    const result = printWarnings([]);
    expect(result).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns false when all warnings are non-error', () => {
    const result = printWarnings(['just a warning', 'another note']);
    expect(result).toBe(false);
  });

  it('returns true when at least one warning starts with [ERROR]', () => {
    const result = printWarnings(['[ERROR] something failed', 'a note']);
    expect(result).toBe(true);
  });

  it('prints [ERROR] items to console.error', () => {
    printWarnings(['[ERROR] failed']);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls.flat().some((s: unknown) => typeof s === 'string' && s.includes('failed'))).toBe(false);
  });

  it('prints non-error items to console.log', () => {
    printWarnings(['just a note']);
    expect(errorSpy).not.toHaveBeenCalled();
    // console.log is called for the blank line + the warning
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it('prints a blank line before the list when non-empty', () => {
    printWarnings(['something']);
    expect(logSpy.mock.calls[0]).toEqual(['']);
  });

  it('handles a mix of [ERROR] and plain warnings', () => {
    printWarnings(['note', '[ERROR] oops', 'another note']);
    expect(errorSpy).toHaveBeenCalledOnce();
    // blank line + 2 plain warnings
    expect(logSpy).toHaveBeenCalledTimes(3);
  });
});
