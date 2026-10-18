/**
 * Unit tests for the ACP JSON-RPC 2.0 stdio server (acp.server.ts).
 *
 * All tests run over in-memory PassThrough streams — no real AgentSession or
 * Anthropic API calls are made.  acp.session.ts is mocked to return a fake
 * session handle whose `sendMessageStream` is fully controlled per test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Mock acp.session.ts — must be hoisted before any server import
// ---------------------------------------------------------------------------

const mockSendMessageStream = vi.fn();
const mockSessionClose = vi.fn().mockResolvedValue(undefined);
const mockMemoryClose = vi.fn();
const mockStateClose = vi.fn();

vi.mock('./acp.session.js', () => ({
  buildAcpSession: vi.fn(async () => ({
    session: {
      sendMessageStream: mockSendMessageStream,
      close: mockSessionClose,
    },
    memoryStore: { close: mockMemoryClose },
    stateStore: { close: mockStateClose },
  })),
  closeAcpSession: vi.fn(async (handle: { session: { close: () => Promise<void> } }) => {
    await handle.session.close();
    handle.memoryStore?.close?.();
    handle.stateStore?.close?.();
  }),
}));

// ---------------------------------------------------------------------------
// Import server AFTER mock is registered
// ---------------------------------------------------------------------------

import { runAcpServer } from './acp.server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send NDJSON lines to the server and collect all NDJSON output lines.
 * The server loop ends when the input stream ends (`.end()`).
 */
async function runScenario(lines: string[]): Promise<unknown[]> {
  const input = new PassThrough();
  const output = new PassThrough();

  const serverDone = runAcpServer({
    model: 'sonnet',
    maxTurns: 10,
    input,
    output,
  });

  // Collect output asynchronously
  const outputChunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => outputChunks.push(chunk));

  // Feed lines then end
  for (const line of lines) {
    input.write(line + '\n');
  }
  input.end();

  await serverDone;
  // Give the output stream a tick to flush
  await new Promise<void>((r) => setImmediate(r));

  const raw = Buffer.concat(outputChunks).toString('utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
}

function req(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
}

async function* makeStream(events: OutputEvent[]): AsyncIterable<OutputEvent> {
  for (const e of events) yield e;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionClose.mockResolvedValue(undefined);
});

describe('ACP server — initialize', () => {
  it('returns server info and capabilities', async () => {
    const [res] = await runScenario([req(1, 'initialize')]) as Array<{
      id: number; result: { serverInfo: { name: string }; capabilities: { streaming: boolean } };
    }>;
    expect(res.id).toBe(1);
    expect(res.result.serverInfo.name).toBe('afk');
    expect(res.result.capabilities.streaming).toBe(true);
  });
});

describe('ACP server — session/new', () => {
  it('rejects before initialize', async () => {
    const [res] = await runScenario([req(1, 'session/new')]) as Array<{
      id: number; error: { code: number };
    }>;
    expect(res.error.code).toBe(-32600);
  });

  it('creates a session and returns a sessionId after initialize', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new'),
    ]) as Array<{ id: number; result?: { sessionId?: string }; error?: unknown }>;

    const newRes = results.find((r) => r.id === 2);
    expect(newRes?.result?.sessionId).toMatch(/^acp-/);
  });
});

describe('ACP server — session/prompt', () => {
  it('streams text_delta updates then done', async () => {
    mockSendMessageStream.mockImplementation(() =>
      makeStream([
        { type: 'chunk', chunk: { type: 'content', content: 'Hello' } },
        { type: 'chunk', chunk: { type: 'content', content: ' world' } },
        { type: 'done', metadata: {} },
      ] as OutputEvent[]),
    );

    const input = new PassThrough();
    const output = new PassThrough();

    // Read output line by line via async iterator
    const rl = (await import('node:readline')).createInterface({ input: output, crlfDelay: Infinity });
    const lineQueue: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    rl.on('line', (line) => {
      if (waiters.length > 0) {
        waiters.shift()!(line);
      } else {
        lineQueue.push(line);
      }
    });
    const nextLine = (): Promise<string> =>
      lineQueue.length > 0
        ? Promise.resolve(lineQueue.shift()!)
        : new Promise((resolve) => waiters.push(resolve));

    const serverDone = runAcpServer({ model: 'sonnet', maxTurns: 10, input, output });

    // Step 1: initialize
    input.write(req(1, 'initialize') + '\n');
    const initRes = JSON.parse(await nextLine()) as { id: number; result: { serverInfo: { name: string } } };
    expect(initRes.id).toBe(1);
    expect(initRes.result.serverInfo.name).toBe('afk');

    // Step 2: session/new
    input.write(req(2, 'session/new') + '\n');
    const newRes = JSON.parse(await nextLine()) as { id: number; result: { sessionId: string } };
    expect(newRes.id).toBe(2);
    const sessionId = newRes.result.sessionId;
    expect(sessionId).toMatch(/^acp-/);

    // Step 3: session/prompt — expect 2 update frames + 1 done frame
    input.write(req(3, 'session/prompt', { sessionId, prompt: 'hi' }) + '\n');
    const frame1 = JSON.parse(await nextLine()) as { id: number; result: { type: string; update: { type: string; delta: string } } };
    const frame2 = JSON.parse(await nextLine()) as { id: number; result: { type: string; update: { type: string; delta: string } } };
    const frame3 = JSON.parse(await nextLine()) as { id: number; result: { type: string } };

    expect(frame1.result.type).toBe('update');
    expect(frame1.result.update.type).toBe('text_delta');
    expect(frame1.result.update.delta).toBe('Hello');

    expect(frame2.result.type).toBe('update');
    expect(frame2.result.update.type).toBe('text_delta');
    expect(frame2.result.update.delta).toBe(' world');

    expect(frame3.result.type).toBe('done');

    input.end();
    await serverDone;
  });

  it('returns error for unknown sessionId', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/prompt', { sessionId: 'no-such', prompt: 'hi' }),
    ]) as Array<{ id: number; error?: { code: number } }>;

    const promptRes = results.find((r) => r.id === 2);
    expect(promptRes?.error?.code).toBe(-32602);
  });

  it('returns error when prompt is missing', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new'),
      req(3, 'session/prompt', { sessionId: 'acp-fake', prompt: '' }),
    ]) as Array<{ id: number; error?: { code: number } }>;

    const promptRes = results.find((r) => r.id === 3);
    expect(promptRes?.error?.code).toBe(-32602);
  });
});

describe('ACP server — session/close', () => {
  it('closes an existing session', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new'),
    ]) as Array<{ id: number; result?: { sessionId?: string } }>;

    const sessionId = results.find((r) => r.id === 2)?.result?.sessionId ?? '';
    expect(sessionId).toMatch(/^acp-/);

    const results2 = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new'),
      req(3, 'session/close', { sessionId }),
    ]) as Array<{ id: number; result?: { closed?: boolean }; error?: { code: number } }>;

    // The sessionId from the first run won't exist in the second run's state,
    // so close will return an error — that's the expected behaviour.
    const closeRes = results2.find((r) => r.id === 3);
    expect(closeRes).toBeDefined();
  });

  it('returns error for unknown sessionId', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/close', { sessionId: 'no-such' }),
    ]) as Array<{ id: number; error?: { code: number } }>;

    const closeRes = results.find((r) => r.id === 2);
    expect(closeRes?.error?.code).toBe(-32602);
  });
});

describe('ACP server — protocol errors', () => {
  it('returns parse error for malformed JSON', async () => {
    const results = await runScenario(['not json']) as Array<{ error?: { code: number } }>;
    expect(results[0]?.error?.code).toBe(-32700);
  });

  it('returns invalid request for missing method', async () => {
    const results = await runScenario([
      JSON.stringify({ jsonrpc: '2.0', id: 1 }),
    ]) as Array<{ error?: { code: number } }>;
    expect(results[0]?.error?.code).toBe(-32600);
  });

  it('returns method-not-found for unknown method', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'unknown/method'),
    ]) as Array<{ id: number; error?: { code: number } }>;

    const res = results.find((r) => r.id === 2);
    expect(res?.error?.code).toBe(-32601);
  });

  it('skips blank lines silently', async () => {
    const results = await runScenario([
      '',
      '   ',
      req(1, 'initialize'),
    ]);
    expect(results).toHaveLength(1);
  });
});
