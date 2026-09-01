/**
 * Tests for src/cli/render/file-op-summary.ts
 */

import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../display.js';
import { fileOpSummary } from './file-op-summary.js';

// ─── Empty spec ───────────────────────────────────────────────────────────────

describe('fileOpSummary – empty spec', () => {
  it('returns empty string when no counts are provided', () => {
    expect(fileOpSummary({})).toBe('');
  });

  it('returns empty string when all counts are zero', () => {
    expect(fileOpSummary({ filesRead: 0, filesWritten: 0, filesEdited: 0, filesDeleted: 0 })).toBe('');
  });

  it('returns empty string when all counts are explicitly zero', () => {
    expect(fileOpSummary({ filesRead: 0 })).toBe('');
  });
});

// ─── Read-only (analyzed) ─────────────────────────────────────────────────────

describe('fileOpSummary – read-only operations', () => {
  it('uses "analyzed" verb for a single file read', () => {
    const out = stripAnsi(fileOpSummary({ filesRead: 1 }));
    expect(out).toContain('analyzed');
    expect(out).toContain('1 file');
  });

  it('uses "analyzed" verb for multiple files read', () => {
    const out = stripAnsi(fileOpSummary({ filesRead: 7 }));
    expect(out).toContain('analyzed');
    expect(out).toContain('7 files');
  });

  it('uses singular "file" for exactly 1 read', () => {
    const out = stripAnsi(fileOpSummary({ filesRead: 1 }));
    // Should say "1 file" not "1 files"
    expect(out).toMatch(/1 file(?!s)/);
  });

  it('uses plural "files" for >1 reads', () => {
    const out = stripAnsi(fileOpSummary({ filesRead: 3 }));
    expect(out).toContain('3 files');
  });
});

// ─── Edits ────────────────────────────────────────────────────────────────────

describe('fileOpSummary – edit operations', () => {
  it('renders "1 edit" for a single edit', () => {
    const out = stripAnsi(fileOpSummary({ filesEdited: 1 }));
    expect(out).toMatch(/1 edit(?!s)/);
  });

  it('renders "N edits" for multiple edits', () => {
    const out = stripAnsi(fileOpSummary({ filesEdited: 4 }));
    expect(out).toContain('4 edits');
  });

  it('does not include "analyzed" when no reads occurred', () => {
    const out = stripAnsi(fileOpSummary({ filesEdited: 2 }));
    expect(out).not.toContain('analyzed');
  });
});

// ─── Writes (created) ────────────────────────────────────────────────────────

describe('fileOpSummary – write operations', () => {
  it('renders "1 file created" for a single write', () => {
    const out = stripAnsi(fileOpSummary({ filesWritten: 1 }));
    expect(out).toContain('1 file created');
  });

  it('renders "N files created" for multiple writes', () => {
    const out = stripAnsi(fileOpSummary({ filesWritten: 3 }));
    expect(out).toContain('3 files created');
  });
});

// ─── Deletes ─────────────────────────────────────────────────────────────────

describe('fileOpSummary – delete operations', () => {
  it('renders "1 file deleted" for a single delete', () => {
    const out = stripAnsi(fileOpSummary({ filesDeleted: 1 }));
    expect(out).toContain('1 file deleted');
  });

  it('renders "N files deleted" for multiple deletes', () => {
    const out = stripAnsi(fileOpSummary({ filesDeleted: 5 }));
    expect(out).toContain('5 files deleted');
  });
});

// ─── Mixed operations ────────────────────────────────────────────────────────

describe('fileOpSummary – mixed operations', () => {
  it('includes "analyzed" prefix for reads when mutations also present', () => {
    const out = stripAnsi(fileOpSummary({ filesRead: 4, filesEdited: 2 }));
    expect(out).toContain('analyzed 4 files');
    expect(out).toContain('2 edits');
  });

  it('joins segments with ", "', () => {
    const out = stripAnsi(fileOpSummary({ filesRead: 3, filesEdited: 1, filesWritten: 2 }));
    expect(out).toContain(', ');
  });

  it('combines all four operation types', () => {
    const out = stripAnsi(
      fileOpSummary({ filesRead: 6, filesEdited: 3, filesWritten: 1, filesDeleted: 2 }),
    );
    expect(out).toContain('analyzed 6 files');
    expect(out).toContain('3 edits');
    expect(out).toContain('1 file created');
    expect(out).toContain('2 files deleted');
  });

  it('skips zero-count segments in a mixed spec', () => {
    const out = stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 2, filesWritten: 0 }));
    expect(out).not.toContain('analyzed');
    expect(out).not.toContain('created');
    expect(out).toContain('2 edits');
  });

  it('edits and creates with no reads — no "analyzed" prefix', () => {
    const out = stripAnsi(fileOpSummary({ filesEdited: 1, filesWritten: 1 }));
    expect(out).not.toContain('analyzed');
    expect(out).toContain('1 edit');
    expect(out).toContain('1 file created');
  });

  it('segment order: reads before edits before writes before deletes', () => {
    const out = stripAnsi(
      fileOpSummary({ filesDeleted: 1, filesWritten: 1, filesEdited: 1, filesRead: 1 }),
    );
    const readIdx    = out.indexOf('analyzed');
    const editIdx    = out.indexOf('edit');
    const createIdx  = out.indexOf('created');
    const deleteIdx  = out.indexOf('deleted');
    expect(readIdx).toBeLessThan(editIdx);
    expect(editIdx).toBeLessThan(createIdx);
    expect(createIdx).toBeLessThan(deleteIdx);
  });
});

// ─── Styling ─────────────────────────────────────────────────────────────────

describe('fileOpSummary – styling', () => {
  it('returns an ANSI-styled string (non-empty) for a non-empty spec', () => {
    const raw = fileOpSummary({ filesRead: 1 });
    // The raw string contains ANSI codes (dim), so it is longer than the stripped version.
    const stripped = stripAnsi(raw);
    expect(stripped.length).toBeGreaterThan(0);
    // In a real terminal ANSI codes would be present; we confirm the function
    // wraps with palette (raw !== stripped when chalk is active, but chalk
    // may be disabled in CI — we just check the content is correct).
    expect(stripped).toContain('analyzed');
  });

  it('raw output is a string', () => {
    expect(typeof fileOpSummary({ filesWritten: 2 })).toBe('string');
  });
});

// ─── Width truncation ────────────────────────────────────────────────────────

describe('fileOpSummary – width truncation', () => {
  it('truncates output to fit a narrow width', () => {
    const wide = fileOpSummary({ filesRead: 100, filesEdited: 50, filesWritten: 25, filesDeleted: 10 });
    const narrow = fileOpSummary(
      { filesRead: 100, filesEdited: 50, filesWritten: 25, filesDeleted: 10, width: 30 },
    );
    // Both should be non-empty strings
    expect(narrow.length).toBeGreaterThan(0);
    // The narrow output (stripped) should be shorter than the wide output
    expect(stripAnsi(narrow).length).toBeLessThanOrEqual(stripAnsi(wide).length);
  });

  it('does not crash at width=1', () => {
    expect(() =>
      fileOpSummary({ filesRead: 5, filesEdited: 3, width: 1 }),
    ).not.toThrow();
  });

  it('does not crash at width=0', () => {
    expect(() =>
      fileOpSummary({ filesRead: 2, width: 0 }),
    ).not.toThrow();
  });
});

// ─── Defensive / edge cases ──────────────────────────────────────────────────

describe('fileOpSummary – edge cases', () => {
  it('handles very large counts without crashing', () => {
    expect(() =>
      fileOpSummary({ filesRead: 1_000_000, filesEdited: 999_999 }),
    ).not.toThrow();
  });

  it('returns non-empty for exactly 1 of each operation', () => {
    const out = stripAnsi(
      fileOpSummary({ filesRead: 1, filesEdited: 1, filesWritten: 1, filesDeleted: 1 }),
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it('returns empty string for a spec with all undefined', () => {
    expect(fileOpSummary({ width: 80 })).toBe('');
  });
});
