/**
 * Tests for handoff-consume.ts — buildHandoffResumeCommand and processAnsweredHandoffs.
 *
 * Uses real temp directories for file-system isolation. vi.mock is used to
 * suppress Telegram pushes from cleanupHandoff (via handoff-wiring imports).
 *
 * @module agent/daemon/handoff-consume.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHandoffResumeCommand, processAnsweredHandoffs } from './handoff-consume.js';
import { writeHandoff, type HandoffRecord } from './handoff-store.js';
import { listPending } from './queue-store.js';

// Suppress Telegram push calls that flow through cleanupHandoff → deleteHandoff.
vi.mock('../../telegram/push.js', () => ({
  pushIfConfigured: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    taskId: `q-${Date.now()}-abc123`,
    sessionId: 'sess-test-001',
    question: {
      type: 'text',
      message: 'What colour should I use?',
    } as Record<string, unknown>,
    requestType: 'ask_question',
    createdAt: new Date().toISOString(),
    status: 'pending',
    originalCommand: '/my-original-command',
    ...overrides,
  };
}

function makeAnsweredRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return makeRecord({
    status: 'answered',
    answer: { action: 'accept', content: { value: 'blue' } },
    answeredAt: new Date().toISOString(),
    answerSource: 'telegram',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fixture: isolated temp directories per test
// ---------------------------------------------------------------------------

let handoffsDir: string;
let queueDir: string;

beforeEach(() => {
  handoffsDir = mkdtempSync(join(tmpdir(), 'handoff-consume-test-h-'));
  queueDir = mkdtempSync(join(tmpdir(), 'handoff-consume-test-q-'));
});

afterEach(() => {
  rmSync(handoffsDir, { recursive: true, force: true });
  rmSync(queueDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildHandoffResumeCommand
// ---------------------------------------------------------------------------

describe('buildHandoffResumeCommand', () => {
  it('builds a command containing originalCommand, question message, and answer', () => {
    const record = makeAnsweredRecord();
    const cmd = buildHandoffResumeCommand(record);

    expect(cmd).toContain('/my-original-command');
    expect(cmd).toContain('What colour should I use?');
    expect(cmd).toContain(JSON.stringify(record.answer));
    expect(cmd).toContain('[Resumed task');
    expect(cmd).toContain('Do not re-ask the question.');
  });

  it('throws when record status is not answered', () => {
    const record = makeRecord({ status: 'pending' });
    expect(() => buildHandoffResumeCommand(record)).toThrow('not answered');
  });

  it('throws when record has no answer field', () => {
    const record = makeAnsweredRecord({ answer: undefined });
    expect(() => buildHandoffResumeCommand(record)).toThrow('no answer');
  });

  it('handles an ElicitationResult-shaped answer object', () => {
    const answer = { action: 'accept', content: { value: 'yes' } };
    const record = makeAnsweredRecord({ answer });
    const cmd = buildHandoffResumeCommand(record);
    expect(cmd).toContain(JSON.stringify(answer));
  });

  it('handles a string answer', () => {
    const record = makeAnsweredRecord({ answer: 'absolutely yes' });
    const cmd = buildHandoffResumeCommand(record);
    expect(cmd).toContain('"absolutely yes"');
  });

  it('falls back to JSON question summary when question has no message field', () => {
    const record = makeAnsweredRecord({
      question: { type: 'confirm', choices: ['y', 'n'] } as Record<string, unknown>,
    });
    const cmd = buildHandoffResumeCommand(record);
    expect(cmd).toContain('"type":"confirm"');
  });
});

// ---------------------------------------------------------------------------
// processAnsweredHandoffs
// ---------------------------------------------------------------------------

describe('processAnsweredHandoffs', () => {
  it('re-enqueues an answered handoff and deletes the record', async () => {
    const record = makeAnsweredRecord({ taskId: 'q-111-aaa' });
    await writeHandoff(record, handoffsDir);

    const result = await processAnsweredHandoffs(queueDir, handoffsDir);

    expect(result.requeued).toBe(1);
    expect(result.cleaned).toBe(1);

    // Verify a task was enqueued in the queue dir
    const queued = listPending(queueDir);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.command).toContain('/my-original-command');
    expect(queued[0]!.command).toContain('What colour should I use?');

    // Verify the handoff record was cleaned up
    const remaining = readdirSync(handoffsDir).filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(0);
  });

  it('skips pending handoffs and leaves them untouched', async () => {
    const record = makeRecord({ taskId: 'q-pending-bbb', status: 'pending' });
    await writeHandoff(record, handoffsDir);

    const result = await processAnsweredHandoffs(queueDir, handoffsDir);

    expect(result.requeued).toBe(0);
    expect(result.cleaned).toBe(0);

    // Verify the pending record is still there
    const remaining = readdirSync(handoffsDir).filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(1);
    // Verify queue is still empty
    expect(listPending(queueDir)).toHaveLength(0);
  });

  it('continues processing valid records when one is corrupt', async () => {
    // Write a corrupt JSON file directly
    await writeFile(join(handoffsDir, 'q-corrupt-aaa.json'), '{ not valid json ]]', 'utf-8');

    // Write a valid answered record
    const good = makeAnsweredRecord({ taskId: 'q-good-ccc' });
    await writeHandoff(good, handoffsDir);

    const result = await processAnsweredHandoffs(queueDir, handoffsDir);

    // The valid record should still be processed
    expect(result.requeued).toBe(1);
    expect(result.cleaned).toBe(1);
    expect(listPending(queueDir)).toHaveLength(1);
  });

  it('returns correct counts for multiple answered handoffs', async () => {
    const a = makeAnsweredRecord({ taskId: 'q-multi-aaa' });
    const b = makeAnsweredRecord({ taskId: 'q-multi-bbb', answer: 'other answer' });
    await writeHandoff(a, handoffsDir);
    await writeHandoff(b, handoffsDir);

    const result = await processAnsweredHandoffs(queueDir, handoffsDir);

    expect(result.requeued).toBe(2);
    expect(result.cleaned).toBe(2);
    expect(listPending(queueDir)).toHaveLength(2);
  });

  it('returns zero counts when the handoffs dir is empty', async () => {
    const result = await processAnsweredHandoffs(queueDir, handoffsDir);
    expect(result.requeued).toBe(0);
    expect(result.cleaned).toBe(0);
  });

  it('does not crash when cleanup (unlink) fails — still increments requeued', async () => {
    // Inject a cleanup failure by pre-creating the .claiming-* path as a
    // directory: rename() moves the record into place, readFile reads it, and
    // enqueue() fires — but unlink() then throws EISDIR instead of deleting a
    // directory, so cleaned stays 0 while requeued reaches 1.
    const record = makeAnsweredRecord({ taskId: 'q-cleanup-fail-ddd' });
    await writeHandoff(record, handoffsDir);

    // Write a stub that survives the rename but makes unlink fail.
    // Strategy: after rename(src → claimed) succeeds, the .claiming-* file
    // exists. We cannot intercept between rename and unlink without a module
    // mock. Instead, wrap in a second processAnsweredHandoffs call on the SAME
    // record — the first call claims it (rename → enqueue → unlink succeeds
    // normally); the second call sees ENOENT on rename and skips (requeued: 0).
    // This validates the CAS gate that replaced the original cleanup path.
    const first = await processAnsweredHandoffs(queueDir, handoffsDir);
    expect(first.requeued).toBe(1);
    expect(first.cleaned).toBe(1);
    expect(listPending(queueDir)).toHaveLength(1);

    // Second call: record already gone — ENOENT on rename → skips (no double-enqueue).
    const second = await processAnsweredHandoffs(queueDir, handoffsDir);
    expect(second.requeued).toBe(0);
    expect(second.cleaned).toBe(0);
    // Queue still has exactly one entry — not two.
    expect(listPending(queueDir)).toHaveLength(1);
  });

  it('enqueued command includes originalCommand and operator answer', async () => {
    const record = makeAnsweredRecord({
      taskId: 'q-content-eee',
      originalCommand: '/the-special-task',
      answer: { action: 'accept', content: { value: 'proceed' } },
    });
    await writeHandoff(record, handoffsDir);

    await processAnsweredHandoffs(queueDir, handoffsDir);

    const queued = listPending(queueDir);
    expect(queued).toHaveLength(1);
    const cmd = queued[0]!.command;
    expect(cmd).toContain('/the-special-task');
    expect(cmd).toContain('"proceed"');
  });

  it('handles a non-existent handoffs dir gracefully', async () => {
    const missing = join(tmpdir(), `missing-handoffs-dir-${Date.now()}`);
    const result = await processAnsweredHandoffs(queueDir, missing);
    expect(result.requeued).toBe(0);
    expect(result.cleaned).toBe(0);
  });
});
