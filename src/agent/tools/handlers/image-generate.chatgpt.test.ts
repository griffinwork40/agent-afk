import { describe, it, expect, vi } from 'vitest';
import { generateImageViaChatGpt } from './image-generate.chatgpt.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** Build a ReadableStream that emits SSE lines from an array of event objects. */
function makeSseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
  lines.push('data: [DONE]\n\n');
  const body = lines.join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

function makeSseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(makeSseStream(events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const signal = new AbortController().signal;

const baseReq = {
  prompt: 'a dog',
  size: '1024x1024',
  quality: 'medium',
  output_format: 'png',
  apiKey: 'test-token',
  accountId: 'acct_123',
  signal,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateImageViaChatGpt', () => {
  it('sends correct headers and payload to the ChatGPT backend', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeSseResponse([
      {
        type: 'response.completed',
        response: {
          output: [{
            type: 'image_generation_call',
            result: { b64_json: TINY_PNG_B64, revised_prompt: 'revised' },
          }],
        },
      },
    ]));

    await generateImageViaChatGpt({ ...baseReq, fetchFn });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, opts] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer test-token');
    expect(opts.headers['chatgpt-account-id']).toBe('acct_123');
    expect(opts.headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(opts.headers['originator']).toBe('codex_cli_rs');
    expect(opts.headers['Accept']).toBe('text/event-stream');

    const body = JSON.parse(opts.body);
    expect(body.stream).toBe(true);
    expect(body.tools[0].type).toBe('image_generation');
    expect(body.tool_choice.mode).toBe('required');
  });

  it('extracts image from response.completed output array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeSseResponse([
      { type: 'response.created' },
      { type: 'response.in_progress' },
      {
        type: 'response.completed',
        response: {
          output: [{
            type: 'image_generation_call',
            result: { b64_json: TINY_PNG_B64, revised_prompt: 'a happy dog' },
          }],
        },
      },
    ]));

    const result = await generateImageViaChatGpt({ ...baseReq, fetchFn });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.b64_json).toBe(TINY_PNG_B64);
      expect(result.revised_prompt).toBe('a happy dog');
    }
  });

  it('extracts image from image_generation_call.completed event', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeSseResponse([
      {
        type: 'response.image_generation_call.completed',
        b64_json: TINY_PNG_B64,
        revised_prompt: 'from completed event',
      },
      { type: 'response.completed', response: { output: [] } },
    ]));

    const result = await generateImageViaChatGpt({ ...baseReq, fetchFn });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.b64_json).toBe(TINY_PNG_B64);
      expect(result.revised_prompt).toBe('from completed event');
    }
  });

  it('returns error when SSE contains no image data', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeSseResponse([
      { type: 'response.completed', response: { output: [] } },
    ]));

    const result = await generateImageViaChatGpt({ ...baseReq, fetchFn });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('no image data');
    }
  });

  it('returns error on HTTP failure', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response('{"detail":"usage_limit_reached"}', { status: 429 }),
    );

    const result = await generateImageViaChatGpt({ ...baseReq, fetchFn });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('429');
    }
  });

  it('returns error on network failure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await generateImageViaChatGpt({ ...baseReq, fetchFn });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('ECONNREFUSED');
    }
  });

  it('extracts image from response.output_item.done with bare-string result', async () => {
    // This is the primary path for newer ChatGPT backend models (gpt-6-sol etc.)
    // where item.result is a bare base64 string, not { b64_json: ... }.
    const fetchFn = vi.fn().mockResolvedValue(makeSseResponse([
      { type: 'response.created' },
      { type: 'response.image_generation_call.completed', item_id: 'ig_1', output_index: 0 },
      {
        type: 'response.output_item.done',
        item: {
          id: 'ig_1',
          type: 'image_generation_call',
          status: 'completed',
          result: TINY_PNG_B64,
          revised_prompt: 'from output_item.done bare string',
        },
      },
      { type: 'response.completed', response: { output: [] } },
    ]));

    const result = await generateImageViaChatGpt({ ...baseReq, fetchFn });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.b64_json).toBe(TINY_PNG_B64);
      expect(result.revised_prompt).toBe('from output_item.done bare string');
    }
  });

  it('extracts image from response.output_item.done with object result', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeSseResponse([
      {
        type: 'response.output_item.done',
        item: {
          id: 'ig_2',
          type: 'image_generation_call',
          status: 'completed',
          result: { b64_json: TINY_PNG_B64, revised_prompt: 'from object result' },
        },
      },
      { type: 'response.completed', response: { output: [] } },
    ]));

    const result = await generateImageViaChatGpt({ ...baseReq, fetchFn });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.b64_json).toBe(TINY_PNG_B64);
      expect(result.revised_prompt).toBe('from object result');
    }
  });

  it('extracts bare-string result from response.completed output array', async () => {
    // Some backends put the bare string in response.output[] too.
    const fetchFn = vi.fn().mockResolvedValue(makeSseResponse([
      {
        type: 'response.completed',
        response: {
          output: [{
            type: 'image_generation_call',
            result: TINY_PNG_B64,
            revised_prompt: 'bare string in completed',
          }],
        },
      },
    ]));

    const result = await generateImageViaChatGpt({ ...baseReq, fetchFn });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.b64_json).toBe(TINY_PNG_B64);
      expect(result.revised_prompt).toBe('bare string in completed');
    }
  });

  it('maps quality "auto" to "medium" for the subscription backend', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeSseResponse([
      {
        type: 'response.completed',
        response: {
          output: [{
            type: 'image_generation_call',
            result: { b64_json: TINY_PNG_B64 },
          }],
        },
      },
    ]));

    await generateImageViaChatGpt({ ...baseReq, quality: 'auto', fetchFn });
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.tools[0].quality).toBe('medium');
  });
});
