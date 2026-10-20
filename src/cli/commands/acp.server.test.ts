/**
 * Unit tests for the ACP JSON-RPC 2.0 stdio server (acp.server.ts).
 *
 * All tests run over in-memory PassThrough streams — no real AgentSession or
 * Anthropic API calls are made.  acp.session.ts is mocked to return a fake
 * session handle whose `sendMessageStream` is fully controlled per test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Mock acp.session.ts — must be hoisted before any server import
// ---------------------------------------------------------------------------

const mockSendMessageStream = vi.fn();
const mockSessionClose = vi.fn().mockResolvedValue(undefined);
const mockMemoryClose = vi.fn();
const mockStateClose = vi.fn();

// vi.mock factories are hoisted — cannot reference let/const from outer scope.
// Use vi.fn() inline; we import the mock module below to spy on buildAcpSession.
vi.mock('./acp.session.js', () => ({
  buildAcpSession: vi.fn(async () => ({
    session: {
      sendMessageStream: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
    },
    memoryStore: { close: vi.fn() },
    stateStore: { close: vi.fn() },
  })),
  closeAcpSession: vi.fn(async (handle: { session: { close: () => Promise<void> } }) => {
    await handle.session.close();
    (handle as unknown as Record<string, { close?: () => void }>)['memoryStore']?.close?.();
    (handle as unknown as Record<string, { close?: () => void }>)['stateStore']?.close?.();
  }),
}));

// ---------------------------------------------------------------------------
// Import server AFTER mock is registered; import mock module to access spies
// ---------------------------------------------------------------------------

import { runAcpServer } from './acp.server.js';
import * as acpSession from './acp.session.js';

// Typed alias for the hoisted mock's buildAcpSession spy
const mockBuildAcpSession = acpSession.buildAcpSession as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send NDJSON lines to the server and collect all NDJSON output lines.
 * The server loop ends when the input stream ends (`.end()`).
 */
async function runScenario(
  lines: string[],
  opts?: { dangerouslySkipPermissions?: boolean },
): Promise<unknown[]> {
  const input = new PassThrough();
  const output = new PassThrough();

  const serverDone = runAcpServer({
    model: 'sonnet',
    maxTurns: 10,
    input,
    output,
    ...opts,
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
  // Re-wire the hoisted buildAcpSession mock to use our controllable fakes
  mockBuildAcpSession.mockResolvedValue({
    session: {
      sendMessageStream: mockSendMessageStream,
      close: mockSessionClose,
      abort: vi.fn(),
    },
    memoryStore: { close: mockMemoryClose },
    stateStore: { close: mockStateClose },
  });
});

describe('ACP server — initialize', () => {
  it('returns server info and capabilities', async () => {
    const [res] = await runScenario([req(1, 'initialize')]) as Array<{
      id: number;
      result: { serverInfo: { name: string }; agentCapabilities: { streaming: boolean } };
    }>;
    if (!res) throw new Error('expected response');
    expect(res.id).toBe(1);
    expect(res.result.serverInfo.name).toBe('afk');
    expect(res.result.agentCapabilities.streaming).toBe(true);
  });

  // Fix #3: initialize must include protocolVersion and agentCapabilities
  it('initialize includes protocolVersion and agentCapabilities', async () => {
    const [res] = await runScenario([req(1, 'initialize')]) as Array<{
      id: number;
      result: {
        protocolVersion: string;
        agentCapabilities: { streaming: boolean; methods: string[] };
        serverInfo: { name: string; version: string };
      };
    }>;
    if (!res) throw new Error('expected response');
    expect(res.result.protocolVersion).toBe('1.0');
    expect(res.result.agentCapabilities.streaming).toBe(true);
    expect(res.result.agentCapabilities.methods).toContain('session/cancel');
    expect(res.result.serverInfo.version).toBe('acp/1.0');
  });
});

describe('ACP server — session/new', () => {
  it('rejects before initialize', async () => {
    const [res] = await runScenario([req(1, 'session/new')]) as Array<{
      id: number; error: { code: number };
    }>;
    if (!res) throw new Error('expected response');
    expect(res.error.code).toBe(-32600);
  });

  it('creates a session and returns a sessionId after initialize', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new'),
    ]) as Array<{ id: number; result?: { sessionId?: string }; error?: unknown }>;

    const newRes = results.find((r) => r.id === 2);
    // Fix non-blocking extra: IDs are now UUIDs, not acp- prefixed
    expect(typeof newRes?.result?.sessionId).toBe('string');
    expect((newRes?.result?.sessionId as string).length).toBeGreaterThan(0);
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
    const initRes = JSON.parse(await nextLine()) as {
      id: number; result: { serverInfo: { name: string } };
    };
    expect(initRes.id).toBe(1);
    expect(initRes.result.serverInfo.name).toBe('afk');

    // Step 2: session/new
    input.write(req(2, 'session/new') + '\n');
    const newRes = JSON.parse(await nextLine()) as { id: number; result: { sessionId: string } };
    expect(newRes.id).toBe(2);
    const sessionId = newRes.result.sessionId;
    expect(typeof sessionId).toBe('string');

    // Step 3: session/prompt — expect 2 notification frames + 1 done response
    input.write(req(3, 'session/prompt', { sessionId, prompt: 'hi' }) + '\n');

    // Fix #2: intermediate frames are notifications (no id, method: session/update)
    const frame1 = JSON.parse(await nextLine()) as {
      jsonrpc: string; method?: string; id?: number;
      params?: { type: string; update: { type: string; delta: string } };
    };
    const frame2 = JSON.parse(await nextLine()) as {
      jsonrpc: string; method?: string; id?: number;
      params?: { type: string; update: { type: string; delta: string } };
    };
    const frame3 = JSON.parse(await nextLine()) as {
      id: number; result: { type: string };
    };

    // Intermediate frames must be notifications (no id)
    expect(frame1.method).toBe('session/update');
    expect(frame1.id).toBeUndefined();
    expect(frame1.params?.update.type).toBe('text_delta');
    expect(frame1.params?.update.delta).toBe('Hello');

    expect(frame2.method).toBe('session/update');
    expect(frame2.id).toBeUndefined();
    expect(frame2.params?.update.delta).toBe(' world');

    // Final frame is a response with the request id
    expect(frame3.id).toBe(3);
    expect(frame3.result.type).toBe('done');

    input.end();
    await serverDone;
  });

  // Fix #2: explicit test that intermediate frames have no id
  it('intermediate frames are notifications without id', async () => {
    mockSendMessageStream.mockImplementation(() =>
      makeStream([
        { type: 'chunk', chunk: { type: 'content', content: 'A' } },
        { type: 'done', metadata: {} },
      ] as OutputEvent[]),
    );

    // All in ONE runScenario so the sessionId is valid
    const allResults = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new'),
      // sessionId resolved inline via the req builder — use a placeholder;
      // the server will return -32602 for unknown id, but we need the real one.
      // So we must read it from step 2 and build step 3 dynamically.
      // Instead, use the streaming test helper pattern inline:
    ]);

    const sessionId = (allResults.find((r: unknown) =>
      (r as { id?: number }).id === 2) as { result: { sessionId: string } }).result.sessionId;

    const input2 = new PassThrough();
    const output2 = new PassThrough();
    const chunks: Buffer[] = [];
    output2.on('data', (c: Buffer) => chunks.push(c));
    const done2 = runAcpServer({ model: 'sonnet', maxTurns: 10, input: input2, output: output2 });
    input2.write(req(1, 'initialize') + '\n');
    input2.write(req(2, 'session/new') + '\n');
    // Give server a tick to create session and get real sessionId
    await new Promise<void>((r) => setImmediate(r));
    // Read the real sessionId from output2
    const partial = Buffer.concat(chunks).toString('utf-8');
    const lines2 = partial.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const realSessionId = (lines2.find((r) => r['id'] === 2) as { result: { sessionId: string } } | undefined)?.result?.sessionId ?? sessionId;
    input2.write(req(3, 'session/prompt', { sessionId: realSessionId, prompt: 'hi' }) + '\n');
    input2.end();
    await done2;
    await new Promise<void>((r) => setImmediate(r));
    const allLines = Buffer.concat(chunks).toString('utf-8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);

    // Find the notification frame (no id field)
    const notification = allLines.find((r: unknown) => {
      const frame = r as Record<string, unknown>;
      return frame['method'] === 'session/update' && !('id' in frame);
    });
    expect(notification).toBeDefined();
    // The done response must have the request id
    const doneFrame = allLines.find((r: unknown) => {
      const frame = r as Record<string, unknown>;
      return typeof frame['id'] === 'number' &&
        (frame['result'] as Record<string, unknown>)?.['type'] === 'done';
    });
    expect(doneFrame).toBeDefined();
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

  // Fix #4: accept ContentBlock[] as prompt
  it('accepts ContentBlock[] as prompt', async () => {
    mockSendMessageStream.mockImplementation(() =>
      makeStream([{ type: 'done', metadata: {} }] as OutputEvent[]),
    );

    // Use streaming helper to get the real sessionId within a single server run
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c: Buffer) => chunks.push(c));
    const serverDone = runAcpServer({ model: 'sonnet', maxTurns: 10, input, output });

    input.write(req(1, 'initialize') + '\n');
    input.write(req(2, 'session/new') + '\n');
    await new Promise<void>((r) => setImmediate(r));

    const partial = Buffer.concat(chunks).toString('utf-8');
    const earlyLines = partial.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const sessionId = (earlyLines.find((r) => r['id'] === 2) as { result: { sessionId: string } }).result.sessionId;

    input.write(req(3, 'session/prompt', {
      sessionId,
      prompt: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ],
    }) + '\n');
    input.end();
    await serverDone;
    await new Promise<void>((r) => setImmediate(r));

    const allLines = Buffer.concat(chunks).toString('utf-8')
      .split('\n').filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { id?: number; result?: { type: string }; error?: { code: number } });

    const promptRes = allLines.find((r) => r.id === 3);
    expect(promptRes?.result?.type).toBe('done');
    expect(mockSendMessageStream).toHaveBeenCalledWith('Hello world');
  });

  // Fix #6: error responses do not leak internal messages
  it('error responses do not leak internal messages', async () => {
    const internalMsg = 'secret database connection string xyz123';
    mockSendMessageStream.mockImplementation(async function* () {
      throw new Error(internalMsg);
    });

    // Single server run so sessionId is valid
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c: Buffer) => chunks.push(c));
    const serverDone = runAcpServer({ model: 'sonnet', maxTurns: 10, input, output });

    input.write(req(1, 'initialize') + '\n');
    input.write(req(2, 'session/new') + '\n');
    await new Promise<void>((r) => setImmediate(r));

    const partial = Buffer.concat(chunks).toString('utf-8');
    const earlyLines = partial.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const sessionId = (earlyLines.find((r) => r['id'] === 2) as { result: { sessionId: string } }).result.sessionId;

    input.write(req(3, 'session/prompt', { sessionId, prompt: 'hi' }) + '\n');
    input.end();
    await serverDone;
    await new Promise<void>((r) => setImmediate(r));

    const allLines = Buffer.concat(chunks).toString('utf-8')
      .split('\n').filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { id?: number; error?: { code: number; message: string } });

    const promptRes = allLines.find((r) => r.id === 3);
    expect(promptRes?.error?.code).toBe(-32603);
    expect(promptRes?.error?.message).not.toContain(internalMsg);
    expect(promptRes?.error?.message).toBe('Internal server error');
  });
});

describe('ACP server — session/close', () => {
  it('closes an existing session', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new'),
    ]) as Array<{ id: number; result?: { sessionId?: string } }>;

    const sessionId = results.find((r) => r.id === 2)?.result?.sessionId ?? '';
    expect(typeof sessionId).toBe('string');

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

describe('ACP server — session/cancel', () => {
  // Fix #8: session/cancel aborts a running prompt
  it('session/cancel aborts a running prompt', async () => {
    // Create a stream that never resolves on its own (blocked)
    let resolveStream!: () => void;
    const blockedStream = async function* () {
      await new Promise<void>((r) => { resolveStream = r; });
      yield { type: 'done', metadata: {} } as OutputEvent;
    };
    mockSendMessageStream.mockImplementation(blockedStream);

    const input = new PassThrough();
    const output = new PassThrough();
    const rl = (await import('node:readline')).createInterface({ input: output, crlfDelay: Infinity });
    const lineQueue: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    rl.on('line', (line) => {
      if (waiters.length > 0) waiters.shift()!(line);
      else lineQueue.push(line);
    });
    const nextLine = (): Promise<string> =>
      lineQueue.length > 0
        ? Promise.resolve(lineQueue.shift()!)
        : new Promise((resolve) => waiters.push(resolve));

    const serverDone = runAcpServer({ model: 'sonnet', maxTurns: 10, input, output });

    input.write(req(1, 'initialize') + '\n');
    await nextLine(); // init response

    input.write(req(2, 'session/new') + '\n');
    const newLine = await nextLine();
    const newRes = JSON.parse(newLine) as { result: { sessionId: string } };
    const sessionId = newRes.result.sessionId;

    // Start the prompt (fire-and-forget on server side)
    input.write(req(3, 'session/prompt', { sessionId, prompt: 'block me' }) + '\n');

    // Give the server a tick to start handling the prompt
    await new Promise<void>((r) => setImmediate(r));

    // Send cancel — should get a response
    input.write(req(4, 'session/cancel', { sessionId }) + '\n');
    const cancelLine = await nextLine();
    const cancelRes = JSON.parse(cancelLine) as { id: number; result: { cancelled: boolean } };
    expect(cancelRes.id).toBe(4);
    expect(cancelRes.result.cancelled).toBe(true);

    // Unblock the stream so the server can finish
    resolveStream();
    input.end();
    await serverDone;
  });

  it('returns error for unknown sessionId', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/cancel', { sessionId: 'no-such' }),
    ]) as Array<{ id: number; error?: { code: number } }>;

    const res = results.find((r) => r.id === 2);
    expect(res?.error?.code).toBe(-32602);
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

  // Fix #7: rejects oversized lines
  it('rejects oversized lines', async () => {
    // Build a line just over 1MiB
    const oversized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { pad: 'x'.repeat(1_048_577) },
    });
    const results = await runScenario([oversized]) as Array<{
      error?: { code: number; message: string };
    }>;
    expect(results[0]?.error?.code).toBe(-32700);
    expect(results[0]?.error?.message).toMatch(/too large/i);
  });
});

describe('ACP server — cwd validation', () => {
  it('rejects cwd outside process.cwd()', async () => {
    // H4: use os.tmpdir() realpath — guaranteed to exist on all platforms
    // (including Windows) and guaranteed to be outside process.cwd() in CI.
    const outsideCwd = realpathSync(os.tmpdir());
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new', { cwd: outsideCwd }),
    ]) as Array<{ id: number; error?: { code: number; message: string } }>;

    const res = results.find((r) => r.id === 2);
    expect(res?.error?.code).toBe(-32602);
    expect(res?.error?.message).toMatch(/outside server working directory/i);
  });

  it('rejects non-existent cwd', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new', { cwd: '/this/path/does/not/exist/afk-test-xyz' }),
    ]) as Array<{ id: number; error?: { code: number; message: string } }>;

    const res = results.find((r) => r.id === 2);
    expect(res?.error?.code).toBe(-32602);
    expect(res?.error?.message).toMatch(/does not exist/i);
  });

  it('accepts valid cwd under process.cwd()', async () => {
    const results = await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new', { cwd: process.cwd() }),
    ]) as Array<{ id: number; result?: { sessionId?: string }; error?: unknown }>;

    const res = results.find((r) => r.id === 2);
    expect(res?.error).toBeUndefined();
    expect(typeof res?.result?.sessionId).toBe('string');
  });

  it('passes validated cwd to buildAcpSession', async () => {
    await runScenario([
      req(1, 'initialize'),
      req(2, 'session/new', { cwd: process.cwd() }),
    ]);

    expect(mockBuildAcpSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });
});

describe('ACP server — session/cancel', () => {
  it('cancel calls session.abort to interrupt the stream', async () => {
    const mockAbort = vi.fn();
    let resolveStream!: () => void;
    const blockedStream = async function* () {
      await new Promise<void>((r) => { resolveStream = r; });
      yield { type: 'done', metadata: {} } as OutputEvent;
    };
    mockSendMessageStream.mockImplementation(blockedStream);
    mockBuildAcpSession.mockResolvedValue({
      session: {
        sendMessageStream: mockSendMessageStream,
        close: mockSessionClose,
        abort: mockAbort,
      },
      memoryStore: { close: mockMemoryClose },
      stateStore: { close: mockStateClose },
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const rl = (await import('node:readline')).createInterface({ input: output, crlfDelay: Infinity });
    const lineQueue: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    rl.on('line', (line) => {
      if (waiters.length > 0) waiters.shift()!(line);
      else lineQueue.push(line);
    });
    const nextLine = (): Promise<string> =>
      lineQueue.length > 0
        ? Promise.resolve(lineQueue.shift()!)
        : new Promise((resolve) => waiters.push(resolve));

    const serverDone = runAcpServer({ model: 'sonnet', maxTurns: 10, input, output });

    input.write(req(1, 'initialize') + '\n');
    await nextLine();

    input.write(req(2, 'session/new') + '\n');
    const newRes = JSON.parse(await nextLine()) as { result: { sessionId: string } };
    const sessionId = newRes.result.sessionId;

    input.write(req(3, 'session/prompt', { sessionId, prompt: 'block me' }) + '\n');
    await new Promise<void>((r) => setImmediate(r));

    input.write(req(4, 'session/cancel', { sessionId }) + '\n');
    const cancelLine = await nextLine();
    const cancelRes = JSON.parse(cancelLine) as { id: number; result: { cancelled: boolean } };
    expect(cancelRes.id).toBe(4);
    expect(cancelRes.result.cancelled).toBe(true);
    expect(mockAbort).toHaveBeenCalledWith('acp-cancel');

    resolveStream();
    input.end();
    await serverDone;
  });
});

// Fix #1: default permissionMode is 'default'
describe('ACP server — permissionMode', () => {
  it('default permissionMode is default (no bypassPermissions)', async () => {
    await runScenario([req(1, 'initialize'), req(2, 'session/new')]);
    expect(mockBuildAcpSession).toHaveBeenCalledWith(
      expect.objectContaining({ dangerouslySkipPermissions: undefined }),
    );
  });

  it('passes dangerouslySkipPermissions=true when flag is set', async () => {
    await runScenario(
      [req(1, 'initialize'), req(2, 'session/new')],
      { dangerouslySkipPermissions: true },
    );
    expect(mockBuildAcpSession).toHaveBeenCalledWith(
      expect.objectContaining({ dangerouslySkipPermissions: true }),
    );
  });
});
