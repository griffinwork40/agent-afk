/**
 * Tests for the local HTTP capture server used by the what-if snapshot path.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startCaptureServer } from './capture-server.js';
import type { CaptureServer } from './capture-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Consume an SSE stream and return all event lines. */
async function collectSseLines(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim() !== '') lines.push(line);
    }
  }
  if (buf.trim() !== '') lines.push(buf);
  return lines;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('capture-server', () => {
  let server: CaptureServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('starts on a random port and records a non-streaming POST', async () => {
    server = await startCaptureServer();
    expect(server.port).toBeGreaterThan(0);

    const body = { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 };
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json['type']).toBe('message');
    expect(json['content']).toEqual([{ type: 'text', text: 'ok' }]);
    expect(json['stop_reason']).toBe('end_turn');

    expect(server.requests).toHaveLength(1);
    const captured = server.requests[0]?.body as Record<string, unknown>;
    expect(captured['model']).toBe('claude-3-5-sonnet');
  });

  it('captures the request body without headers', async () => {
    server = await startCaptureServer();
    const body = { model: 'test-model', secret_header_via_body: false, messages: [] };
    await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-ant-secret' },
      body: JSON.stringify(body),
    });
    // Should have captured body but NOT headers.
    expect(server.requests).toHaveLength(1);
    const captured = server.requests[0]?.body as Record<string, unknown>;
    expect(captured['model']).toBe('test-model');
    // Authorization header is not in the body record.
    expect(captured['authorization']).toBeUndefined();
  });

  it('handles streaming request and produces valid SSE sequence', async () => {
    server = await startCaptureServer();
    const body = {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 10,
      stream: true,
    };
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const lines = await collectSseLines(res.body!);
    // Must contain message_start, content_block_start, content_block_delta, message_delta, message_stop
    const eventLines = lines.filter((l) => l.startsWith('event:'));
    const eventNames = eventLines.map((l) => l.replace('event: ', '').trim());
    expect(eventNames).toContain('message_start');
    expect(eventNames).toContain('content_block_start');
    expect(eventNames).toContain('content_block_delta');
    expect(eventNames).toContain('content_block_stop');
    expect(eventNames).toContain('message_delta');
    expect(eventNames).toContain('message_stop');

    // Check data lines are valid JSON.
    const dataLines = lines.filter((l) => l.startsWith('data:'));
    for (const dl of dataLines) {
      const json = dl.replace(/^data:\s*/, '');
      expect(() => JSON.parse(json)).not.toThrow();
    }

    expect(server.requests).toHaveLength(1);
  });

  it('replies 200 to count_tokens probe', async () => {
    server = await startCaptureServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json['input_tokens']).toBe(1);
    // count_tokens requests are NOT added to the capture list.
    expect(server.requests).toHaveLength(0);
  });

  it('accumulates multiple requests in order', async () => {
    server = await startCaptureServer();
    const url = `http://127.0.0.1:${server.port}/v1/messages`;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'first', messages: [] }),
    });
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'second', messages: [] }),
    });
    expect(server.requests).toHaveLength(2);
    expect((server.requests[0]?.body as Record<string, unknown>)['model']).toBe('first');
    expect((server.requests[1]?.body as Record<string, unknown>)['model']).toBe('second');
  });

  it('returns 405 for GET requests', async () => {
    server = await startCaptureServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`);
    expect(res.status).toBe(405);
  });

  it('works with any path ending in /messages', async () => {
    server = await startCaptureServer();
    const body = { model: 'x', messages: [] };
    const res = await fetch(`http://127.0.0.1:${server.port}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(server.requests).toHaveLength(1);
  });
});
