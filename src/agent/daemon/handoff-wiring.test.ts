import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeDaemonElicitationHandler,
  recoverPendingHandoffs,
  answerHandoff,
  cleanupHandoff,
} from './handoff-wiring.js';
import {
  writeHandoff,
  readHandoff,
  type HandoffRecord,
} from './handoff-store.js';
import type { ElicitationRequest } from '../types/sdk-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return {
    serverName: 'agent',
    message: 'What is your name?',
    origin: 'agent',
    type: 'text',
    ...overrides,
  };
}

function notAborted(): AbortSignal {
  return new AbortController().signal;
}

function aborted(): AbortSignal {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
}

// Suppress Telegram push calls — we are testing the store, not the transport.
vi.mock('../../telegram/push.js', () => ({
  pushIfConfigured: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Fixture: isolated temp directories per test
// ---------------------------------------------------------------------------

let handoffsDir: string;
let queueDir: string;

beforeEach(async () => {
  handoffsDir = await mkdtemp(join(tmpdir(), 'handoff-wiring-test-'));
  queueDir = await mkdtemp(join(tmpdir(), 'handoff-queue-test-'));
});

// ---------------------------------------------------------------------------
// makeDaemonElicitationHandler
// ---------------------------------------------------------------------------

describe('makeDaemonElicitationHandler', () => {
  it('writes a handoff record and returns decline', async () => {
    const handler = makeDaemonElicitationHandler({
      taskId: 'q-handler-test',
      originalCommand: '/test-cmd',
      queueDir,
      handoffsDir,
    });

    const result = await handler(makeRequest(), { signal: notAborted(), sessionId: 'sess-1' });

    expect(result.action).toBe('decline');

    // Verify the handoff record was written
    const record = await readHandoff('q-handler-test', handoffsDir);
    expect(record).not.toBeNull();
    expect(record?.status).toBe('pending');
    expect(record?.taskId).toBe('q-handler-test');
    expect(record?.sessionId).toBe('sess-1');
    expect(record?.originalCommand).toBe('/test-cmd');
    expect(record?.requestType).toBe('ask_question');
    expect(record?.question['message']).toBe('What is your name?');
    expect(record?.question['type']).toBe('text');
  });

  it('serializes choice request fields correctly', async () => {
    const handler = makeDaemonElicitationHandler({
      taskId: 'q-choice-test',
      originalCommand: '/pick',
      handoffsDir,
    });

    const request = makeRequest({
      type: 'choice',
      choices: ['A', 'B', 'C'],
      context: 'Pick one',
      allowCustom: true,
    });
    await handler(request, { signal: notAborted() });

    const record = await readHandoff('q-choice-test', handoffsDir);
    expect(record?.question['type']).toBe('choice');
    expect(record?.question['choices']).toEqual(['A', 'B', 'C']);
    expect(record?.question['context']).toBe('Pick one');
    expect(record?.question['allowCustom']).toBe(true);
  });

  it('returns decline immediately when signal is already aborted', async () => {
    const handler = makeDaemonElicitationHandler({
      taskId: 'q-aborted-test',
      originalCommand: '/test',
      handoffsDir,
    });

    const result = await handler(makeRequest(), { signal: aborted() });
    expect(result.action).toBe('decline');

    // No record should be written
    const record = await readHandoff('q-aborted-test', handoffsDir);
    expect(record).toBeNull();
  });

  it('uses empty string for sessionId when not provided', async () => {
    const handler = makeDaemonElicitationHandler({
      taskId: 'q-no-session',
      originalCommand: '/test',
      handoffsDir,
    });

    await handler(makeRequest(), { signal: notAborted() });

    const record = await readHandoff('q-no-session', handoffsDir);
    expect(record?.sessionId).toBe('');
  });
});

// ---------------------------------------------------------------------------
// recoverPendingHandoffs
// ---------------------------------------------------------------------------

describe('recoverPendingHandoffs', () => {
  it('returns zero counts when no handoffs exist', async () => {
    const result = await recoverPendingHandoffs(handoffsDir);
    expect(result.renotified).toBe(0);
    expect(result.expired).toBe(0);
  });

  it('re-notifies pending handoffs that are within TTL', async () => {
    const record: HandoffRecord = {
      taskId: 'q-recent',
      sessionId: 'sess-1',
      question: { message: 'Are you there?' } as Record<string, unknown>,
      requestType: 'ask_question',
      createdAt: new Date().toISOString(), // just created — well within TTL
      status: 'pending',
      originalCommand: '/hello',
    };
    await writeHandoff(record, handoffsDir);

    const result = await recoverPendingHandoffs(handoffsDir);
    expect(result.renotified).toBe(1);
    expect(result.expired).toBe(0);
  });

  it('expires handoffs older than 24 hours', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000); // 25 hours ago
    const record: HandoffRecord = {
      taskId: 'q-old',
      sessionId: 'sess-1',
      question: { message: 'Still there?' } as Record<string, unknown>,
      requestType: 'ask_question',
      createdAt: old.toISOString(),
      status: 'pending',
      originalCommand: '/stale',
    };
    await writeHandoff(record, handoffsDir);

    const result = await recoverPendingHandoffs(handoffsDir);
    expect(result.renotified).toBe(0);
    expect(result.expired).toBe(1);

    // Verify the record was transitioned to 'expired'
    const updated = await readHandoff('q-old', handoffsDir);
    expect(updated?.status).toBe('expired');
  });

  it('skips non-pending records (answered, expired, cancelled)', async () => {
    const base = {
      sessionId: 'sess-1',
      question: { message: 'test' } as Record<string, unknown>,
      requestType: 'ask_question' as const,
      createdAt: new Date().toISOString(),
      originalCommand: '/test',
    };
    await writeHandoff({ ...base, taskId: 'q-answered', status: 'answered', answer: 'yes' }, handoffsDir);
    await writeHandoff({ ...base, taskId: 'q-expired', status: 'expired' }, handoffsDir);
    await writeHandoff({ ...base, taskId: 'q-cancelled', status: 'cancelled' }, handoffsDir);

    const result = await recoverPendingHandoffs(handoffsDir);
    expect(result.renotified).toBe(0);
    expect(result.expired).toBe(0);
  });

  it('handles multiple pending handoffs', async () => {
    const base = {
      sessionId: 'sess-1',
      question: { message: 'test' } as Record<string, unknown>,
      requestType: 'ask_question' as const,
      createdAt: new Date().toISOString(),
      status: 'pending' as const,
      originalCommand: '/test',
    };
    await writeHandoff({ ...base, taskId: 'q-multi-1' }, handoffsDir);
    await writeHandoff({ ...base, taskId: 'q-multi-2' }, handoffsDir);

    const result = await recoverPendingHandoffs(handoffsDir);
    expect(result.renotified).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// answerHandoff + cleanupHandoff
// ---------------------------------------------------------------------------

describe('answerHandoff', () => {
  it('records an answer and returns true (first writer wins)', async () => {
    const record: HandoffRecord = {
      taskId: 'q-answer-test',
      sessionId: 'sess-1',
      question: { message: 'Name?' } as Record<string, unknown>,
      requestType: 'ask_question',
      createdAt: new Date().toISOString(),
      status: 'pending',
      originalCommand: '/test',
    };
    await writeHandoff(record, handoffsDir);

    const won = await answerHandoff('q-answer-test', 'Alice', 'telegram', handoffsDir);
    expect(won).toBe(true);

    const updated = await readHandoff('q-answer-test', handoffsDir);
    expect(updated?.status).toBe('answered');
    expect(updated?.answer).toBe('Alice');
    expect(updated?.answerSource).toBe('telegram');
  });

  it('second writer loses (CAS)', async () => {
    const record: HandoffRecord = {
      taskId: 'q-cas-test',
      sessionId: 'sess-1',
      question: { message: 'Name?' } as Record<string, unknown>,
      requestType: 'ask_question',
      createdAt: new Date().toISOString(),
      status: 'pending',
      originalCommand: '/test',
    };
    await writeHandoff(record, handoffsDir);

    const won1 = await answerHandoff('q-cas-test', 'first', 'telegram', handoffsDir);
    const won2 = await answerHandoff('q-cas-test', 'second', 'web', handoffsDir);

    expect(won1).toBe(true);
    expect(won2).toBe(false);
  });
});

describe('cleanupHandoff', () => {
  it('removes the handoff record', async () => {
    const record: HandoffRecord = {
      taskId: 'q-cleanup-test',
      sessionId: 'sess-1',
      question: { message: 'test' } as Record<string, unknown>,
      requestType: 'ask_question',
      createdAt: new Date().toISOString(),
      status: 'answered',
      originalCommand: '/test',
    };
    await writeHandoff(record, handoffsDir);

    await cleanupHandoff('q-cleanup-test', handoffsDir);
    const after = await readHandoff('q-cleanup-test', handoffsDir);
    expect(after).toBeNull();
  });

  it('is idempotent (does not throw on missing)', async () => {
    await expect(cleanupHandoff('q-never-existed', handoffsDir)).resolves.toBeUndefined();
  });
});
