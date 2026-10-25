import { afterEach, describe, expect, it } from 'vitest';
import { startWebServer, type WebServerHandle } from './server.js';
import type { ChoiceRequest } from './shared/choice-wire.js';
import { parseSseChunk } from './sse-protocol.js';

let server: WebServerHandle | undefined;
afterEach(async () => { await server?.stop(); server = undefined; });
const request: ChoiceRequest = { corrId: 'choose-1', title: 'Pick', options: [{ value: 'yes', label: 'Yes' }], cancellable: true };
const url = (h: WebServerHandle, id = 'mine', corrId = 'choose-1'): string =>
  `http://127.0.0.1:${h.port}/api/sessions/${id}/choices/${corrId}`;
const post = (h: WebServerHandle, body: unknown, opts: { id?: string; corrId?: string; token?: string; origin?: string } = {}): Promise<Response> =>
  fetch(url(h, opts.id, opts.corrId), {
    method: 'POST', headers: {
      authorization: `Bearer ${opts.token ?? h.token}`, 'content-type': 'application/json',
      ...(opts.origin ? { origin: opts.origin } : {}),
    }, body: JSON.stringify(body),
  });

describe('choice answer route', () => {
  it('requires bearer token + allowed Origin before any mutation', async () => {
    server = await startWebServer({ port: 0, owned: new Set(['mine']) });
    const result = server;
    expect((await post(result, { value: 'yes' }, { token: 'wrong' })).status).toBe(401);
    expect((await post(result, { value: 'yes' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(result, { value: 'yes' }, { id: 'unsafe%2Fid' })).status).toBe(400);
    expect((await post(result, { value: 'yes' }, { id: 'foreign' })).status).toBe(409);
    expect((await post(result, { value: 'yes' })).status).toBe(404);
  });

  it.each([
    { name: 'missing bearer', auth: false, query: false, origin: false, status: 401 },
    { name: 'query token only', auth: false, query: true, origin: false, status: 401 },
    { name: 'wrong bearer', auth: true, query: false, origin: false, status: 401 },
    { name: 'foreign Origin with valid bearer', auth: true, query: false, origin: true, status: 403 },
  ])('rejects $name without settling the active choice', async ({ auth, query, origin, status }) => {
    server = await startWebServer({ port: 0, owned: new Set(['mine']) });
    const h = server;
    let settled = false;
    const answer = h.choiceBroker.choose('mine', request).then((value) => { settled = true; return value; });
    const denied = await fetch(url(h) + (query ? `?token=${h.token}` : ''), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${origin ? h.token : 'wrong'}` } : {}),
        ...(origin ? { origin: 'https://evil.example' } : {}),
      },
      body: JSON.stringify({ value: 'yes' }),
    });
    expect(denied.status).toBe(status);
    expect(await denied.json()).toMatchObject({ error: status === 401 ? 'unauthorized' : 'bad_origin' });
    expect(settled).toBe(false);
    // The same active request still accepts a real same-origin authorized answer.
    expect((await post(h, { value: 'yes' }, { origin: `http://127.0.0.1:${h.port}` })).status).toBe(200);
    expect(await answer).toBe('yes');
  });

  it('validates bodies/option membership and enforces session ownership, single answer', async () => {
    server = await startWebServer({ port: 0, owned: new Set(['mine', 'other']) });
    const h = server;
    const answer = h.choiceBroker.choose('mine', request);
    expect((await post(h, {})).status).toBe(400);
    expect((await post(h, { value: 5 })).status).toBe(400);
    expect((await post(h, { value: 'bad' })).status).toBe(400);
    expect((await post(h, { value: 'yes' }, { id: 'other' })).status).toBe(409);
    expect((await post(h, { value: 'yes' })).status).toBe(200);
    expect((await post(h, { value: 'yes' })).status).toBe(404);
    expect(await answer).toBe('yes');
  });

  it('SSE emits id-less ephemeral choice + progress and settles without advancing ledger id', async () => {
    server = await startWebServer({ port: 0, owned: new Set(['mine']) });
    const h = server;
    const abort = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${h.port}/api/sessions/mine/stream`, {
      headers: { authorization: `Bearer ${h.token}` }, signal: abort.signal,
    });
    const reader = stream.body!.getReader();
    const choice = h.choiceBroker.choose('mine', request);
    h.choiceBroker.progress('mine', { corrId: 'p', phase: 'start', label: 'Loading' });
    let buffer = '';
    const frames: { id: string | undefined; data: string }[] = [];
    try {
      while (frames.length < 3) {
        const packet = await reader.read();
        if (packet.done) break;
        buffer += new TextDecoder().decode(packet.value);
        const parsed = parseSseChunk(buffer);
        frames.push(...parsed.events);
        buffer = parsed.remainder;
        if (frames.length === 2) expect((await post(h, { value: 'yes' })).status).toBe(200);
      }
    } finally { abort.abort(); }
    expect(frames.map((frame) => JSON.parse(frame.data).type)).toEqual(['choice_request', 'progress', 'choice_settled']);
    expect(frames.every((frame) => frame.id === undefined)).toBe(true);
    expect(await choice).toBe('yes');
  });
});
