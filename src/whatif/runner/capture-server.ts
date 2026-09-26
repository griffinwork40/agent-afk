/**
 * Minimal local HTTP server that intercepts the Anthropic Messages API for
 * what-if snapshot capture.
 *
 * The server:
 *   - Listens on 127.0.0.1:0 (OS-assigned port).
 *   - Accepts POST to any path ending in `/messages`.
 *   - Records the parsed JSON request body (headers are never logged).
 *   - Replies with a synthetic valid Anthropic response (streaming or JSON).
 *   - Replies 200 to POST `…/messages/count_tokens` with `{input_tokens:1}`.
 *   - Returns 405 for all other methods/paths.
 *
 * Usage: `await startCaptureServer()` → `{ port, requests, close }`.
 *
 * @module whatif/runner/capture-server
 */

import * as http from 'node:http';

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid Anthropic SSE streaming response body.
 *
 * Contract: the sequence is:
 *   message_start → content_block_start → content_block_delta →
 *   content_block_stop → message_delta → message_stop
 *
 * Enough for the SDK to parse without errors; actual text is 'ok'.
 */
function buildSseBody(model: string): string {
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_whatif_snapshot',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'ping',
      data: { type: 'ping' },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    },
    {
      event: 'message_stop',
      data: { type: 'message_stop' },
    },
  ];
  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n`)
    .join('\n') + '\n';
}

/** Build a minimal valid Anthropic non-streaming JSON response body. */
function buildJsonBody(model: string): string {
  return JSON.stringify({
    id: 'msg_whatif_snapshot',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CapturedRequest {
  /** Parsed JSON request body; headers are never recorded. */
  body: unknown;
}

export interface CaptureServer {
  /** Port the server is listening on (OS-assigned). */
  port: number;
  /** All captured /messages request bodies in arrival order. */
  requests: CapturedRequest[];
  /** Shut down the HTTP server. Resolves when the close callback fires. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the capture server and return a handle for reading captured requests
 * and shutting it down.
 */
export async function startCaptureServer(): Promise<CaptureServer> {
  const requests: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // Handle count_tokens probe.
    if (method === 'POST' && url.endsWith('/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }

    // Only accept POST …/messages.
    if (method !== 'POST' || !url.endsWith('/messages')) {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    // Accumulate body bytes then parse.
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad json' }));
        return;
      }

      // Record the body (headers intentionally excluded).
      requests.push({ body });

      const bodyObj = body as Record<string, unknown>;
      const model = typeof bodyObj['model'] === 'string' ? bodyObj['model'] : 'claude-3-5-sonnet-20241022';
      const streaming = Boolean(bodyObj['stream']);

      if (streaming) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.end(buildSseBody(model));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(buildJsonBody(model));
      }
    });
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  // Bind to a random OS-assigned port on loopback only.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('capture-server: unexpected address type after listen');
  }
  const port = addr.port;

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { port, requests, close };
}
