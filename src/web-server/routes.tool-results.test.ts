import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { JournalBlock } from '../agent/journal/index.js';

type ToolResultBlock = Extract<JournalBlock, { type: 'tool_result' }>;
type Found = { block: ToolResultBlock; subagentId?: string } | null;

const mockFind = vi.fn<(sessionId: string, toolUseId: string) => Promise<Found>>();
const mockExists = vi.fn<(sessionId: string) => Promise<boolean>>();

vi.mock('../agent/journal/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/journal/index.js')>()),
  findToolResultAsync: (s: string, t: string) => mockFind(s, t),
  journalExistsAsync: (s: string) => mockExists(s),
}));

import { handleGetToolResult, isSafeToolUseId, MAX_TOOL_RESULT_CHARS } from './routes.tool-results.js';
import { startWebServer, type WebServerHandle } from './server.js';

function makeRes(): { res: ServerResponse; json: () => { status: number; body: Record<string, unknown> } } {
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
  return { res, json: () => ({ status, body: JSON.parse(chunks.join('')) as Record<string, unknown> }) };
}

function block(text: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', toolUseId: 'toolu_1', isError, content: [{ type: 'text', text }] };
}

beforeEach(() => {
  mockFind.mockReset();
  mockExists.mockReset();
});

describe('handleGetToolResult', () => {
  it('returns the full hydrated text of a found result', async () => {
    const full = 'line\n'.repeat(500);
    mockFind.mockResolvedValue({ block: block(full) });
    const { res, json } = makeRes();
    await handleGetToolResult(res, 'sess-1', 'toolu_1');
    const { status, body } = json();
    expect(status).toBe(200);
    expect(mockFind).toHaveBeenCalledWith('sess-1', 'toolu_1');
    expect(body).toEqual({ toolUseId: 'toolu_1', isError: false, text: full, totalChars: full.length, truncated: false });
  });

  it('reports the subagent journal and error flag', async () => {
    mockFind.mockResolvedValue({ block: block('boom', true), subagentId: 'sub-9' });
    const { res, json } = makeRes();
    await handleGetToolResult(res, 'sess-1', 'toolu_1');
    expect(json().body).toMatchObject({ isError: true, subagentId: 'sub-9', text: 'boom' });
  });

  it('caps oversized results and flags truncation', async () => {
    mockFind.mockResolvedValue({ block: block('x'.repeat(MAX_TOOL_RESULT_CHARS + 10)) });
    const { res, json } = makeRes();
    await handleGetToolResult(res, 'sess-1', 'toolu_1');
    const { body } = json();
    expect(body['truncated']).toBe(true);
    expect((body['text'] as string).length).toBe(MAX_TOOL_RESULT_CHARS);
    expect(body['totalChars']).toBe(MAX_TOOL_RESULT_CHARS + 10);
  });

  it('never emits base64 image payloads', async () => {
    mockFind.mockResolvedValue({
      block: {
        type: 'tool_result',
        toolUseId: 'toolu_1',
        content: [
          { type: 'text', text: 'shot:' },
          { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'A'.repeat(4000) } },
        ],
      },
    });
    const { res, json } = makeRes();
    await handleGetToolResult(res, 'sess-1', 'toolu_1');
    const text = json().body['text'] as string;
    expect(text).toContain('[image: image/png, 2.9 KB]');
    expect(text).not.toContain('AAAA');
  });

  it('404s with journal_not_found when the session has no journal', async () => {
    mockFind.mockResolvedValue(null);
    mockExists.mockResolvedValue(false);
    const { res, json } = makeRes();
    await handleGetToolResult(res, 'sess-1', 'toolu_1');
    expect(json()).toMatchObject({ status: 404, body: { error: 'journal_not_found' } });
  });

  it('404s with tool_result_not_found when the journal lacks that call', async () => {
    mockFind.mockResolvedValue(null);
    mockExists.mockResolvedValue(true);
    const { res, json } = makeRes();
    await handleGetToolResult(res, 'sess-1', 'toolu_1');
    expect(json()).toMatchObject({ status: 404, body: { error: 'tool_result_not_found' } });
  });

  it('500s (does not throw) when the reader throws', async () => {
    mockFind.mockRejectedValue(new Error('disk gone'));
    const { res, json } = makeRes();
    await handleGetToolResult(res, 'sess-1', 'toolu_1');
    expect(json()).toMatchObject({ status: 500, body: { error: 'journal_read_failed', message: 'disk gone' } });
  });

  it.each(['../etc', 'a/b', '', 'x'.repeat(129)])('rejects unsafe session id %j before reading', async (id) => {
    const { res, json } = makeRes();
    await handleGetToolResult(res, id, 'toolu_1');
    expect(json()).toMatchObject({ status: 400, body: { error: 'bad_session_id' } });
    expect(mockFind).not.toHaveBeenCalled();
  });

  it.each(['../x', 'a/b', '', 'a b', 'x'.repeat(257)])('rejects unsafe tool use id %j before reading', async (id) => {
    expect(isSafeToolUseId(id)).toBe(false);
    const { res, json } = makeRes();
    await handleGetToolResult(res, 'sess-1', id);
    expect(json()).toMatchObject({ status: 400, body: { error: 'bad_tool_use_id' } });
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('accepts Anthropic and OpenAI style tool ids', () => {
    expect(isSafeToolUseId('toolu_01AbC-9')).toBe(true);
    expect(isSafeToolUseId('call_abc123')).toBe(true);
    expect(isSafeToolUseId('functions.bash:0')).toBe(true);
  });
});

describe('GET /api/sessions/:id/tool-results/:toolUseId (routing)', () => {
  let handle: WebServerHandle | undefined;
  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  it('requires the bearer token and serves the result when authorized', async () => {
    mockFind.mockResolvedValue({ block: block('full output') });
    handle = await startWebServer({ port: 0 });
    const url = `http://127.0.0.1:${handle.port}/api/sessions/sess-1/tool-results/${encodeURIComponent('toolu_1')}`;

    const anon = await fetch(url);
    expect(anon.status).toBe(401);
    expect(mockFind).not.toHaveBeenCalled();

    const ok = await fetch(url, { headers: { authorization: `Bearer ${handle.token}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toMatchObject({ toolUseId: 'toolu_1', text: 'full output' });
  });

  it('rejects an encoded traversal in the tool id with 400', async () => {
    handle = await startWebServer({ port: 0 });
    const url = `http://127.0.0.1:${handle.port}/api/sessions/sess-1/tool-results/${encodeURIComponent('../../x')}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${handle.token}` } });
    expect(res.status).toBe(400);
    expect(mockFind).not.toHaveBeenCalled();
  });
});
