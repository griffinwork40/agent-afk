/**
 * Regression guard for `afk improve eval-run`'s process exit code.
 *
 * History: `unsupported` — the status the runner returns when an eval-case's
 * pattern has NO registered contract, i.e. when the run asserted literally
 * nothing — shared exit code 0 with a genuine `pass`. Any CI gate wired as
 * `afk improve eval-run <case> && deploy` would therefore have green-lit every
 * pattern lacking a contract (at the time: `subagent-read-denial`) exactly as
 * if its guardrail had been verified.
 *
 * `unsupported` now exits 3 — distinct from `fail`/`error` (1) so a gate can
 * tolerate "no contract yet" without also tolerating a regression, and distinct
 * from CLI argument errors (2, see parsePositiveInt / parseRate).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyEvalRunExit } from './improve.js';

describe('applyEvalRunExit', () => {
  let original: number | undefined;

  beforeEach(() => {
    original = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = original;
  });

  it('leaves exit code unset for pass', () => {
    applyEvalRunExit('pass');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 for fail', () => {
    applyEvalRunExit('fail');
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 for error', () => {
    applyEvalRunExit('error');
    expect(process.exitCode).toBe(1);
  });

  it('exits 3 for unsupported — NOT 0, and NOT the same code as a regression', () => {
    applyEvalRunExit('unsupported');
    expect(process.exitCode).toBe(3);
  });

  it('gives unsupported a code distinct from pass, fail and arg-error', () => {
    // The whole point of the fix: a gate must be able to tell "verified" from
    // "nothing was checked" from "regressed" from "you typed the flag wrong".
    const codeFor = (s: Parameters<typeof applyEvalRunExit>[0]): number => {
      process.exitCode = undefined;
      applyEvalRunExit(s);
      return process.exitCode ?? 0;
    };

    const pass = codeFor('pass');
    const fail = codeFor('fail');
    const unsupported = codeFor('unsupported');

    expect(pass).toBe(0);
    expect(new Set([pass, fail, unsupported]).size).toBe(3);
    expect(unsupported).not.toBe(2); // 2 is reserved for CLI argument errors
  });
});
