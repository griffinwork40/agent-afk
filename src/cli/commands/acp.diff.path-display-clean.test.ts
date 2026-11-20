/**
 * Redteam 5 — finding 5a: DiffContent.path is not sanitized.
 *
 * A diff frame carries a `path` field that clients show as the file header
 * above the diff hunk.  When the edited file's on-disk path contains a
 * bidi/invisible character (e.g. U+202E RIGHT-TO-LEFT OVERRIDE, legal on
 * Linux/macOS), `translateDiff` returns the raw path verbatim — no escaping
 * occurs — and the character reaches the client where it can reverse the
 * displayed filename.
 *
 * The safe contract: `DiffContent.path` MUST NOT contain U+202E or any other
 * character that `escapeInvisible` would replace.
 *
 * This test FAILS on current code because `resolveDisplayPath` does no
 * character escaping and `sanitizeDisplay` explicitly excludes `content[]`.
 */

import { describe, expect, it } from 'vitest';
import { translateDiff } from './acp.diff.js';
import type { DiffPayload } from '../../utils/diff.js';

// U+202E RIGHT-TO-LEFT OVERRIDE — legal in a Linux/macOS filename
const RLO = '\u202E';
// U+200B ZERO-WIDTH SPACE — invisible, also not escaped in diff path
const ZWS = '\u200B';

const simpleDiff = (filePath: string): DiffPayload => ({
  hunks: [
    {
      filePath,
      oldLines: 1,
      newLines: 1,
      lines: [
        { kind: '-', text: 'old line' },
        { kind: '+', text: 'new line' },
      ],
    },
  ],
});

const SESSION_CWD = '/workspace/session';

describe('redteam5: DiffContent.path sanitization', () => {
  it('should escape U+202E (RIGHT-TO-LEFT OVERRIDE) in a diff path', () => {
    // A file whose absolute path contains U+202E — legal on Linux/macOS.
    // translateDiff resolves the path and returns it as DiffContent.path.
    // The safe contract requires the character to be replaced with <U+202E>.
    const maliciousPath = `${SESSION_CWD}/evil${RLO}elif.ts`;
    const diffs = translateDiff(simpleDiff(maliciousPath), {}, SESSION_CWD);

    expect(diffs).toHaveLength(1);
    const diffPath = diffs[0]!.path;

    // FAILS on current code: path contains the raw U+202E
    expect(diffPath).not.toContain(RLO);
    expect(diffPath).toContain('<U+202E>');
  });

  it('should escape U+200B (ZERO-WIDTH SPACE) in a diff path', () => {
    const maliciousPath = `${SESSION_CWD}/hidden${ZWS}name.ts`;
    const diffs = translateDiff(simpleDiff(maliciousPath), {}, SESSION_CWD);

    expect(diffs).toHaveLength(1);
    const diffPath = diffs[0]!.path;

    // FAILS on current code: path contains the raw U+200B
    expect(diffPath).not.toContain(ZWS);
    expect(diffPath).toContain('<U+200B>');
  });

  it('should escape bidi char in a relative path resolved against cwd', () => {
    // Even when the input path is relative, resolveDisplayPath resolves it;
    // the resulting absolute path may still carry the bidi char.
    const relPath = `subdir/evil${RLO}file.ts`;
    const diffs = translateDiff(simpleDiff(relPath), {}, SESSION_CWD);

    expect(diffs).toHaveLength(1);
    const diffPath = diffs[0]!.path;

    // FAILS on current code
    expect(diffPath).not.toContain(RLO);
  });

  it('clean path without invisible chars passes through unchanged', () => {
    // Baseline: a normal path must still be returned correctly.
    const cleanPath = `${SESSION_CWD}/src/index.ts`;
    const diffs = translateDiff(simpleDiff(cleanPath), {}, SESSION_CWD);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.path).toBe(cleanPath);
  });
});
