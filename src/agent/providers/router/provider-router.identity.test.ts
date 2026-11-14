/**
 * Tests for provider-router.identity.ts: the router pins every forwarded
 * event's sessionId to the id of the first (yielded) `session.init`, so a
 * rebuilt inner that mints its own id never re-stamps the session's id.
 */
import { describe, it, expect } from 'vitest';
import { pinSessionId, pinSessionIds } from './provider-router.identity.js';
import type { ProviderEvent } from '../../provider.js';

async function collect(events: ProviderEvent[]): Promise<ProviderEvent[]> {
  async function* lane(): AsyncGenerator<ProviderEvent, void, unknown> {
    yield* events;
  }
  const out: ProviderEvent[] = [];
  for await (const ev of pinSessionIds(lane())) out.push(ev);
  return out;
}

describe('pinSessionId', () => {
  it('rewrites a differing sessionId and leaves the original event untouched', () => {
    const ev: ProviderEvent = { type: 'assistant.message', text: 'hi', sessionId: 'minted' };
    expect(pinSessionId(ev, 'anchor')).toEqual({ type: 'assistant.message', text: 'hi', sessionId: 'anchor' });
    expect(ev.sessionId).toBe('minted');
  });

  it('passes through events without a sessionId, a matching id, or no anchor', () => {
    const noId: ProviderEvent = { type: 'assistant.message', text: 'hi' };
    const same: ProviderEvent = { type: 'assistant.message', text: 'hi', sessionId: 'anchor' };
    expect(pinSessionId(noId, 'anchor')).toBe(noId);
    expect(pinSessionId(same, 'anchor')).toBe(same);
    expect(pinSessionId(same, undefined)).toBe(same);
  });
});

describe('pinSessionIds', () => {
  it('anchors on the first session.init and pins later events from a rebuilt inner', async () => {
    const out = await collect([
      { type: 'session.init', info: { sessionId: 'first' } },
      { type: 'assistant.message', text: 'a', sessionId: 'first' },
      // A rebuilt inner (fallback or /model swap) minted its own id.
      { type: 'assistant.message', text: 'b', sessionId: 'second' },
      { type: 'session.status', sessionId: 'second' },
      { type: 'turn.completed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, sessionId: 'second' },
    ]);
    const ids = out.map((e) => (e.type === 'session.init' ? e.info.sessionId : (e as { sessionId?: string }).sessionId));
    expect(ids).toEqual(['first', 'first', 'first', 'first', 'first']);
  });

  it('forwards return() so the lane teardown runs when the consumer stops early', async () => {
    let tornDown = false;
    async function* lane(): AsyncGenerator<ProviderEvent, void, unknown> {
      try {
        yield { type: 'session.init', info: { sessionId: 'first' } };
        yield { type: 'assistant.message', text: 'never read' };
      } finally {
        tornDown = true;
      }
    }
    const it = pinSessionIds(lane());
    await it.next();
    await it.return(undefined);
    expect(tornDown).toBe(true);
  });
});
