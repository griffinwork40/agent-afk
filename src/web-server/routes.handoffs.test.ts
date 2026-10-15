/**
 * Tests for GET /api/handoffs (routes.handoffs.ts).
 *
 * Patterns follow routes.bg-jobs.test.ts and routes.memory.test.ts:
 *   - vi.mock the underlying store module
 *   - minimal makeRes() helper (no real HTTP server needed for unit tests)
 *   - integration smoke-test via a real server + native fetch for auth/wire
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { handleListHandoffs, type HandoffSummary } from './routes.handoffs.js';
import type { HandoffRecord } from '../agent/daemon/handoff-store.js';

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

const mockListPendingHandoffs = vi.fn<(dir: string) => Promise<HandoffRecord[]>>();

vi.mock('../agent/daemon/handoff-store.js', () => ({
  listPendingHandoffs: (dir: string) => mockListPendingHandoffs(dir),
}));

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    taskId: 'q-1700000000000-abc',
    sessionId: 'sess-abc',
    question: {
      message: 'Which environment should I deploy to?',
      type: 'select',
      choices: ['staging', 'production'],
    },
    requestType: 'ask_question',
    originalCommand: 'afk daemon --secret-key=hunter2',
    createdAt: '2024-01-01T00:00:00.000Z',
    status: 'pending',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeRes(): { res: ServerResponse; json: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(payload: string) {
      chunks.push(payload);
    },
  } as unknown as ServerResponse;
  return {
    res,
    json: () => ({ status, body: JSON.parse(chunks.join('')) as unknown }),
  };
}

// ---------------------------------------------------------------------------
// unit tests — handleListHandoffs
// ---------------------------------------------------------------------------

describe('routes.handoffs — handleListHandoffs', () => {
  beforeEach(() => {
    mockListPendingHandoffs.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with an empty array when no pending handoffs exist', async () => {
    mockListPendingHandoffs.mockResolvedValue([]);
    const { res, json } = makeRes();
    await handleListHandoffs(res, { handoffsDir: '/tmp/test-handoffs' });
    const { status, body } = json();
    expect(status).toBe(200);
    expect((body as { handoffs: unknown[] }).handoffs).toEqual([]);
  });

  it('returns pending records with the expected shape', async () => {
    const record = makeRecord();
    mockListPendingHandoffs.mockResolvedValue([record]);
    const { res, json } = makeRes();
    await handleListHandoffs(res, { handoffsDir: '/tmp/test-handoffs' });
    const { status, body } = json();
    expect(status).toBe(200);
    const handoffs = (body as { handoffs: unknown[] }).handoffs;
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      taskId: 'q-1700000000000-abc',
      sessionId: 'sess-abc',
      createdAt: '2024-01-01T00:00:00.000Z',
      status: 'pending',
      question: {
        message: 'Which environment should I deploy to?',
        type: 'select',
        choices: ['staging', 'production'],
      },
    });
  });

  it('excludes originalCommand from the response', async () => {
    mockListPendingHandoffs.mockResolvedValue([makeRecord()]);
    const { res, json } = makeRes();
    await handleListHandoffs(res, { handoffsDir: '/tmp/test-handoffs' });
    const handoffs = (json().body as { handoffs: Record<string, unknown>[] }).handoffs;
    expect(handoffs[0]).not.toHaveProperty('originalCommand');
  });

  it('excludes route, telegramMessageId, answer, answerSource, answeredAt, responderIdentity', async () => {
    const record = makeRecord({
      route: { chatId: 12345 },
      telegramMessageId: 999,
      answer: 'staging',
      answerSource: 'telegram',
      answeredAt: '2024-01-01T01:00:00.000Z',
      responderIdentity: '123456789:alice',
    });
    mockListPendingHandoffs.mockResolvedValue([record]);
    const { res, json } = makeRes();
    await handleListHandoffs(res, { handoffsDir: '/tmp/test-handoffs' });
    const h = (json().body as { handoffs: Record<string, unknown>[] }).handoffs[0];
    for (const field of ['route', 'telegramMessageId', 'answer', 'answerSource', 'answeredAt', 'responderIdentity']) {
      expect(h).not.toHaveProperty(field);
    }
  });

  it('uses the injected handoffsDir rather than the default', async () => {
    mockListPendingHandoffs.mockResolvedValue([]);
    const { res } = makeRes();
    await handleListHandoffs(res, { handoffsDir: '/custom/handoffs/dir' });
    expect(mockListPendingHandoffs).toHaveBeenCalledWith('/custom/handoffs/dir');
  });

  it('returns multiple pending records', async () => {
    const records = [
      makeRecord({ taskId: 'q-1-aaa', sessionId: 'sess-1' }),
      makeRecord({ taskId: 'q-2-bbb', sessionId: 'sess-2' }),
    ];
    mockListPendingHandoffs.mockResolvedValue(records);
    const { res, json } = makeRes();
    await handleListHandoffs(res, { handoffsDir: '/tmp/test-handoffs' });
    const handoffs = (json().body as { handoffs: { taskId: string }[] }).handoffs;
    expect(handoffs).toHaveLength(2);
    expect(handoffs.map((h) => h.taskId)).toEqual(['q-1-aaa', 'q-2-bbb']);
  });

  it('handles records whose question lacks message/type/choices gracefully', async () => {
    const record = makeRecord({ question: {} });
    mockListPendingHandoffs.mockResolvedValue([record]);
    const { res, json } = makeRes();
    await handleListHandoffs(res, { handoffsDir: '/tmp/test-handoffs' });
    const h = (json().body as { handoffs: HandoffSummary[] }).handoffs[0];
    expect(h).toBeDefined();
    expect(h?.question.message).toBeUndefined();
    expect(h?.question.type).toBeUndefined();
    expect(h?.question.choices).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// integration — auth gate via real server
// ---------------------------------------------------------------------------

describe('routes.handoffs — auth integration', () => {
  // Import startWebServer dynamically so the vi.mock above is already applied.
  it('returns 401 without a bearer token', async () => {
    const { startWebServer } = await import('./server.js');
    const handle = await startWebServer({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/handoffs`);
      expect(res.status).toBe(401);
      expect((await res.json() as { error: string }).error).toBe('unauthorized');
    } finally {
      await handle.stop();
    }
  });

  it('returns 200 with handoffs array when authenticated', async () => {
    mockListPendingHandoffs.mockResolvedValue([]);
    const { startWebServer } = await import('./server.js');
    const handle = await startWebServer({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/handoffs`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { handoffs: unknown[] };
      expect(Array.isArray(body.handoffs)).toBe(true);
    } finally {
      await handle.stop();
    }
  });
});
