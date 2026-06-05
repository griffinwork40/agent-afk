/**
 * Tests for ReplHistory (in-session ring buffer) and loadHistory (disk I/O).
 *
 * Disk tests use a temp dir so they never touch ~/.afk/state/repl-history.jsonl.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { ReplHistory, loadHistory, flushHistoryWrites } from './history.js';
import * as paths from '../../paths.js';

// Must match the private constant in history.ts.
const MAX_ENTRIES = 1_000;

// ---------------------------------------------------------------------------
// In-session ring buffer tests (no disk I/O)
// ---------------------------------------------------------------------------

describe('ReplHistory — in-session ring', () => {
  it('starts empty with length 0', () => {
    const h = new ReplHistory([]);
    expect(h.length).toBe(0);
  });

  it('back() returns null when empty', () => {
    const h = new ReplHistory([]);
    expect(h.back('')).toBeNull();
  });

  it('forward() returns null when not in recall', () => {
    const h = new ReplHistory(['a']);
    expect(h.forward()).toBeNull();
  });

  it('recalls the last entry on first back()', () => {
    const h = new ReplHistory(['alpha', 'beta', 'gamma']);
    expect(h.back('')).toBe('gamma');
  });

  it('walks back through entries in newest-first order', () => {
    const h = new ReplHistory(['a', 'b', 'c']);
    expect(h.back('')).toBe('c');
    expect(h.back('c')).toBe('b');
    expect(h.back('b')).toBe('a');
    // Stays at oldest on repeated back() at the boundary.
    expect(h.back('a')).toBe('a');
  });

  it('forward() returns newer entry after stepping back', () => {
    const h = new ReplHistory(['a', 'b', 'c']);
    h.back('');   // → 'c'
    h.back('c');  // → 'b'
    expect(h.forward()).toBe('c');
  });

  it('forward() past the newest restores the original draft', () => {
    const h = new ReplHistory(['a', 'b']);
    const draft = 'my draft';
    h.back(draft);  // → 'b' (newest, index=1)
    h.back('b');    // → 'a' (oldest, index=0)
    h.forward();    // → 'b' (index=1, newest)
    // One more forward() → past newest, restores draft.
    const restored = h.forward();
    expect(restored).toBe(draft);
    expect(h.inRecall).toBe(false);
  });

  it('inRecall is true during a recall session and false otherwise', () => {
    const h = new ReplHistory(['x']);
    expect(h.inRecall).toBe(false);
    h.back('');           // → 'x' (newest and only entry, index=0)
    expect(h.inRecall).toBe(true);
    h.forward();          // index=0 === length-1, so restore draft path
    expect(h.inRecall).toBe(false);
  });

  it('resetRecall() exits recall mode', () => {
    const h = new ReplHistory(['a', 'b']);
    h.back('');
    expect(h.inRecall).toBe(true);
    h.resetRecall();
    expect(h.inRecall).toBe(false);
  });

  it('push() de-duplicates consecutive identical entries', async () => {
    const h = new ReplHistory([]);
    // Stub disk write path — push calls appendHistory which calls getReplHistoryPath.
    vi.spyOn(paths, 'getReplHistoryPath').mockReturnValue('/dev/null');
    h.push('hello');
    h.push('hello'); // duplicate
    expect(h.length).toBe(1);
    // Drain the serialized write chain before restoring mocks so any pending
    // appendHistory call completes while the mock is still active (COR-9
    // test-isolation guard).
    await flushHistoryWrites();
    vi.restoreAllMocks();
  });

  it('push() increments length for distinct entries', async () => {
    const h = new ReplHistory([]);
    vi.spyOn(paths, 'getReplHistoryPath').mockReturnValue('/dev/null');
    h.push('alpha');
    h.push('beta');
    expect(h.length).toBe(2);
    await flushHistoryWrites();
    vi.restoreAllMocks();
  });

  it('push() ignores empty / whitespace-only strings', () => {
    const h = new ReplHistory([]);
    h.push('');
    h.push('   ');
    h.push('\t\n');
    expect(h.length).toBe(0);
  });

  it('push() resets recall state', async () => {
    const h = new ReplHistory(['a', 'b']);
    h.back('');
    expect(h.inRecall).toBe(true);
    vi.spyOn(paths, 'getReplHistoryPath').mockReturnValue('/dev/null');
    h.push('c');
    expect(h.inRecall).toBe(false);
    await flushHistoryWrites();
    vi.restoreAllMocks();
  });

  // COV-3: resetRecall() call-site coverage — lateral-arrow, shift+enter, printable-char
  // These tests verify the resetRecall() contract on ReplHistory directly.
  // reader.ts calls resetRecall() at three additional sites (lateral arrows,
  // shift+enter, printable char); those sites are verified here at the
  // domain-object level since reader.ts owns stdin/stdout and cannot be easily
  // unit-tested without a full TTY harness.

  it('resetRecall() after lateral arrow: inRecall becomes false (COV-3 arrow)', () => {
    // Simulates: user presses ↑ to recall, then presses ← or →.
    // reader.ts calls resetRecall() on left/right arrow — model that here.
    const h = new ReplHistory(['alpha', 'beta']);
    h.back('');          // begin recall → 'beta'
    expect(h.inRecall).toBe(true);
    h.resetRecall();     // ← or → in reader.ts triggers this
    expect(h.inRecall).toBe(false);
    // After reset, forward() returns null (not in recall mode).
    expect(h.forward()).toBeNull();
  });

  it('resetRecall() after shift+enter: inRecall becomes false (COV-3 shift-enter)', () => {
    // Simulates: user recalls a history entry, then presses shift+enter to
    // insert a newline without submitting. reader.ts calls resetRecall() there.
    const h = new ReplHistory(['first line', 'second line']);
    h.back('');          // begin recall → 'second line'
    expect(h.inRecall).toBe(true);
    h.resetRecall();     // shift+enter in reader.ts triggers this
    expect(h.inRecall).toBe(false);
  });

  it('resetRecall() after printable char: inRecall becomes false (COV-3 printable)', () => {
    // Simulates: user recalls a history entry, then types a character,
    // editing the buffer. reader.ts calls resetRecall() on printable input.
    const h = new ReplHistory(['hello']);
    h.back('');          // begin recall → 'hello'
    expect(h.inRecall).toBe(true);
    h.resetRecall();     // typing a printable char in reader.ts triggers this
    expect(h.inRecall).toBe(false);
    // After reset, back() starts a fresh recall from the top.
    const recalled = h.back('helloX'); // draft is the edited version
    expect(recalled).toBe('hello');
    expect(h.inRecall).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Disk roundtrip tests
// ---------------------------------------------------------------------------

describe('loadHistory — disk roundtrip', () => {
  let tmpDir: string;
  let histPath: string;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `afk-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    histPath = join(tmpDir, 'repl-history.jsonl');
    spy = vi.spyOn(paths, 'getReplHistoryPath').mockReturnValue(histPath);
  });

  afterEach(async () => {
    spy.mockRestore();
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it('returns an empty ReplHistory when the file does not exist', async () => {
    const h = await loadHistory();
    expect(h.length).toBe(0);
  });

  it('loads entries from a well-formed JSONL file', async () => {
    const lines = [
      JSON.stringify({ text: 'first entry', ts: 1000 }),
      JSON.stringify({ text: 'second entry', ts: 2000 }),
    ].join('\n') + '\n';
    await writeFile(histPath, lines, 'utf8');

    const h = await loadHistory();
    expect(h.length).toBe(2);
    expect(h.back('')).toBe('second entry');
  });

  it('skips malformed / non-JSON lines without throwing', async () => {
    const content = [
      JSON.stringify({ text: 'good', ts: 1 }),
      'not json at all',
      '{}',                                    // missing text field
      JSON.stringify({ text: '', ts: 2 }),     // empty text → skipped
      JSON.stringify({ text: 'also good', ts: 3 }),
    ].join('\n') + '\n';
    await writeFile(histPath, content, 'utf8');

    const h = await loadHistory();
    expect(h.length).toBe(2);
    expect(h.back('')).toBe('also good');
  });

  it('skips lines where text is not a string', async () => {
    const content = [
      JSON.stringify({ text: 42, ts: 1 }),
      JSON.stringify({ text: null, ts: 2 }),
      JSON.stringify({ text: 'valid', ts: 3 }),
    ].join('\n') + '\n';
    await writeFile(histPath, content, 'utf8');

    const h = await loadHistory();
    expect(h.length).toBe(1);
  });

  // COV-1: consecutive-duplicate dedup on load (COR-5)
  it('deduplicates consecutive identical entries on load (COR-5)', async () => {
    const content = [
      JSON.stringify({ text: 'alpha', ts: 1 }),
      JSON.stringify({ text: 'alpha', ts: 2 }), // duplicate — should be dropped
      JSON.stringify({ text: 'beta', ts: 3 }),
      JSON.stringify({ text: 'beta', ts: 4 }),  // duplicate — should be dropped
      JSON.stringify({ text: 'gamma', ts: 5 }),
    ].join('\n') + '\n';
    await writeFile(histPath, content, 'utf8');

    const h = await loadHistory();
    expect(h.length).toBe(3);
    expect(h.back('')).toBe('gamma');
    expect(h.back('gamma')).toBe('beta');
    expect(h.back('beta')).toBe('alpha');
  });

  // COV-1: compaction — seeding MAX_ENTRIES lines then pushing one more
  it('compacts the file to MAX_ENTRIES lines on overflow (COR-4)', async () => {
    // Seed the file with MAX_ENTRIES unique entries.
    const seedLines = Array.from({ length: MAX_ENTRIES }, (_, i) =>
      JSON.stringify({ text: `entry-${i}`, ts: i }),
    ).join('\n') + '\n';
    await writeFile(histPath, seedLines, 'utf8');

    // Load so the in-memory ring is populated, then push one more entry.
    const h = await loadHistory();
    expect(h.length).toBe(MAX_ENTRIES);

    // push() triggers appendHistory which reads existing + compacts.
    h.push('overflow');

    // Give the fire-and-forget disk write time to complete.
    await new Promise((r) => setTimeout(r, 200));

    // Count lines in the resulting file.
    const raw = await readFile(histPath, 'utf8');
    const lineCount = raw.split('\n').filter((l) => l.trim()).length;
    expect(lineCount).toBe(MAX_ENTRIES);

    // The last entry should be 'overflow'.
    const lastLine = raw.split('\n').filter((l) => l.trim()).at(-1)!;
    const lastEntry = JSON.parse(lastLine) as { text: string };
    expect(lastEntry.text).toBe('overflow');
  }, 5_000); // generous timeout for disk I/O

  // COV-1: SEC-1 — secret-pattern and leading-space exclusion
  it('does not persist entries matching the secret deny-list (SEC-1)', async () => {
    const h = await loadHistory();

    const secretInputs = [
      'sk-abcdef1234567890',
      'ghp_MyPersonalAccessToken',
      'Bearer eyJhbGciOiJIUzI1NiJ9',
      'password=hunter2',
      'token=abc123',
      'key=mysupersecretkey',
    ];

    for (const secret of secretInputs) {
      h.push(secret);
    }

    // None of the secret inputs should be in memory.
    expect(h.length).toBe(0);

    // Give any potential disk writes time to complete (there should be none).
    await new Promise((r) => setTimeout(r, 100));

    // File should not exist (no entries were persisted).
    let fileExists = true;
    try {
      await readFile(histPath, 'utf8');
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });

  // COV-1: leading-space escape hatch
  it('does not persist entries whose raw text starts with a space (SEC-1)', async () => {
    const h = await loadHistory();
    h.push(' secret command');
    h.push('  double space');
    expect(h.length).toBe(0);

    await new Promise((r) => setTimeout(r, 100));
    let fileExists = true;
    try {
      await readFile(histPath, 'utf8');
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });

  // COV-1: SEC-5 — ANSI escape sequences stripped on load
  it('strips ANSI escape sequences from entries on load (SEC-5)', async () => {
    const content = [
      JSON.stringify({ text: '\x1b[31mred text\x1b[0m', ts: 1 }),
      JSON.stringify({ text: 'clean', ts: 2 }),
    ].join('\n') + '\n';
    await writeFile(histPath, content, 'utf8');

    const h = await loadHistory();
    expect(h.length).toBe(2);
    // ANSI stripped → 'red text' (no escapes)
    expect(h.back('')).toBe('clean');
    expect(h.back('clean')).toBe('red text');
  });
});
