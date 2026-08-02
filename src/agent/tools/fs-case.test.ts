/**
 * Unit tests for the case-awareness helpers behind the credential floors.
 *
 * Covers:
 * - `pathIsWithin` exact-match behaviour is identical on both volume kinds.
 * - Case-variant spellings match ONLY when the volume is case-insensitive
 *   (#736): `~/.SSH/id_rsa` must be denied on macOS-style volumes and must NOT
 *   be conflated with `~/.ssh` on a case-sensitive one, where it is a genuinely
 *   different directory.
 * - The prefix boundary is respected under folding: `/home/user/.sshx` is not
 *   inside `/home/user/.ssh`.
 * - `textMentionsPath` mirrors the same contract for the bash hook's substring
 *   scan.
 * - The probe never throws and always yields a boolean.
 *
 * Every case forces the volume kind via `_resetFsCaseCacheForTests` rather than
 * reading the ambient filesystem, so the suite is deterministic on
 * case-sensitive Linux CI and case-insensitive macOS alike. (Asserting against
 * the real volume would reintroduce exactly the ambient-state dependence that
 * made #795 flake.)
 *
 * @module agent/tools/fs-case.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  pathIsWithin,
  textMentionsPath,
  isCaseInsensitiveFs,
  _resetFsCaseCacheForTests,
} from './fs-case.js';

afterEach(() => {
  _resetFsCaseCacheForTests();
});

describe('pathIsWithin', () => {
  it('matches an exact path on either volume kind', () => {
    for (const insensitive of [true, false]) {
      _resetFsCaseCacheForTests(insensitive);
      expect(pathIsWithin('/home/u/.ssh', '/home/u/.ssh')).toBe(true);
    }
  });

  it('matches a descendant on either volume kind', () => {
    for (const insensitive of [true, false]) {
      _resetFsCaseCacheForTests(insensitive);
      expect(pathIsWithin('/home/u/.ssh/id_rsa', '/home/u/.ssh')).toBe(true);
    }
  });

  it('rejects a sibling that merely shares a prefix, on either volume kind', () => {
    for (const insensitive of [true, false]) {
      _resetFsCaseCacheForTests(insensitive);
      expect(pathIsWithin('/home/u/.sshx/key', '/home/u/.ssh')).toBe(false);
    }
  });

  // The #736 defect proper.
  it('denies a case-variant spelling on a case-insensitive volume', () => {
    _resetFsCaseCacheForTests(true);
    expect(pathIsWithin('/home/u/.SSH/id_rsa', '/home/u/.ssh')).toBe(true);
    expect(pathIsWithin('/home/u/.Ssh/id_rsa', '/home/u/.ssh')).toBe(true);
    expect(pathIsWithin('/home/u/.AFK/config/afk.env', '/home/u/.afk/config')).toBe(true);
    expect(pathIsWithin('/HOME/U/.SSH', '/home/u/.ssh')).toBe(true);
  });

  it('does NOT conflate case variants on a case-sensitive volume', () => {
    _resetFsCaseCacheForTests(false);
    expect(pathIsWithin('/home/u/.SSH/id_rsa', '/home/u/.ssh')).toBe(false);
    expect(pathIsWithin('/home/u/.AFK/config/afk.env', '/home/u/.afk/config')).toBe(false);
  });

  it('still respects the prefix boundary when folding', () => {
    _resetFsCaseCacheForTests(true);
    expect(pathIsWithin('/home/u/.SSHX/key', '/home/u/.ssh')).toBe(false);
  });
});

describe('textMentionsPath', () => {
  it('finds an exact mention on either volume kind', () => {
    for (const insensitive of [true, false]) {
      _resetFsCaseCacheForTests(insensitive);
      expect(textMentionsPath('cat /home/u/.ssh/id_rsa', '/home/u/.ssh')).toBe(true);
    }
  });

  it('finds a case-variant mention only on a case-insensitive volume', () => {
    _resetFsCaseCacheForTests(true);
    expect(textMentionsPath('cat /home/u/.SSH/id_rsa', '/home/u/.ssh')).toBe(true);

    _resetFsCaseCacheForTests(false);
    expect(textMentionsPath('cat /home/u/.SSH/id_rsa', '/home/u/.ssh')).toBe(false);
  });

  it('does not match an unrelated command', () => {
    _resetFsCaseCacheForTests(true);
    expect(textMentionsPath('echo hello', '/home/u/.ssh')).toBe(false);
  });
});

describe('isCaseInsensitiveFs', () => {
  it('returns a boolean without throwing and caches the answer', () => {
    _resetFsCaseCacheForTests();
    const first = isCaseInsensitiveFs();
    expect(typeof first).toBe('boolean');
    // Second call must be served from cache — same answer, no re-probe.
    expect(isCaseInsensitiveFs()).toBe(first);
  });

  it('fails closed: an indeterminate probe folds rather than leaving a hole', () => {
    // A forced `true` is what the module falls back to when neither the home
    // directory nor cwd can answer the probe. Pin the consequence: the
    // credential floor still catches the case-variant spelling.
    _resetFsCaseCacheForTests(true);
    expect(pathIsWithin('/home/u/.SSH/id_rsa', '/home/u/.ssh')).toBe(true);
  });
});
