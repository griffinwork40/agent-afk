import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeHandoff,
  readHandoff,
  deleteHandoff,
  listPendingHandoffs,
  updateHandoffAnswer,
  type HandoffRecord,
} from './handoff-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    taskId: `q-${Date.now()}-abc123`,
    sessionId: 'sess-test-001',
    question: {
      type: 'text',
      message: 'What is your name?',
    } as Record<string, unknown>,
    requestType: 'ask_question',
    createdAt: new Date().toISOString(),
    status: 'pending',
    originalCommand: '/test-command',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture: isolated temp directory per test
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'handoff-store-test-'));
});

// Note: temp directories are left behind if a test fails — they are in /tmp
// and the OS cleans them up. This keeps test failure output readable without
// needing a try/finally in every case.

// ---------------------------------------------------------------------------
// writeHandoff + readHandoff round-trip
// ---------------------------------------------------------------------------

describe('writeHandoff + readHandoff', () => {
  it('round-trips a full HandoffRecord including optional fields (ask_question)', async () => {
    const record = makeRecord({
      taskId: 'q-1716000000000-abc123',
      sessionId: 'sess-roundtrip',
      question: {
        type: 'choice',
        message: 'Pick one',
        choices: ['A', 'B', 'C'],
        default: 'A',
        allowCustom: false,
        allowSkip: true,
      } as Record<string, unknown>,
      requestType: 'ask_question',
      route: { chatId: 123456, threadId: 7 },
      elicitId: 'elicit-xyz',
      originalCommand: '/run-something --flag',
    });

    await writeHandoff(record, testDir);
    const read = await readHandoff(record.taskId, testDir);

    expect(read).not.toBeNull();
    expect(read?.taskId).toBe(record.taskId);
    expect(read?.sessionId).toBe(record.sessionId);
    expect(read?.requestType).toBe('ask_question');
    expect(read?.question['type']).toBe('choice');
    expect(read?.question['choices']).toEqual(['A', 'B', 'C']);
    expect(read?.question['default']).toBe('A');
    expect(read?.question['allowSkip']).toBe(true);
    expect(read?.route?.chatId).toBe(123456);
    expect(read?.route?.threadId).toBe(7);
    expect(read?.elicitId).toBe('elicit-xyz');
    expect(read?.status).toBe('pending');
    expect(read?.originalCommand).toBe('/run-something --flag');
  });

  it('round-trips an MCP-style question with requestType mcp', async () => {
    const record = makeRecord({
      taskId: 'q-mcp-roundtrip',
      sessionId: 'sess-mcp',
      question: {
        mode: 'form',
        message: 'Please fill in the form',
        requestedSchema: { properties: { name: { type: 'string' } } },
        title: 'MCP Form',
        serverName: 'my-mcp-server',
      } as Record<string, unknown>,
      requestType: 'mcp',
    });

    await writeHandoff(record, testDir);
    const read = await readHandoff(record.taskId, testDir);

    expect(read).not.toBeNull();
    expect(read?.requestType).toBe('mcp');
    expect(read?.question['mode']).toBe('form');
    expect(read?.question['title']).toBe('MCP Form');
    expect((read?.question['requestedSchema'] as Record<string, unknown>)['properties']).toEqual({
      name: { type: 'string' },
    });
  });

  it('creates the handoffs directory if it does not exist', async () => {
    const nested = join(testDir, 'deep', 'handoffs');
    const record = makeRecord({ taskId: 'q-mkdir-test' });
    await writeHandoff(record, nested);
    const read = await readHandoff(record.taskId, nested);
    expect(read?.taskId).toBe('q-mkdir-test');
  });

  it('overwrites an existing record atomically', async () => {
    const record = makeRecord({ taskId: 'q-overwrite-test' });
    await writeHandoff(record, testDir);

    const updated = { ...record, sessionId: 'sess-updated' };
    await writeHandoff(updated, testDir);

    const read = await readHandoff(record.taskId, testDir);
    expect(read?.sessionId).toBe('sess-updated');
  });
});

// ---------------------------------------------------------------------------
// readHandoff returns null for missing taskId
// ---------------------------------------------------------------------------

describe('readHandoff', () => {
  it('returns null for a taskId with no file on disk', async () => {
    const result = await readHandoff('q-does-not-exist', testDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteHandoff is idempotent
// ---------------------------------------------------------------------------

describe('deleteHandoff', () => {
  it('removes an existing record', async () => {
    const record = makeRecord({ taskId: 'q-delete-me' });
    await writeHandoff(record, testDir);
    await deleteHandoff(record.taskId, testDir);
    const read = await readHandoff(record.taskId, testDir);
    expect(read).toBeNull();
  });

  it('does not throw when the file is already absent (idempotent)', async () => {
    await expect(deleteHandoff('q-never-existed', testDir)).resolves.toBeUndefined();
  });

  it('calling delete twice is safe', async () => {
    const record = makeRecord({ taskId: 'q-double-delete' });
    await writeHandoff(record, testDir);
    await deleteHandoff(record.taskId, testDir);
    await expect(deleteHandoff(record.taskId, testDir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listPendingHandoffs filters by status
// ---------------------------------------------------------------------------

describe('listPendingHandoffs', () => {
  it('returns only records with status === pending', async () => {
    const pending1 = makeRecord({ taskId: 'q-pending-1', status: 'pending' });
    const pending2 = makeRecord({ taskId: 'q-pending-2', status: 'pending' });
    const answered = makeRecord({
      taskId: 'q-answered',
      status: 'answered',
      answer: 'done',
      answeredAt: new Date().toISOString(),
      answerSource: 'telegram',
    });
    const expired = makeRecord({ taskId: 'q-expired', status: 'expired' });

    await Promise.all([
      writeHandoff(pending1, testDir),
      writeHandoff(pending2, testDir),
      writeHandoff(answered, testDir),
      writeHandoff(expired, testDir),
    ]);

    const results = await listPendingHandoffs(testDir);
    const ids = results.map((r) => r.taskId).sort();
    expect(ids).toEqual(['q-pending-1', 'q-pending-2']);
  });

  it('returns empty array when directory does not exist', async () => {
    const missing = join(testDir, 'missing');
    const results = await listPendingHandoffs(missing);
    expect(results).toEqual([]);
  });

  it('returns empty array when no records are pending', async () => {
    const record = makeRecord({ taskId: 'q-cancelled', status: 'cancelled' });
    await writeHandoff(record, testDir);
    const results = await listPendingHandoffs(testDir);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateHandoffAnswer transitions status to 'answered'
// ---------------------------------------------------------------------------

describe('updateHandoffAnswer', () => {
  it('transitions a pending record to answered and returns { won: true }', async () => {
    const record = makeRecord({ taskId: 'q-answer-me' });
    await writeHandoff(record, testDir);

    const before = Date.now();
    const result = await updateHandoffAnswer(record.taskId, 'Alice', 'telegram', testDir);
    const after = Date.now();

    expect(result.won).toBe(true);

    const read = await readHandoff(record.taskId, testDir);
    expect(read?.status).toBe('answered');
    expect(read?.answer).toBe('Alice');
    expect(read?.answerSource).toBe('telegram');
    expect(read?.answeredAt).toBeDefined();

    const answeredMs = new Date(read!.answeredAt!).getTime();
    expect(answeredMs).toBeGreaterThanOrEqual(before);
    expect(answeredMs).toBeLessThanOrEqual(after);
  });

  it('preserves all original fields after answer update', async () => {
    const record = makeRecord({
      taskId: 'q-preserve-fields',
      sessionId: 'sess-preserve',
      question: { type: 'confirm', message: 'Are you sure?' } as Record<string, unknown>,
      route: { chatId: 9999 },
      originalCommand: '/run-preserved',
    });
    await writeHandoff(record, testDir);
    const result = await updateHandoffAnswer(record.taskId, true, 'web', testDir);
    expect(result.won).toBe(true);

    const read = await readHandoff(record.taskId, testDir);
    expect(read?.sessionId).toBe('sess-preserve');
    expect(read?.question['message']).toBe('Are you sure?');
    expect(read?.route?.chatId).toBe(9999);
    expect(read?.originalCommand).toBe('/run-preserved');
    expect(read?.answer).toBe(true);
    expect(read?.answerSource).toBe('web');
  });

  it('throws if the record does not exist', async () => {
    await expect(
      updateHandoffAnswer('q-no-record', 'x', 'telegram', testDir),
    ).rejects.toThrow(/no record found/);
  });

  it('returns { won: false } if the record is not in pending status', async () => {
    const record = makeRecord({
      taskId: 'q-already-answered',
      status: 'answered',
      answer: 'first answer',
      answeredAt: new Date().toISOString(),
      answerSource: 'telegram',
    });
    await writeHandoff(record, testDir);
    const result = await updateHandoffAnswer(record.taskId, 'second answer', 'web', testDir);
    expect(result.won).toBe(false);
  });

  it('clears a stale lock left by a crashed process and succeeds', async () => {
    const record = makeRecord({ taskId: 'q-stale-lock' });
    await writeHandoff(record, testDir);

    // Simulate a crash: manually create the .lock file with an old mtime (>30s).
    const lockFile = join(testDir, `${record.taskId}.lock`);
    await writeFile(lockFile, '', { mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000); // 60 seconds ago
    await utimes(lockFile, staleTime, staleTime);

    // updateHandoffAnswer should detect the stale lock, remove it, and succeed.
    const result = await updateHandoffAnswer(record.taskId, 'recovered', 'telegram', testDir);
    expect(result.won).toBe(true);

    const read = await readHandoff(record.taskId, testDir);
    expect(read?.status).toBe('answered');
    expect(read?.answer).toBe('recovered');
  });

  it('CAS: exactly one concurrent caller wins when two race for the same taskId', async () => {
    const record = makeRecord({ taskId: 'q-cas-race' });
    await writeHandoff(record, testDir);

    // Fire both calls in parallel — only one should acquire the exclusive lock.
    const [r1, r2] = await Promise.all([
      updateHandoffAnswer(record.taskId, 'answer-from-caller-1', 'telegram', testDir),
      updateHandoffAnswer(record.taskId, 'answer-from-caller-2', 'web', testDir),
    ]);

    const winners = [r1.won, r2.won].filter(Boolean);
    const losers = [r1.won, r2.won].filter((w) => !w);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Final record must be in 'answered' status — written exactly once.
    const final = await readHandoff(record.taskId, testDir);
    expect(final?.status).toBe('answered');
    expect(final?.answeredAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// File permissions
// ---------------------------------------------------------------------------

describe('file permissions', () => {
  // Permissions are reliable on Linux (our CI target). Skip on other platforms.
  const itOnLinux = process.platform === 'linux' ? it : it.skip;

  itOnLinux('handoffs directory is created with mode 0o700', async () => {
    const nested = join(testDir, 'perms-dir');
    const record = makeRecord({ taskId: 'q-perms-dir' });
    await writeHandoff(record, nested);
    const dirStat = await stat(nested);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  itOnLinux('written record file has mode 0o600', async () => {
    const record = makeRecord({ taskId: 'q-perms-file' });
    await writeHandoff(record, testDir);
    const fileStat = await stat(join(testDir, `${record.taskId}.json`));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Concurrent writes don't corrupt
// ---------------------------------------------------------------------------

describe('concurrent writes', () => {
  it('two different taskIds written in parallel produce two intact records', async () => {
    const record1 = makeRecord({ taskId: 'q-concurrent-1', sessionId: 'sess-c1' });
    const record2 = makeRecord({ taskId: 'q-concurrent-2', sessionId: 'sess-c2' });

    await Promise.all([
      writeHandoff(record1, testDir),
      writeHandoff(record2, testDir),
    ]);

    const [r1, r2] = await Promise.all([
      readHandoff(record1.taskId, testDir),
      readHandoff(record2.taskId, testDir),
    ]);

    expect(r1?.sessionId).toBe('sess-c1');
    expect(r2?.sessionId).toBe('sess-c2');
  });

  it('many concurrent writes for distinct taskIds all land correctly', async () => {
    const count = 20;
    const records = Array.from({ length: count }, (_, i) =>
      makeRecord({ taskId: `q-conc-batch-${i}`, sessionId: `sess-batch-${i}` }),
    );

    await Promise.all(records.map((r) => writeHandoff(r, testDir)));

    const reads = await Promise.all(
      records.map((r) => readHandoff(r.taskId, testDir)),
    );

    for (let i = 0; i < count; i++) {
      expect(reads[i]?.sessionId).toBe(`sess-batch-${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Temp dir cleanup (after all tests in file)
// ---------------------------------------------------------------------------

afterAll(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});
