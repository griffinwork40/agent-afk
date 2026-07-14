/**
 * Live-throttle surfacing tests for loop.ts.
 *
 * Contract: the SDK retries 429/503/529 responses INSIDE a single
 * `messages.create` promise, so the loop is parked on that await and cannot
 * yield during the backoff. The wrapped fetch pushes a signal onto
 * {@link ThrottleQueue}; the loop RACES its create await against the queue and
 * yields a `rate_limit` ProviderEvent for each drained signal — LIVE, before
 * the stream events. These tests drive that race with a hand-controlled create
 * promise so the interleaving is deterministic (no real timers, no real SDK).
 */

import { describe, it, expect, vi } from 'vitest';
import type { RawMessageStreamEvent, MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import type { AnthropicClientLike } from './types.js';
import { ThrottleQueue } from './throttle-queue.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeDispatcher,
} from './loop.test-helpers.js';

describe('runTurn — live throttle surfacing', () => {
  it('yields a rate_limit event (with retryAfterMs) pushed while messages.create is pending', async () => {
    const queue = new ThrottleQueue();

    // Hand-controlled create promise: resolves only after we push a throttle
    // signal, so the loop is provably parked on the await when the signal lands.
    let resolveCreate!: (v: AsyncIterable<RawMessageStreamEvent>) => void;
    const createGate = new Promise<AsyncIterable<RawMessageStreamEvent>>((res) => {
      resolveCreate = res;
    });
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => createGate) },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];

    const resultPromise = collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        throttleQueue: queue,
      }),
    );

    // Let the loop reach the create await, then simulate the wrapped fetch
    // observing a 429 with a 70s retry-after DURING the backoff.
    await Promise.resolve();
    queue.push({ status: 429, retryAfterMs: 70_000 });
    // Give the race a tick to drain + yield the rate_limit event, then let the
    // create settle with a normal text stream.
    await Promise.resolve();
    resolveCreate(fromArray(makeTextStream('done')));

    const events = await resultPromise;

    const rl = events.find((e) => e.type === 'rate_limit');
    expect(rl).toBeDefined();
    if (rl?.type === 'rate_limit') {
      expect(rl.retryAfterMs).toBe(70_000);
      expect(rl.status).toBe(429);
      expect(rl.attempt).toBe(1);
      expect(rl.sessionId).toBe(ctx.sessionId);
    }
    // The turn still completes normally once the (retried) request streams.
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
    // The rate_limit event precedes turn.completed (it was surfaced live).
    const rlIdx = events.findIndex((e) => e.type === 'rate_limit');
    const doneIdx = events.findIndex((e) => e.type === 'turn.completed');
    expect(rlIdx).toBeGreaterThanOrEqual(0);
    expect(rlIdx).toBeLessThan(doneIdx);
  });

  it('surfaces multiple throttle attempts with incrementing attempt numbers', async () => {
    const queue = new ThrottleQueue();
    let resolveCreate!: (v: AsyncIterable<RawMessageStreamEvent>) => void;
    const createGate = new Promise<AsyncIterable<RawMessageStreamEvent>>((res) => {
      resolveCreate = res;
    });
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => createGate) },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];

    const resultPromise = collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        throttleQueue: queue,
      }),
    );

    await Promise.resolve();
    queue.push({ status: 429, retryAfterMs: 10_000 });
    await Promise.resolve();
    queue.push({ status: 503 }); // no retry-after header this time
    await Promise.resolve();
    resolveCreate(fromArray(makeTextStream('done')));

    const events = await resultPromise;
    const rls = events.filter((e) => e.type === 'rate_limit');
    expect(rls).toHaveLength(2);
    if (rls[0]?.type === 'rate_limit' && rls[1]?.type === 'rate_limit') {
      expect(rls[0].attempt).toBe(1);
      expect(rls[0].retryAfterMs).toBe(10_000);
      expect(rls[1].attempt).toBe(2);
      expect(rls[1].status).toBe(503);
      expect(rls[1].retryAfterMs).toBeUndefined();
    }
  });

  it('is a no-op passthrough when no throttleQueue is wired (no rate_limit events)', async () => {
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => fromArray(makeTextStream('hello'))) },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        // no throttleQueue
      }),
    );

    expect(events.some((e) => e.type === 'rate_limit')).toBe(false);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
  });
});
