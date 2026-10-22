/**
 * Tests for GET /api/handoffs and POST /api/handoffs/:taskId/answer (routes.handoffs.ts).
 *
 * Patterns follow routes.bg-jobs.test.ts and routes.memory.test.ts:
 *   - vi.mock the underlying store module
 *   - minimal makeRes() / makeReq() helpers (no real HTTP server for unit tests)
 *   - integration smoke-test via a real server + native fetch for auth/wire
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleListHandoffs, handleAnswerHandoff, type HandoffSummary } from './routes.handoffs.js';
import type { HandoffRecord } from '../agent/daemon/handoff-store.js';

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

const mockListPendingHandoffs = vi.fn<(dir: string) => Promise<HandoffRecord[]>>();
const mockReadHandoff = vi.fn<(taskId: string, dir: string) => Promise<HandoffRecord | null>>();
const mockAnswerHandoff = vi.fn<
  (taskId: string, answer: unknown, source: string, dir: string | undefined, identity: string) => Promise<boolean>
>();

vi.mock('../agent/daemon/handoff-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/daemon/handoff-store.js')>();
  return {
    ...actual,
    listPendingHandoffs: (dir: string) => mockListPendingHandoffs(dir),
    readHandoff: (taskId: string, dir: string) => mockReadHandoff(taskId, dir),
  };
});

vi.mock('../agent/daemon/handoff-wiring.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/daemon/handoff-wiring.js')>();
  return {
    MAX_ANSWER_BYTES: actual.MAX_ANSWER_BYTES,
    answerHandoff: (
      taskId: string,
      answer: unknown,
      source: string,
      dir: string | undefined,
      identity: string,
    ) => mockAnswerHandoff(taskId, answer, source, dir, identity),
  };
});

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

/**
 * Minimal fake IncomingMessage for handleAnswerHandoff tests.
 * Supplies a controllable remoteAddress so identity assertions are deterministic.
 */
function makeReq(remoteAddress = '127.0.0.1'): IncomingMessage {
  return {
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

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

  it('does not 500 when a record has question: null (skips the fields)', async () => {
    const bad = makeRecord({ taskId: 'q-null', question: null as unknown as Record<string, unknown> });
    mockListPendingHandoffs.mockResolvedValue([bad, makeRecord()]);
    const { res, json } = makeRes();
    await handleListHandoffs(res, { handoffsDir: '/tmp/test-handoffs' });
    const { status, body } = json();
    expect(status).toBe(200);
    const handoffs = (body as { handoffs: HandoffSummary[] }).handoffs;
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0]?.taskId).toBe('q-null');
    expect(handoffs[0]?.question).toEqual({});
    expect(handoffs[1]?.question.message).toBe('Which environment should I deploy to?');
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

// ---------------------------------------------------------------------------
// unit tests — handleAnswerHandoff
// ---------------------------------------------------------------------------

describe('routes.handoffs — handleAnswerHandoff', () => {
  const DIR = '/tmp/test-handoffs';

  beforeEach(() => {
    mockReadHandoff.mockReset();
    mockAnswerHandoff.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 when body is missing answer field', async () => {
    const { res, json } = makeRes();
    await handleAnswerHandoff(makeReq(), res, 'q-123', {}, { handoffsDir: DIR });
    const { status, body } = json();
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe('bad_request');
    expect(mockReadHandoff).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not an object', async () => {
    const { res, json } = makeRes();
    await handleAnswerHandoff(makeReq(), res, 'q-123', 'bad', { handoffsDir: DIR });
    expect(json().status).toBe(400);
  });

  it('returns 400 when body is null', async () => {
    const { res, json } = makeRes();
    await handleAnswerHandoff(makeReq(), res, 'q-123', null, { handoffsDir: DIR });
    expect(json().status).toBe(400);
  });

  it('returns 404 when no record exists for taskId', async () => {
    mockReadHandoff.mockResolvedValue(null);
    const { res, json } = makeRes();
    await handleAnswerHandoff(makeReq(), res, 'q-no-such', { answer: 'yes' }, { handoffsDir: DIR });
    const { status, body } = json();
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe('not_found');
    expect(mockAnswerHandoff).not.toHaveBeenCalled();
  });

  it('returns 409 when record exists but status is already answered', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord({ status: 'answered' }));
    const { res, json } = makeRes();
    await handleAnswerHandoff(makeReq(), res, 'q-1700000000000-abc', { answer: 'yes' }, { handoffsDir: DIR });
    const { status, body } = json();
    expect(status).toBe(409);
    expect((body as { error: string }).error).toBe('no_longer_active');
    expect(mockAnswerHandoff).not.toHaveBeenCalled();
  });

  it('returns 409 when record exists but status is expired', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord({ status: 'expired' }));
    const { res, json } = makeRes();
    await handleAnswerHandoff(makeReq(), res, 'q-1700000000000-abc', { answer: 'yes' }, { handoffsDir: DIR });
    const { status, body } = json();
    expect(status).toBe(409);
    expect((body as { error: string }).error).toBe('no_longer_active');
    expect(mockAnswerHandoff).not.toHaveBeenCalled();
  });

  it('returns 200 and calls answerHandoff with correct args when CAS wins', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord());
    mockAnswerHandoff.mockResolvedValue(true);
    const { res, json } = makeRes();
    await handleAnswerHandoff(
      makeReq('192.168.1.5'),
      res,
      'q-1700000000000-abc',
      { answer: 'staging' },
      { handoffsDir: DIR },
    );
    const { status, body } = json();
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(mockAnswerHandoff).toHaveBeenCalledWith(
      'q-1700000000000-abc',
      'staging',
      'web',
      DIR,
      'web:192.168.1.5',
    );
  });

  it('records responderIdentity as "web:<remoteIp>"', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord());
    mockAnswerHandoff.mockResolvedValue(true);
    const { res } = makeRes();
    await handleAnswerHandoff(
      makeReq('10.0.0.42'),
      res,
      'q-1700000000000-abc',
      { answer: true },
      { handoffsDir: DIR },
    );
    expect(mockAnswerHandoff).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      'web',
      expect.anything(),
      'web:10.0.0.42',
    );
  });

  it('falls back to "web:unknown" when socket has no remoteAddress', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord());
    mockAnswerHandoff.mockResolvedValue(true);
    const req = { socket: {} } as unknown as IncomingMessage;
    const { res } = makeRes();
    await handleAnswerHandoff(req, res, 'q-1700000000000-abc', { answer: 42 }, { handoffsDir: DIR });
    expect(mockAnswerHandoff).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      'web',
      expect.anything(),
      'web:unknown',
    );
  });

  it('returns 409 when CAS loses (already answered by another surface)', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord());
    mockAnswerHandoff.mockResolvedValue(false);
    const { res, json } = makeRes();
    await handleAnswerHandoff(makeReq(), res, 'q-1700000000000-abc', { answer: 'x' }, { handoffsDir: DIR });
    const { status, body } = json();
    expect(status).toBe(409);
    expect((body as { error: string }).error).toBe('no_longer_active');
  });

  it('returns 409 when record vanishes between readHandoff and answerHandoff (race)', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord());
    mockAnswerHandoff.mockRejectedValue(new Error('handoff-store: no record found for taskId q-race'));
    const { res, json } = makeRes();
    await handleAnswerHandoff(makeReq(), res, 'q-race', { answer: 'yes' }, { handoffsDir: DIR });
    const { status, body } = json();
    expect(status).toBe(409);
    expect((body as { error: string }).error).toBe('no_longer_active');
  });

  it('rethrows non-race errors from answerHandoff (disk I/O, permission failure, etc.)', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord());
    const ioError = new Error('EACCES: permission denied');
    mockAnswerHandoff.mockRejectedValue(ioError);
    let headWritten = false;
    const { res } = makeRes();
    const origWriteHead = res.writeHead.bind(res);
    (res as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => {
      headWritten = true;
      origWriteHead(s);
    };
    await expect(
      handleAnswerHandoff(makeReq(), res, 'q-1700000000000-abc', { answer: 'yes' }, { handoffsDir: DIR }),
    ).rejects.toThrow('EACCES: permission denied');
    // No response must have been written — the error propagates to the
    // framework's 500 handler, not silently mapped to a JSON reply.
    expect(headWritten).toBe(false);
  });

  it('returns 400 when answer exceeds MAX_ANSWER_BYTES', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord());
    const { res, json } = makeRes();
    // 64 KB = 65536 bytes; a string of 65537 chars exceeds the limit.
    const oversized = 'x'.repeat(65_537);
    await handleAnswerHandoff(makeReq(), res, 'q-big', { answer: oversized }, { handoffsDir: DIR });
    const { status, body } = json();
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe('bad_request');
    expect((body as { message: string }).message).toContain('maximum size');
    expect(mockAnswerHandoff).not.toHaveBeenCalled();
  });

  it('passes answer value through verbatim (object)', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord());
    mockAnswerHandoff.mockResolvedValue(true);
    const { res } = makeRes();
    const answerValue = { value: 'production', confirmed: true };
    await handleAnswerHandoff(makeReq(), res, 'q-1700000000000-abc', { answer: answerValue }, { handoffsDir: DIR });
    expect(mockAnswerHandoff).toHaveBeenCalledWith(
      expect.any(String),
      answerValue,
      'web',
      expect.anything(),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// integration — POST /api/handoffs/:taskId/answer auth/CSRF gate
// ---------------------------------------------------------------------------

describe('routes.handoffs — answer auth integration', () => {
  beforeEach(() => {
    mockReadHandoff.mockReset();
    mockAnswerHandoff.mockReset();
  });

  it('returns 401 without a bearer token', async () => {
    const { startWebServer } = await import('./server.js');
    const handle = await startWebServer({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/handoffs/q-123/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'yes' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.stop();
    }
  });

  it('returns 200 and records answer when authenticated and record exists', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord({ taskId: 'q-1700000000000-abc' }));
    mockAnswerHandoff.mockResolvedValue(true);
    const { startWebServer } = await import('./server.js');
    const handle = await startWebServer({ port: 0 });
    try {
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/handoffs/q-1700000000000-abc/answer`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${handle.token}`,
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${handle.port}`,
          },
          body: JSON.stringify({ answer: 'staging' }),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(mockAnswerHandoff).toHaveBeenCalledWith(
        'q-1700000000000-abc',
        'staging',
        'web',
        expect.any(String), // resolved default handoffsDir
        expect.stringMatching(/^web:/),
      );
    } finally {
      await handle.stop();
    }
  });

  it('returns 403 when Origin header is present but wrong', async () => {
    const { startWebServer } = await import('./server.js');
    const handle = await startWebServer({ port: 0 });
    try {
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/handoffs/q-123/answer`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${handle.token}`,
            'content-type': 'application/json',
            origin: 'http://evil.example.com',
          },
          body: JSON.stringify({ answer: 'yes' }),
        },
      );
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toBe('bad_origin');
    } finally {
      await handle.stop();
    }
  });

  it('returns 409 when the handoff is already answered', async () => {
    mockReadHandoff.mockResolvedValue(makeRecord({ taskId: 'q-already' }));
    mockAnswerHandoff.mockResolvedValue(false);
    const { startWebServer } = await import('./server.js');
    const handle = await startWebServer({ port: 0 });
    try {
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/handoffs/q-already/answer`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${handle.token}`,
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${handle.port}`,
          },
          body: JSON.stringify({ answer: 'yes' }),
        },
      );
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toBe('no_longer_active');
    } finally {
      await handle.stop();
    }
  });
});
