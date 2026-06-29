/**
 * Tests for queue-store — file-based task queue with atomic writes.
 * @module agent/daemon/queue-store.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enqueue, dequeueNext, listPending, removePending, clearPending } from './queue-store.js';

// Use a fresh temp dir for each test to guarantee isolation
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'afk-queue-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('enqueue', () => {
  it('writes a .json file with correct filename format', () => {
    enqueue('echo hello', {}, tmpDir);
    const files = readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const name = files[0]!;
    // Expected: 0001-q-<timestamp>-<random>.json
    expect(name).toMatch(/^\d{4}-q-\d+-[a-z0-9]+\.json$/);
  });

  it('returns a QueuedTask with correct fields', () => {
    const before = Date.now();
    const task = enqueue('/forge-friction --auto', {}, tmpDir);
    const after = Date.now();

    expect(task.id).toMatch(/^q-\d+-[a-z0-9]+$/);
    expect(task.command).toBe('/forge-friction --auto');
    expect(task.sequence).toBe(1);
    // enqueuedAt is an ISO string within the test window
    const ts = new Date(task.enqueuedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('increments sequence for successive enqueues', () => {
    const t1 = enqueue('cmd1', {}, tmpDir);
    const t2 = enqueue('cmd2', {}, tmpDir);
    expect(t1.sequence).toBe(1);
    expect(t2.sequence).toBe(2);
  });

  it('creates the queue directory if it does not exist', () => {
    const nested = join(tmpDir, 'does', 'not', 'exist');
    const task = enqueue('echo hi', {}, nested);
    expect(task.sequence).toBe(1);
    const files = readdirSync(nested);
    expect(files).toHaveLength(1);
  });

  it('stores notifyOn in the task when provided', () => {
    const task = enqueue('cmd', { notifyOn: 'failure' }, tmpDir);
    expect(task.notifyOn).toBe('failure');
  });
});

describe('dequeueNext', () => {
  it('returns null on an empty directory', () => {
    const result = dequeueNext(tmpDir);
    expect(result).toBeNull();
  });

  it('removes the file from disk and returns the parsed task', () => {
    enqueue('/forge', {}, tmpDir);
    expect(readdirSync(tmpDir)).toHaveLength(1);

    const task = dequeueNext(tmpDir);
    expect(task).not.toBeNull();
    expect(task!.command).toBe('/forge');
    // File must be removed after dequeue
    expect(readdirSync(tmpDir)).toHaveLength(0);
  });

  it('respects FIFO order for two queued tasks', () => {
    enqueue('first', {}, tmpDir);
    enqueue('second', {}, tmpDir);

    const t1 = dequeueNext(tmpDir);
    const t2 = dequeueNext(tmpDir);
    expect(t1!.command).toBe('first');
    expect(t2!.command).toBe('second');
  });

  it('returns null on the second call after all tasks are dequeued', () => {
    enqueue('only', {}, tmpDir);
    dequeueNext(tmpDir);
    expect(dequeueNext(tmpDir)).toBeNull();
  });
});

describe('dequeueNext — malformed (poison) entries', () => {
  it('quarantines a malformed JSON entry at the FIFO head and returns the next valid task', () => {
    // Drop a corrupt file that sorts before any enqueued task.
    writeFileSync(join(tmpDir, '0000-q-poison.json'), '{ not valid json');
    enqueue('valid-task', {}, tmpDir);

    const task = dequeueNext(tmpDir);
    expect(task).not.toBeNull();
    expect(task!.command).toBe('valid-task');

    // No malformed entry left in the FIFO path; valid task consumed.
    const remaining = readdirSync(tmpDir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(remaining).toHaveLength(0);

    // Malformed entry preserved in poison/ for diagnosis.
    const poison = readdirSync(join(tmpDir, 'poison'));
    expect(poison).toHaveLength(1);
  });

  it('returns null when every entry is malformed (all quarantined, queue unblocked)', () => {
    writeFileSync(join(tmpDir, '0001-q-a.json'), 'garbage');
    writeFileSync(join(tmpDir, '0002-q-b.json'), 'also{bad');

    expect(dequeueNext(tmpDir)).toBeNull();

    // Both moved aside — a subsequent call finds an empty FIFO path.
    const remaining = readdirSync(tmpDir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(remaining).toHaveLength(0);
    expect(readdirSync(join(tmpDir, 'poison'))).toHaveLength(2);
    // And the queue is unblocked: another dequeue returns null cleanly.
    expect(dequeueNext(tmpDir)).toBeNull();
  });

  it('preserves the malformed entry bytes in poison/ (not deleted)', () => {
    writeFileSync(join(tmpDir, '0001-q-x.json'), '!!broken!!');
    dequeueNext(tmpDir);

    const poison = readdirSync(join(tmpDir, 'poison'));
    expect(poison).toHaveLength(1);
    const restored = readFileSync(join(tmpDir, 'poison', poison[0]!), 'utf-8');
    expect(restored).toBe('!!broken!!');
  });

  it('does not treat the poison/ subdir itself as a queue entry', () => {
    // Create a poison dir first, then a valid task. dequeueNext must not
    // try to read `poison` as a .json file (it is filtered out by suffix).
    mkdirSync(join(tmpDir, 'poison'), { recursive: true });
    writeFileSync(join(tmpDir, 'poison', 'stale.json'), 'old');
    enqueue('valid', {}, tmpDir);

    const task = dequeueNext(tmpDir);
    expect(task).not.toBeNull();
    expect(task!.command).toBe('valid');
  });

  it('quarantines an unreadable entry (read error, not parse error) and keeps draining', () => {
    // A directory whose name ends in `.json` passes the FIFO filter but makes
    // readFileSync throw EISDIR — exercising the read-error branch, which is
    // distinct from the JSON.parse branch every other poison test covers.
    mkdirSync(join(tmpDir, '0000-q-unreadable.json'), { recursive: true });
    enqueue('valid-after-unreadable', {}, tmpDir);

    const task = dequeueNext(tmpDir);
    expect(task).not.toBeNull();
    expect(task!.command).toBe('valid-after-unreadable');

    // The unreadable entry was moved aside into poison/, not left at the head.
    expect(readdirSync(join(tmpDir, 'poison'))).toHaveLength(1);
    const remaining = readdirSync(tmpDir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(remaining).toHaveLength(0);
  });

  it('collision-retry: uses a unique name when the first rename fails (dest already a directory)', () => {
    // Branch: quarantinePoisonEntry inner try/catch — first renameSync(src, poison/<filename>)
    // throws because poison/<filename> already exists as a directory (EISDIR on macOS/Linux).
    // The retry path appends `${Date.now()}-${randomHex}-<filename>` so the original
    // poison file (directory here) is never overwritten.
    //
    // Setup: pre-create poison/<filename> as a DIRECTORY so renameSync throws EISDIR.
    const poisonDir = join(tmpDir, 'poison');
    const poisonedFilename = '0001-q-collision.json';
    mkdirSync(join(poisonDir, poisonedFilename), { recursive: true });

    // Write the actual (malformed) queue entry with the same name at the queue root.
    writeFileSync(join(tmpDir, poisonedFilename), 'not-valid-json');

    dequeueNext(tmpDir);

    // The original destination (the directory) is still there — it was NOT overwritten.
    const poisonEntries = readdirSync(poisonDir);
    // The directory sentinel is still there; plus one new uniquely-named file.
    expect(poisonEntries.length).toBe(2);

    // The newly-quarantined file has the timestamp+random prefix pattern and is a FILE.
    const newEntry = poisonEntries.find((e) => e !== poisonedFilename);
    expect(newEntry).toBeDefined();
    // Pattern: <digits>-<hex>-<original filename>
    expect(newEntry).toMatch(new RegExp(`^\\d+-[a-z0-9]+-${poisonedFilename.replace('.', '\\.')}$`));

    // The content of the uniquely-named file is preserved from the original malformed entry.
    const rescued = readFileSync(join(poisonDir, newEntry!), 'utf-8');
    expect(rescued).toBe('not-valid-json');

    // The malformed entry is no longer in the FIFO path (the src was moved).
    const queueEntries = readdirSync(tmpDir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(queueEntries).toHaveLength(0);
  });
});

describe('listPending', () => {
  it('returns an empty array when queue is empty', () => {
    expect(listPending(tmpDir)).toEqual([]);
  });

  it('returns tasks in FIFO (sequence) order', () => {
    enqueue('alpha', {}, tmpDir);
    enqueue('beta', {}, tmpDir);
    enqueue('gamma', {}, tmpDir);

    const tasks = listPending(tmpDir);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.command).toBe('alpha');
    expect(tasks[1]!.command).toBe('beta');
    expect(tasks[2]!.command).toBe('gamma');
  });

  it('does not remove files from disk', () => {
    enqueue('keep', {}, tmpDir);
    listPending(tmpDir);
    expect(readdirSync(tmpDir)).toHaveLength(1);
  });

  it('skips malformed entries instead of throwing', () => {
    enqueue('alpha', {}, tmpDir);
    writeFileSync(join(tmpDir, '0002-q-poison.json'), '{ not json');
    enqueue('gamma', {}, tmpDir);

    // Must not throw on the poison entry, and returns only the parseable tasks.
    const tasks = listPending(tmpDir);
    expect(tasks.map((t) => t.command)).toEqual(['alpha', 'gamma']);

    // Read-only: nothing moved or removed — the poison entry is left in place
    // for the dequeue path to quarantine, and no poison/ dir is created here.
    const remaining = readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(3);
    expect(readdirSync(tmpDir)).not.toContain('poison');
  });
});

describe('filename redaction in log output', () => {
  // Anthropic API key pattern that redactInlineSecrets replaces.
  // Using a syntactically-valid key shape so the pattern fires reliably.
  const SECRET_FILENAME = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json';

  it('redacts a secret-shaped filename from quarantine log (dequeueNext path)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      writeFileSync(join(tmpDir, `0000-${SECRET_FILENAME}`), '{ invalid json');
      dequeueNext(tmpDir);
    } finally {
      spy.mockRestore();
    }
    // Every console.error call must NOT contain the raw secret-shaped name.
    const raw = SECRET_FILENAME;
    for (const call of spy.mock.calls) {
      const msg = String(call[0]);
      expect(msg).not.toContain(raw);
      // The log line should contain a redaction marker instead.
      expect(msg).toMatch(/<REDACTED/);
    }
  });

  it('redacts a secret-shaped filename from listPending log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Write corrupt content under the secret-shaped name.
      writeFileSync(join(tmpDir, `0000-${SECRET_FILENAME}`), '{ invalid json');
      listPending(tmpDir);
    } finally {
      spy.mockRestore();
    }
    const raw = SECRET_FILENAME;
    for (const call of spy.mock.calls) {
      const msg = String(call[0]);
      expect(msg).not.toContain(raw);
      expect(msg).toMatch(/<REDACTED/);
    }
  });
});

describe('SyntaxError snippet redaction in log output (issue #251)', () => {
  // V8 embeds a verbatim snippet of the malformed file bytes inside the
  // SyntaxError.message from JSON.parse — e.g.
  //   "Unexpected token 'T', "TOKEN=abc12..." is not valid JSON"
  // redactInlineSecrets's generic KEY=value pattern requires ≥16 chars in the
  // value, so short secrets and long-but-truncated secrets both slip through.
  // The fix suppresses the message entirely for SyntaxErrors, replacing it with
  // the content-free label 'SyntaxError: invalid JSON'.

  it('does not emit short secret value from SyntaxError message (dequeueNext path)', () => {
    // Short value — 11 chars — below the {16,} threshold; escapes redactInlineSecrets.
    const shortSecretContent = 'TOKEN=abc12345678';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      writeFileSync(join(tmpDir, '0000-q-short-secret.json'), shortSecretContent);
      dequeueNext(tmpDir);
      // Capture calls before mockRestore() clears them (vitest clears mock.calls on restore).
      const allMessages = spy.mock.calls.map((c) => String(c[0]));
      // (a) The secret fragment must NOT appear in any log line.
      for (const msg of allMessages) {
        expect(msg).not.toContain('abc12345678');
        expect(msg).not.toContain('TOKEN=');
      }
      // (b) The safe content-free label must appear instead.
      expect(allMessages.some((m) => m.includes('SyntaxError: invalid JSON'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not emit truncated long-value secret from SyntaxError message (dequeueNext path)', () => {
    // Long value that gets truncated inside the V8 SyntaxError snippet; after
    // truncation the remaining fragment is short enough to evade redaction.
    const longSecretContent = 'OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      writeFileSync(join(tmpDir, '0000-q-long-secret.json'), longSecretContent);
      dequeueNext(tmpDir);
      // Capture calls before mockRestore() clears them (vitest clears mock.calls on restore).
      const allMessages = spy.mock.calls.map((c) => String(c[0]));
      // (a) None of the secret-derived fragments must appear.
      for (const msg of allMessages) {
        expect(msg).not.toContain('OPENAI_API_KEY');
        expect(msg).not.toContain('sk-proj');
        expect(msg).not.toContain('abc123def456');
      }
      // (b) The safe label must appear.
      expect(allMessages.some((m) => m.includes('SyntaxError: invalid JSON'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not emit secret snippet from SyntaxError message (listPending path)', () => {
    // Same short-value scenario exercised on the listPending code path.
    const shortSecretContent = 'TOKEN=abc12345678';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      writeFileSync(join(tmpDir, '0000-q-list-secret.json'), shortSecretContent);
      listPending(tmpDir);
      // Capture calls before mockRestore() clears them (vitest clears mock.calls on restore).
      const allMessages = spy.mock.calls.map((c) => String(c[0]));
      // (a) Secret fragments must not appear.
      for (const msg of allMessages) {
        expect(msg).not.toContain('abc12345678');
        expect(msg).not.toContain('TOKEN=');
      }
      // (b) Safe label must appear.
      expect(allMessages.some((m) => m.includes('SyntaxError: invalid JSON'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('removePending', () => {
  it('returns false on an empty queue', () => {
    expect(removePending(tmpDir, 'q-0000000000000-aabbcc')).toBe(false);
  });

  it('removes a task file and returns true when id matches', () => {
    const task = enqueue('to-remove', {}, tmpDir);
    expect(readdirSync(tmpDir)).toHaveLength(1);

    const removed = removePending(tmpDir, task.id);
    expect(removed).toBe(true);
    expect(readdirSync(tmpDir)).toHaveLength(0);
  });

  it('returns false when id does not match any task', () => {
    enqueue('alpha', {}, tmpDir);
    const removed = removePending(tmpDir, 'q-0000000000000-nonexistent');
    expect(removed).toBe(false);
    // File must still be present
    expect(readdirSync(tmpDir)).toHaveLength(1);
  });

  it('removes only the matching task, leaving others intact', () => {
    enqueue('keep-1', {}, tmpDir);
    const target = enqueue('remove-me', {}, tmpDir);
    enqueue('keep-2', {}, tmpDir);

    const removed = removePending(tmpDir, target.id);
    expect(removed).toBe(true);

    const remaining = listPending(tmpDir);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((t) => t.command)).toEqual(['keep-1', 'keep-2']);
  });

  it('skips malformed entries (does not throw) and still removes a valid match', () => {
    writeFileSync(join(tmpDir, '0001-q-bad.json'), '{ corrupt');
    const task = enqueue('good', {}, tmpDir);

    // Should find and remove `good` even though a malformed file precedes it.
    expect(removePending(tmpDir, task.id)).toBe(true);
  });

  it('creates the queue directory if it does not exist', () => {
    const nested = join(tmpDir, 'does', 'not', 'exist');
    const removed = removePending(nested, 'any-id');
    expect(removed).toBe(false);
    // Directory must now exist
    expect(readdirSync(nested)).toHaveLength(0);
  });
});

describe('clearPending', () => {
  it('returns 0 on an empty queue', () => {
    expect(clearPending(tmpDir)).toBe(0);
  });

  it('removes all task files and returns the count', () => {
    enqueue('alpha', {}, tmpDir);
    enqueue('beta', {}, tmpDir);
    enqueue('gamma', {}, tmpDir);

    const removed = clearPending(tmpDir);
    expect(removed).toBe(3);
    const remaining = readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(0);
  });

  it('does not remove the poison/ subdirectory contents', () => {
    // Enqueue a valid task and a poison entry, then clear.
    enqueue('real', {}, tmpDir);
    const poisonDir = join(tmpDir, 'poison');
    mkdirSync(poisonDir, { recursive: true });
    writeFileSync(join(poisonDir, 'stale-quarantined.json'), '{ bad }');

    const removed = clearPending(tmpDir);
    expect(removed).toBe(1); // only the real task file at root level

    // Poison entry was NOT removed.
    expect(readdirSync(poisonDir)).toHaveLength(1);
  });

  it('after clear, listPending returns an empty array', () => {
    enqueue('x', {}, tmpDir);
    clearPending(tmpDir);
    expect(listPending(tmpDir)).toEqual([]);
  });

  it('creates the queue directory if it does not exist', () => {
    const nested = join(tmpDir, 'new', 'dir');
    const removed = clearPending(nested);
    expect(removed).toBe(0);
    // Directory must now exist
    expect(readdirSync(nested)).toHaveLength(0);
  });
});
