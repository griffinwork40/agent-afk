/**
 * The `path` of a diff content item is a file header a client shows. It must
 * not carry hidden or direction-control characters (legal in Linux and macOS
 * file names): `translateDiff` replaces them with visible `<U+XXXX>` escapes.
 * History: found by the fifth security test pass, when the path was returned
 * verbatim and only titles and locations were escaped.
 */

import os from 'node:os';
import path from 'node:path';
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
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [
        { kind: '-', text: 'old line' },
        { kind: '+', text: 'new line' },
      ],
    },
  ],
  addedLines: 1,
  removedLines: 1,
});

// A real absolute base, so the same test is valid on Windows.
const SESSION_CWD = path.resolve(os.tmpdir(), 'acp-diff-path-ws');

describe('diff content path is display-clean', () => {
  it('should escape U+202E (RIGHT-TO-LEFT OVERRIDE) in a diff path', () => {
    // A file whose absolute path contains U+202E — legal on Linux/macOS.
    // translateDiff resolves the path and returns it as DiffContent.path.
    // The safe contract requires the character to be replaced with <U+202E>.
    const maliciousPath = path.join(SESSION_CWD, `evil${RLO}elif.ts`);
    const diffs = translateDiff(simpleDiff(maliciousPath), {}, SESSION_CWD);

    expect(diffs).toHaveLength(1);
    const diffPath = diffs[0]!.path;

    expect(diffPath).not.toContain(RLO);
    expect(diffPath).toContain('<U+202E>');
  });

  it('should escape U+200B (ZERO-WIDTH SPACE) in a diff path', () => {
    const maliciousPath = path.join(SESSION_CWD, `hidden${ZWS}name.ts`);
    const diffs = translateDiff(simpleDiff(maliciousPath), {}, SESSION_CWD);

    expect(diffs).toHaveLength(1);
    const diffPath = diffs[0]!.path;

    expect(diffPath).not.toContain(ZWS);
    expect(diffPath).toContain('<U+200B>');
  });

  it('should escape bidi char in a relative path resolved against cwd', () => {
    // Even when the input path is relative, resolveDisplayPath resolves it;
    // the resulting absolute path may still carry the bidi char.
    const relPath = path.join('subdir', `evil${RLO}file.ts`);
    const diffs = translateDiff(simpleDiff(relPath), {}, SESSION_CWD);

    expect(diffs).toHaveLength(1);
    const diffPath = diffs[0]!.path;

    expect(diffPath).not.toContain(RLO);
  });

  it('clean path without invisible chars passes through unchanged', () => {
    // Baseline: a normal path must still be returned correctly.
    const cleanPath = path.join(SESSION_CWD, 'src', 'index.ts');
    const diffs = translateDiff(simpleDiff(cleanPath), {}, SESSION_CWD);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.path).toBe(cleanPath);
  });
});
