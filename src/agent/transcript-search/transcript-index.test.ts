/**
 * Tests for the FTS5 transcript search index.
 *
 * Uses a fresh temp directory per test suite so tests are fully isolated
 * from user state. No real transcript files from `~/.afk/` are read.
 *
 * @module agent/transcript-search/transcript-index.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TranscriptIndex, withTranscriptIndex } from './transcript-index.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A minimal transcript in the real format (markdown, as written by initTranscript). */
const TRANSCRIPT_A = `# Session — 2026-06-15T10:45:52.728Z

- model: claude-opus-4-5

---

_2026-06-15T10:45:52.728Z · model: claude-opus-4-5_

## User

How do I configure the Telegram bot for agent-afk?

## Assistant

To configure the Telegram bot, set AFK_TELEGRAM_BOT_TOKEN in your .env file
and run \`afk telegram setup\`. The bot will start listening for messages.

---

_ended: 2026-06-15T11:02:10.000Z_
`;

const TRANSCRIPT_B = `# Session — 2026-06-16T14:22:30.100Z

- model: claude-haiku-4-0

---

_2026-06-16T14:22:30.100Z · model: claude-haiku-4-0_

## User

What is the memory_search tool and how does it work?

## Assistant

memory_search queries the SQLite fact archive for curated facts the agent has
recorded across sessions. It uses FTS5 full-text search with a porter tokenizer.

---

_ended: 2026-06-16T14:35:00.000Z_
`;

const TRANSCRIPT_C = `# Session — 2026-06-17T09:00:00.000Z

- model: claude-sonnet-4-5

---

_2026-06-17T09:00:00.000Z · model: claude-sonnet-4-5_

## User

Explain the worktree feature.

## Assistant

Worktrees let you work on multiple branches simultaneously without switching.
Use \`afk worktree add\` to create a new worktree for a branch.

---

_ended: 2026-06-17T09:20:00.000Z_
`;

// ── Helpers ────────────────────────────────────────────────────────────────

let testDir: string;
let indexDir: string;
let transcriptsDir: string;

function writeTranscript(filename: string, content: string): void {
  writeFileSync(join(transcriptsDir, filename), content, 'utf-8');
}

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  testDir = join(tmpdir(), `afk-transcript-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  indexDir = join(testDir, 'index');
  transcriptsDir = join(testDir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TranscriptIndex', () => {
  describe('reindex()', () => {
    it('indexes transcript files and returns the count', () => {
      writeTranscript('2026-06-15T10-45-52-728Z.md', TRANSCRIPT_A);
      writeTranscript('2026-06-16T14-22-30-100Z.md', TRANSCRIPT_B);

      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        const result = idx.reindex();
        expect(result.indexed).toBe(2);
        expect(result.skipped).toBe(0);
        expect(idx.count()).toBe(2);
      } finally {
        idx.close();
      }
    });

    it('returns 0 when the transcripts directory is empty', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        const result = idx.reindex();
        expect(result.indexed).toBe(0);
        expect(result.skipped).toBe(0);
        expect(idx.count()).toBe(0);
      } finally {
        idx.close();
      }
    });

    it('returns 0 when the transcripts directory does not exist', () => {
      const missingDir = join(testDir, 'no-such-dir');
      const idx = new TranscriptIndex(indexDir, missingDir);
      try {
        const result = idx.reindex();
        expect(result.indexed).toBe(0);
        expect(result.skipped).toBe(0);
      } finally {
        idx.close();
      }
    });

    it('skips non-.md files', () => {
      writeTranscript('2026-06-15T10-45-52-728Z.md', TRANSCRIPT_A);
      writeFileSync(join(transcriptsDir, 'notes.txt'), 'some notes', 'utf-8');
      writeFileSync(join(transcriptsDir, 'data.json'), '{}', 'utf-8');

      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        const result = idx.reindex();
        expect(result.indexed).toBe(1);
        expect(result.skipped).toBe(0);
      } finally {
        idx.close();
      }
    });

    it('is idempotent — reindexing twice does not duplicate rows', () => {
      writeTranscript('2026-06-15T10-45-52-728Z.md', TRANSCRIPT_A);

      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        idx.reindex(); // second call
        expect(idx.count()).toBe(1);
      } finally {
        idx.close();
      }
    });

    it('counts unreadable .md entries as skipped, not indexed', () => {
      writeTranscript('2026-06-15T10-45-52-728Z.md', TRANSCRIPT_A);
      // A directory whose name ends in .md is enumerated by readdir but cannot
      // be read: readFileSync throws EISDIR, exercising the skip-count path.
      mkdirSync(join(transcriptsDir, 'broken.md'));

      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        const result = idx.reindex();
        expect(result.indexed).toBe(1);
        expect(result.skipped).toBe(1);
        expect(idx.count()).toBe(1);
      } finally {
        idx.close();
      }
    });
  });

  describe('search()', () => {
    beforeEach(() => {
      writeTranscript('2026-06-15T10-45-52-728Z.md', TRANSCRIPT_A);
      writeTranscript('2026-06-16T14-22-30-100Z.md', TRANSCRIPT_B);
      writeTranscript('2026-06-17T09-00-00-000Z.md', TRANSCRIPT_C);
    });

    it('returns the matching transcript for a term query', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        const results = idx.search('Telegram');
        expect(results.length).toBeGreaterThanOrEqual(1);
        // The Telegram hit should come from transcript A
        expect(results[0]?.filename).toBe('2026-06-15T10-45-52-728Z.md');
      } finally {
        idx.close();
      }
    });

    it('returns results ranked best-first (rank closer to 0 is better)', () => {
      // Both TRANSCRIPT_A and TRANSCRIPT_B mention "setup" / configuration-like
      // terms; verify results are ordered (rank values non-decreasing from best).
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        const results = idx.search('configure');
        // If multiple hits, ranks should be non-decreasing (FTS5 rank is negative;
        // ORDER BY rank puts the most-negative / best hit first).
        for (let i = 1; i < results.length; i++) {
          expect(results[i]!.rank).toBeGreaterThanOrEqual(results[i - 1]!.rank);
        }
      } finally {
        idx.close();
      }
    });

    it('returns empty array for a query with no matches', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        const results = idx.search('xyzzy_no_such_term_9999');
        expect(results).toEqual([]);
      } finally {
        idx.close();
      }
    });

    it('returns empty array for empty query string', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        const results = idx.search('');
        expect(results).toEqual([]);
      } finally {
        idx.close();
      }
    });

    it('returns empty array for whitespace-only query', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        const results = idx.search('   ');
        expect(results).toEqual([]);
      } finally {
        idx.close();
      }
    });

    it('respects the limit parameter', () => {
      // All three transcripts contain common words — use a broad term
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        const results = idx.search('Session', 2);
        expect(results.length).toBeLessThanOrEqual(2);
      } finally {
        idx.close();
      }
    });

    it('returns session_at in ISO-8601 format recovered from filename', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        const results = idx.search('Telegram');
        expect(results[0]?.session_at).toBe('2026-06-15T10:45:52.728Z');
      } finally {
        idx.close();
      }
    });

    it('stores the "unknown" session_at sentinel for a non-stamp filename', () => {
      // A stray .md whose name is not the ISO-stamp pattern must not produce a
      // malformed session_at; filenameToIso returns the sentinel instead.
      writeTranscript('release-notes.md', `# Notes\n\nThe xanadu feature shipped today.\n`);
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        const results = idx.search('xanadu');
        expect(results.length).toBe(1);
        expect(results[0]?.filename).toBe('release-notes.md');
        expect(results[0]?.session_at).toBe('unknown');
      } finally {
        idx.close();
      }
    });

    it('returns a snippet containing the matched term, not the session header', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        const results = idx.search('memory_search');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(typeof results[0]?.snippet).toBe('string');
        expect(results[0]!.snippet.length).toBeGreaterThan(0);
        expect(results[0]!.snippet.length).toBeLessThanOrEqual(300);
        // The snippet must be the FTS5 matching excerpt — it contains the matched
        // term and is NOT the boilerplate "# Session — <ts>" header that every
        // transcript starts with (the bug a content.slice(0,300) would reintroduce).
        expect(results[0]!.snippet).toContain('memory_search');
        expect(results[0]!.snippet).not.toContain('# Session');
      } finally {
        idx.close();
      }
    });

    it('handles FTS5 phrase query (quoted terms)', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        // "Telegram bot" as an exact phrase should hit transcript A
        const results = idx.search('"Telegram bot"');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]?.filename).toBe('2026-06-15T10-45-52-728Z.md');
      } finally {
        idx.close();
      }
    });

    it('throws a descriptive error on invalid FTS5 syntax', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        // An unclosed quote is invalid FTS5 syntax
        expect(() => idx.search('"unclosed phrase')).toThrow(/FTS5 query failed/);
      } finally {
        idx.close();
      }
    });
  });

  describe('count()', () => {
    it('returns 0 before reindex', () => {
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        expect(idx.count()).toBe(0);
      } finally {
        idx.close();
      }
    });

    it('returns the number of indexed transcripts after reindex', () => {
      writeTranscript('2026-06-15T10-45-52-728Z.md', TRANSCRIPT_A);
      writeTranscript('2026-06-16T14-22-30-100Z.md', TRANSCRIPT_B);
      const idx = new TranscriptIndex(indexDir, transcriptsDir);
      try {
        idx.reindex();
        expect(idx.count()).toBe(2);
      } finally {
        idx.close();
      }
    });
  });
});

describe('withTranscriptIndex()', () => {
  it('closes the DB after the callback and returns the callback result', () => {
    writeTranscript('2026-06-15T10-45-52-728Z.md', TRANSCRIPT_A);

    const count = withTranscriptIndex(
      (idx) => {
        idx.reindex();
        return idx.count();
      },
      indexDir,
      transcriptsDir,
    );
    expect(count).toBe(1);
  });

  it('closes the DB even when the callback throws', () => {
    expect(() =>
      withTranscriptIndex(
        () => {
          throw new Error('test error');
        },
        indexDir,
        transcriptsDir,
      ),
    ).toThrow('test error');
    // If we get here, the DB was closed (no open handles blocking cleanup).
    // Verify by trying to use the same indexDir again — should not throw.
    expect(() =>
      withTranscriptIndex((idx) => idx.count(), indexDir, transcriptsDir),
    ).not.toThrow();
  });
});

describe('FTS5 query safety', () => {
  beforeEach(() => {
    writeTranscript('2026-06-15T10-45-52-728Z.md', TRANSCRIPT_A);
  });

  it('handles a query with special regex characters without crashing (FTS5 syntax)', () => {
    const idx = new TranscriptIndex(indexDir, transcriptsDir);
    try {
      idx.reindex();
      // Asterisk is valid FTS5 prefix operator — should return results
      const results = idx.search('Telegr*');
      expect(results.length).toBeGreaterThanOrEqual(1);
    } finally {
      idx.close();
    }
  });

  it('returns empty for a valid but non-matching complex FTS5 query', () => {
    const idx = new TranscriptIndex(indexDir, transcriptsDir);
    try {
      idx.reindex();
      const results = idx.search('xyzzy AND nonexistent');
      expect(results).toEqual([]);
    } finally {
      idx.close();
    }
  });
});

describe('index directory permissions', () => {
  it('creates a fresh index dir with owner-only (0o700) permissions on POSIX', () => {
    // POSIX file modes only; Windows has no equivalent.
    if (process.platform === 'win32') return;
    // Use a dir the test harness has NOT pre-created so the constructor's own
    // mkdir (with mode 0o700) is what sets the permissions we assert.
    const freshIndexDir = join(testDir, 'fresh-index');
    const idx = new TranscriptIndex(freshIndexDir, transcriptsDir);
    try {
      const mode = statSync(freshIndexDir).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      idx.close();
    }
  });
});
