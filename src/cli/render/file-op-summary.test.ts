import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../display.js';
import { fileOpSummary } from './file-op-summary.js';

// ─── All zeros ───────────────────────────────────────────────────────────────

describe('fileOpSummary – all zeros', () => {
  it('returns empty string when all counts are zero', () => {
    const result = fileOpSummary({ filesRead: 0, filesEdited: 0, filesWritten: 0 });
    expect(result).toBe('');
  });
});

// ─── Single operation type ────────────────────────────────────────────────────

describe('fileOpSummary – filesRead only', () => {
  it('renders "Analyzed 1 file" for singular', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 1, filesEdited: 0, filesWritten: 0 }));
    expect(result).toContain('Analyzed 1 file');
    expect(result).not.toContain('files');
  });

  it('renders "Analyzed 5 files" for plural', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 5, filesEdited: 0, filesWritten: 0 }));
    expect(result).toContain('Analyzed 5 files');
  });
});

describe('fileOpSummary – filesEdited only', () => {
  it('renders "Edited 1 file" for singular', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 1, filesWritten: 0 }));
    expect(result).toContain('Edited 1 file');
    expect(result).not.toContain('files');
  });

  it('renders "Edited 3 files" for plural', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 3, filesWritten: 0 }));
    expect(result).toContain('Edited 3 files');
  });
});

describe('fileOpSummary – filesWritten only', () => {
  it('renders "Wrote 1 file" for singular', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 0, filesWritten: 1 }));
    expect(result).toContain('Wrote 1 file');
    expect(result).not.toContain('files');
  });

  it('renders "Wrote 2 files" for plural', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 0, filesWritten: 2 }));
    expect(result).toContain('Wrote 2 files');
  });
});

// ─── Mixed operations ────────────────────────────────────────────────────────

describe('fileOpSummary – mixed operations', () => {
  it('renders read + edit segments', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 5, filesEdited: 3, filesWritten: 0 }));
    expect(result).toContain('Analyzed 5 files');
    expect(result).toContain('Edited 3 files');
    expect(result).not.toContain('Wrote');
  });

  it('renders read + write segments', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 4, filesEdited: 0, filesWritten: 2 }));
    expect(result).toContain('Analyzed 4 files');
    expect(result).toContain('Wrote 2 files');
    expect(result).not.toContain('Edited');
  });

  it('renders edit + write segments', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 2, filesWritten: 1 }));
    expect(result).toContain('Edited 2 files');
    expect(result).toContain('Wrote 1 file');
    expect(result).not.toContain('Analyzed');
  });

  it('renders all three segments', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 5, filesEdited: 3, filesWritten: 1 }));
    expect(result).toContain('Analyzed 5 files');
    expect(result).toContain('Edited 3 files');
    expect(result).toContain('Wrote 1 file');
  });
});

// ─── Icon presence ───────────────────────────────────────────────────────────

describe('fileOpSummary – icon', () => {
  it('includes the ◆ icon when there is at least one non-zero count', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 1, filesEdited: 0, filesWritten: 0 }));
    expect(result).toContain('◆');
  });

  it('does not include ◆ icon when all counts are zero', () => {
    const result = fileOpSummary({ filesRead: 0, filesEdited: 0, filesWritten: 0 });
    expect(result).not.toContain('◆');
  });
});

// ─── Singular/plural boundary ─────────────────────────────────────────────────

describe('fileOpSummary – singular/plural boundary', () => {
  it('filesRead: 1 → "file", 2 → "files"', () => {
    expect(stripAnsi(fileOpSummary({ filesRead: 1, filesEdited: 0, filesWritten: 0 }))).toContain(
      '1 file',
    );
    expect(stripAnsi(fileOpSummary({ filesRead: 2, filesEdited: 0, filesWritten: 0 }))).toContain(
      '2 files',
    );
  });

  it('filesEdited: 1 → "file", 2 → "files"', () => {
    expect(stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 1, filesWritten: 0 }))).toContain(
      '1 file',
    );
    expect(stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 2, filesWritten: 0 }))).toContain(
      '2 files',
    );
  });

  it('filesWritten: 1 → "file", 2 → "files"', () => {
    expect(
      stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 0, filesWritten: 1 })),
    ).toContain('1 file');
    expect(
      stripAnsi(fileOpSummary({ filesRead: 0, filesEdited: 0, filesWritten: 2 })),
    ).toContain('2 files');
  });
});

// ─── Segment ordering ────────────────────────────────────────────────────────

describe('fileOpSummary – segment ordering', () => {
  it('orders: read before edit before write', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 5, filesEdited: 3, filesWritten: 1 }));
    const readIdx = result.indexOf('Analyzed');
    const editIdx = result.indexOf('Edited');
    const writeIdx = result.indexOf('Wrote');
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(editIdx).toBeGreaterThan(readIdx);
    expect(writeIdx).toBeGreaterThan(editIdx);
  });

  it('orders: read before write when edit is absent', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 2, filesEdited: 0, filesWritten: 1 }));
    const readIdx = result.indexOf('Analyzed');
    const writeIdx = result.indexOf('Wrote');
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(readIdx);
  });
});

// ─── Separator presence ───────────────────────────────────────────────────────

describe('fileOpSummary – separator', () => {
  it('includes · separator between two segments', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 2, filesEdited: 1, filesWritten: 0 }));
    expect(result).toContain('·');
  });

  it('includes · separator between three segments', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 2, filesEdited: 1, filesWritten: 3 }));
    const separators = result.split('·').length - 1;
    expect(separators).toBe(2);
  });

  it('does not include · separator when only one segment is present', () => {
    const result = stripAnsi(fileOpSummary({ filesRead: 3, filesEdited: 0, filesWritten: 0 }));
    expect(result).not.toContain('·');
  });
});
