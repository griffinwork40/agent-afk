/**
 * Unit tests for presentError and handleCommandError. Written TDD-first.
 *
 * TTY vs. non-TTY rendering, debug-stack path, and exit code propagation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { presentError } from './presenter.js';
import { handleCommandError } from './index.js';
import { TimeoutError } from '../../utils/errors.js';
import type { ClassifiedError } from './classifier.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClassified(overrides: Partial<ClassifiedError> = {}): ClassifiedError {
  return {
    kind: 'unknown',
    userMessage: 'Something went wrong',
    exitCode: 1,
    raw: new Error('test error'),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up debug env
  delete process.env['AFK_DEBUG'];
  delete process.env['DEBUG'];
});

// ─── TTY mode ────────────────────────────────────────────────────────────────

describe('presentError — TTY mode', () => {
  it('renders errorBox borders (╭─ / ╰─) in TTY mode', () => {
    const chunks: string[] = [];
    const write = (s: string) => { chunks.push(s); };
    const classified = makeClassified({ userMessage: 'Something went wrong' });

    presentError(classified, { isTTY: true, write });

    const output = chunks.join('');
    expect(output).toContain('╭');
    expect(output).toContain('╰');
  });
});

// ─── Non-TTY mode ────────────────────────────────────────────────────────────

describe('presentError — non-TTY mode', () => {
  it('renders "afk: error:" prefix without box borders in non-TTY mode', () => {
    const chunks: string[] = [];
    const write = (s: string) => { chunks.push(s); };
    const classified = makeClassified({ userMessage: 'Something went wrong' });

    presentError(classified, { isTTY: false, write });

    const output = chunks.join('');
    expect(output).toContain('afk: error:');
    expect(output).not.toContain('╭');
    expect(output).not.toContain('╰');
  });

  it('includes hint in parentheses when hint is present', () => {
    const chunks: string[] = [];
    const write = (s: string) => { chunks.push(s); };
    const classified = makeClassified({
      userMessage: 'Auth failed',
      hint: 'check your API key',
    });

    presentError(classified, { isTTY: false, write });

    const output = chunks.join('');
    expect(output).toContain('(check your API key)');
  });
});

// ─── Debug mode ──────────────────────────────────────────────────────────────

describe('presentError — debug mode', () => {
  it('appends stack trace when AFK_DEBUG=1 and raw has a stack', () => {
    process.env['AFK_DEBUG'] = '1';
    const rawErr = new Error('test');
    rawErr.stack = 'Error: test\n  at fakeFunc (fake.ts:1:1)';

    const chunks: string[] = [];
    const write = (s: string) => { chunks.push(s); };
    const classified = makeClassified({ raw: rawErr });

    presentError(classified, { isTTY: false, write });

    const output = chunks.join('');
    expect(output).toContain('at fakeFunc');
  });

  it('does NOT append stack trace when AFK_DEBUG is unset', () => {
    delete process.env['AFK_DEBUG'];
    delete process.env['DEBUG'];
    const rawErr = new Error('test');
    rawErr.stack = 'Error: test\n  at secretFunc (secret.ts:1:1)';

    const chunks: string[] = [];
    const write = (s: string) => { chunks.push(s); };
    const classified = makeClassified({ raw: rawErr });

    presentError(classified, { isTTY: false, write });

    const output = chunks.join('');
    expect(output).not.toContain('at secretFunc');
  });
});

// ─── Exit codes via handleCommandError ───────────────────────────────────────

describe('handleCommandError — exit codes', () => {
  it('calls process.exit(124) for TimeoutError', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });

    const err = new TimeoutError('timed out', 30000);
    expect(() => handleCommandError(err)).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(124);
  });

  it('calls process.exit(1) for unknown Error', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });

    const err = new Error('random unknown error');
    expect(() => handleCommandError(err)).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
