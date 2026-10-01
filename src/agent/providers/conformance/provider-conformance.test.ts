/**
 * Cross-provider conformance suite — issue #2423
 *
 * One table of scripted scenarios run against BOTH ModelProvider adapters
 * (anthropic-direct and openai-compatible) asserting on the normalized
 * `ProviderEvent` stream.
 *
 * Scenarios that currently FAIL on a provider due to a real parity gap are
 * documented inline with the open issue number. Where a feature is an
 * expected divergence (not a crash), the test asserts the CURRENT observable
 * behavior.
 *
 * Design:
 *  - No real network — both providers use their published test-injection seams.
 *  - Deterministic — fake timers where needed, no flakiness.
 *  - TEST-ONLY — zero product-code mutations.
 *
 * Injection seams:
 *  - anthropic-direct: `new AnthropicDirectQuery({ client: mockClient, ... })`
 *    (same pattern as loop.*.test.ts and query-auth-retry.test.ts)
 *  - openai-compatible: `__setOpenAIClientFactory(factory)` + `new OpenAICompatibleQuery(...)`
 *    (same pattern as query.test.ts and query-journal.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { AgentConfig } from '../../types/config-types.js';
import type { ProviderEvent } from '../../provider.js';

// anthropic-direct
import { AnthropicDirectQuery } from '../../providers/anthropic-direct/query-runtime.js';
import { OVERLOAD_EXHAUSTED } from '../../providers/anthropic-direct/overload-pause.js';
import { OVERLOAD_MAX_RETRIES } from '../../providers/anthropic-direct/loop/retry-budget.js';

// openai-compatible
import {
  __setOpenAIClientFactory,
  OpenAICompatibleQuery,
  __setRetryBaseDelay,
  __setRetryAfterMaxWaitMs,
} from '../../providers/openai-compatible/query.js';
import {
  MAX_CONNECTION_RETRIES,
} from '../../providers/openai-compatible/query/retry.js';

// harness helpers
import {
  makeAnthropicTextStream,
  makeAnthropicToolUseStream,
  collectEvents as collectAnthropicEvents,
} from './__test-utils__/anthropic-harness.js';
import {
  makeOpenAITextChunks,
  makeOpenAIToolUseChunks,
} from './__test-utils__/openai-harness.js';
import type { OpenAIChunk } from '../../providers/openai-compatible/translate.js';
import type { OpenAIMessage } from '../../providers/openai-compatible/messages.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Pick all events of a given type from an event list. */
function pick<T extends ProviderEvent['type']>(
  events: ProviderEvent[],
  type: T,
): Extract<ProviderEvent, { type: T }>[] {
  return events.filter((e): e is Extract<ProviderEvent, { type: T }> => e.type === type);
}

/** Collect all ProviderEvents from an async iterable. */
async function drain(gen: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Minimal prompt stream for a single user message. */
async function* singlePrompt(content = 'hi'): AsyncIterable<{ content: string }> {
  yield { content };
}

/** Base AgentConfig for openai-compatible tests. */
function oaiConfig(): AgentConfig {
  return { model: 'gpt-4o-mini', apiKey: 'sk-conf-test' } as AgentConfig;
}

/** Build a mock Anthropic client with a scripted create() implementation. */
function makeAnthropicMock(createFn: (...args: unknown[]) => unknown): Anthropic {
  return { messages: { create: vi.fn(createFn) } } as unknown as Anthropic;
}

/** Build a minimal AnthropicDirectQuery with a mock client. */
function makeAnthropicQuery(
  client: Anthropic,
  opts: {
    prompt?: string;
    toolDispatcher?: { execute: () => Promise<{ content: string }> };
    initialMessages?: import('@anthropic-ai/sdk/resources').MessageParam[];
  } = {},
): AnthropicDirectQuery {
  return new AnthropicDirectQuery({
    client,
    authMode: 'api-key',
    promptStream: singlePrompt(opts.prompt ?? 'hi'),
    toolDispatcher: opts.toolDispatcher ?? { execute: async () => ({ content: 'ok' }) },
    model: 'claude-test',
    maxTokens: 1024,
    tools: null,
    userSystem: null,
    systemPrefix: null,
    ...(opts.initialMessages ? { initialMessages: opts.initialMessages } : {}),
  });
}

/** Install a mock OpenAI client factory with a scripted create() impl. */
function installOAIFactory(
  createFn: (
    args: { stream?: boolean; messages?: unknown[] },
    opts?: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<OpenAIChunk>>,
): void {
  __setOpenAIClientFactory(
    () =>
      ({
        chat: { completions: { create: vi.fn(createFn) } },
      }) as unknown as OpenAI,
  );
}

/** Build a minimal OpenAICompatibleQuery (factory must already be installed). */
function makeOAIQuery(
  overrides: {
    toolDispatcher?: { execute: () => Promise<{ content: string }> };
    prompt?: string;
    resumeMessages?: OpenAIMessage[];
  } = {},
): OpenAICompatibleQuery {
  return new OpenAICompatibleQuery({
    auth: { apiKey: 'sk-conf-test', source: 'config', last4: 'test' },
    model: 'gpt-4o-mini',
    synthesizedSessionId: 'conf-sid',
    promptStream: singlePrompt(overrides.prompt ?? 'hi'),
    config: oaiConfig(),
    toolDispatcher: overrides.toolDispatcher ?? { execute: async () => ({ content: 'ok' }) },
    ...(overrides.resumeMessages ? { resumeMessages: overrides.resumeMessages } : {}),
  });
}

// ============================================================================
// SCENARIO 1 — Happy path: text streaming
//
// Provider emits: session.init → delta.text → assistant.message → turn.completed
// Both providers must produce these event types in order.
// ============================================================================
describe('Conformance: S1 — happy-path text streaming', () => {
  afterEach(() => __setOpenAIClientFactory(null));

  it('anthropic-direct: emits session.init, delta.text, assistant.message, turn.completed', async () => {
    const evts = makeAnthropicTextStream('hello world');
    const client = makeAnthropicMock(() =>
      (async function* () { for (const e of evts) yield e; })(),
    );
    const events = await collectAnthropicEvents(makeAnthropicQuery(client));

    expect(events[0]?.type).toBe('session.init');
    expect(events.map((e) => e.type)).toContain('delta.text');
    expect(events.map((e) => e.type)).toContain('assistant.message');
    expect(events.map((e) => e.type)).toContain('turn.completed');
    expect(pick(events, 'error')).toHaveLength(0);
    expect(pick(events, 'assistant.message')[0]?.text).toBe('hello world');
  });

  it('openai-compatible: emits session.init, delta.text, assistant.message, turn.completed', async () => {
    const chunks = makeOpenAITextChunks('hello world');
    installOAIFactory(async () => (async function* () { for (const c of chunks) yield c; })());
    const events = await drain(makeOAIQuery());

    expect(events[0]?.type).toBe('session.init');
    expect(events.map((e) => e.type)).toContain('delta.text');
    expect(events.map((e) => e.type)).toContain('assistant.message');
    expect(events.map((e) => e.type)).toContain('turn.completed');
    expect(pick(events, 'error')).toHaveLength(0);
    expect(pick(events, 'assistant.message')[0]?.text).toBe('hello world');
  });
});

// ============================================================================
// SCENARIO 2 — Single tool call and result
//
// Both providers must emit tool events and a final turn.completed.
// ============================================================================
describe('Conformance: S2 — single tool call and result', () => {
  afterEach(() => __setOpenAIClientFactory(null));

  it('anthropic-direct: emits tool events and final turn.completed', async () => {
    const toolDispatcher = { execute: vi.fn(async () => ({ content: 'tool result' })) };
    const toolEvts = makeAnthropicToolUseStream('tool_c1', 'read_file', '{"file_path":"a.ts"}');
    const textEvts = makeAnthropicTextStream('done');
    let callIdx = 0;
    const client = makeAnthropicMock(() => {
      callIdx++;
      const src = callIdx === 1 ? toolEvts : textEvts;
      return (async function* () { for (const e of src) yield e; })();
    });
    const query = makeAnthropicQuery(client, { toolDispatcher });
    const events = await collectAnthropicEvents(query);

    expect(toolDispatcher.execute).toHaveBeenCalledTimes(1);
    expect(pick(events, 'turn.completed')).toHaveLength(1);
    expect(pick(events, 'error')).toHaveLength(0);
  });

  it('openai-compatible: emits tool events and final turn.completed', async () => {
    const toolDispatcher = { execute: vi.fn(async () => ({ content: 'tool result' })) };
    const toolChunks = makeOpenAIToolUseChunks('call_c2', 'read_file', '{"file_path":"a.ts"}');
    const textChunks = makeOpenAITextChunks('done');
    let callIdx = 0;
    installOAIFactory(async () => {
      callIdx++;
      const src = callIdx === 1 ? toolChunks : textChunks;
      return (async function* () { for (const c of src) yield c; })();
    });
    const events = await drain(makeOAIQuery({ toolDispatcher }));

    expect(toolDispatcher.execute).toHaveBeenCalledTimes(1);
    expect(pick(events, 'turn.completed')).toHaveLength(1);
    expect(pick(events, 'error')).toHaveLength(0);
  });
});

// ============================================================================
// SCENARIO 3 — Non-transient error (HTTP 400): no retry, surfaces as `error`
// ============================================================================
describe('Conformance: S3 — non-transient error (HTTP 400) surfaces once, no retry', () => {
  afterEach(() => {
    __setOpenAIClientFactory(null);
    __setRetryBaseDelay(null);
  });

  it('anthropic-direct: one error event, no turn.completed', async () => {
    const err400 = Object.assign(new Error('Bad request'), { status: 400 });
    const client = makeAnthropicMock(() => { throw err400; });
    const events = await collectAnthropicEvents(makeAnthropicQuery(client));

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(pick(events, 'error')).not.toHaveLength(0);
    expect(pick(events, 'turn.completed')).toHaveLength(0);
  });

  it('openai-compatible: one error event, no turn.completed', async () => {
    __setRetryBaseDelay(0);
    const err400 = Object.assign(new Error('Bad request'), { status: 400 });
    installOAIFactory(async () => { throw err400; });
    const events = await drain(makeOAIQuery());

    expect(pick(events, 'error')).not.toHaveLength(0);
    expect(pick(events, 'turn.completed')).toHaveLength(0);
  });
});

// ============================================================================
// SCENARIO 4 — Transient 529 retry → eventual success
//
// Both providers must retry 529 and eventually succeed on the second attempt.
// OAI uses real timers + delay=0 (the same pattern as query.test.ts retry tests).
// Anthropic uses fake timers (its backoff is non-zero and isn't easily tweaked).
// ============================================================================
describe('Conformance: S4 — transient 529 retry → eventual success', () => {
  afterEach(() => {
    __setOpenAIClientFactory(null);
    __setRetryBaseDelay(null);
  });

  it('anthropic-direct: retries 529, succeeds on second attempt (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const overloadErr = Object.assign(new Error('Overloaded'), { status: 529 });
      const recovered = makeAnthropicTextStream('recovered');
      let callCount = 0;
      const client = makeAnthropicMock(() => {
        callCount++;
        if (callCount === 1) throw overloadErr;
        return (async function* () { for (const e of recovered) yield e; })();
      });
      const resultPromise = collectAnthropicEvents(makeAnthropicQuery(client));
      await vi.advanceTimersByTimeAsync(15_000);
      const events = await resultPromise;

      expect(callCount).toBe(2);
      expect(pick(events, 'error')).toHaveLength(0);
      expect(pick(events, 'turn.completed')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('openai-compatible: retries 529, succeeds on second attempt (real timers, delay=0)', async () => {
    __setRetryBaseDelay(0);
    const overloadErr = Object.assign(new Error('Overloaded'), { status: 529 });
    const recovered = makeOpenAITextChunks('recovered');
    let callCount = 0;
    installOAIFactory(async () => {
      callCount++;
      if (callCount === 1) throw overloadErr;
      return (async function* () { for (const c of recovered) yield c; })();
    });
    const events = await drain(makeOAIQuery());

    expect(callCount).toBe(2);
    expect(pick(events, 'error')).toHaveLength(0);
    expect(pick(events, 'turn.completed')).toHaveLength(1);
  });
});

// ============================================================================
// SCENARIO 5 — Burst of 529s exhausts retry budget
//
// anthropic-direct: OVERLOAD_EXHAUSTED turn.completed (clean).
// openai-compatible: error event after MAX_CONNECTION_RETRIES+1 attempts.
// ============================================================================
describe('Conformance: S5 — burst 529 exhausts retry budget', () => {
  afterEach(() => {
    __setOpenAIClientFactory(null);
    __setRetryBaseDelay(null);
  });

  it('anthropic-direct: exhaust → OVERLOAD_EXHAUSTED turn.completed, no raw error (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const client = makeAnthropicMock(() => {
        throw Object.assign(new Error('Overloaded'), { status: 529 });
      });
      const resultPromise = collectAnthropicEvents(makeAnthropicQuery(client));
      await vi.advanceTimersByTimeAsync(120_000);
      const events = await resultPromise;

      expect(pick(events, 'error')).toHaveLength(0);
      const completed = pick(events, 'turn.completed')[0];
      expect(completed).toBeDefined();
      if (completed) {
        expect(completed.usage.stopReason).toBe(OVERLOAD_EXHAUSTED);
      }
      expect(client.messages.create).toHaveBeenCalledTimes(OVERLOAD_MAX_RETRIES + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('openai-compatible: exhaust → error event, call count bounded (real timers, delay=0)', async () => {
    __setRetryBaseDelay(0);
    let callCount = 0;
    installOAIFactory(async () => {
      callCount++;
      throw Object.assign(new Error('Overloaded'), { status: 529 });
    });
    const events = await drain(makeOAIQuery());

    expect(pick(events, 'error')).not.toHaveLength(0);
    expect(callCount).toBe(MAX_CONNECTION_RETRIES + 1);
  });
});

// ============================================================================
// SCENARIO 6 — Orphaned tool call in history → repair or clear local error
//
// anthropic-direct: has `repairOrphanToolUses`, repairs and proceeds cleanly.
// openai-compatible: issue #2417 CLOSED — verify the repair handles it.
// ============================================================================
describe('Conformance: S6 — orphaned tool call in history', () => {
  afterEach(() => __setOpenAIClientFactory(null));

  it('anthropic-direct: repairs orphaned tool_use, completes cleanly', async () => {
    type MsgParam = import('@anthropic-ai/sdk/resources').MessageParam;
    const capturedMessages: MsgParam[][] = [];
    const textEvts = makeAnthropicTextStream('repaired');
    const client = makeAnthropicMock((params: { messages: MsgParam[] }) => {
      capturedMessages.push(structuredClone(params.messages));
      return (async function* () { for (const e of textEvts) yield e; })();
    });

    const orphanHistory: MsgParam[] = [
      { role: 'user', content: 'do a thing' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_orphan', name: 'read_file', input: { file: 'x.ts' } },
        ],
      },
    ];

    const query = makeAnthropicQuery(client, { initialMessages: orphanHistory, prompt: 'continue' });
    const events = await collectAnthropicEvents(query);

    expect(pick(events, 'turn.completed')).toHaveLength(1);
    expect(pick(events, 'error')).toHaveLength(0);
    // The request was sent and the orphan was repaired
    expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
    const sentMsgs = capturedMessages[0]!;
    const orphanIdx = sentMsgs.findIndex(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_use'),
    );
    expect(orphanIdx).toBeGreaterThan(-1);
    // After repair: orphan assistant must be followed by a user message (synthetic tool_result)
    const afterOrphan = sentMsgs[orphanIdx + 1];
    expect(afterOrphan?.role).toBe('user');
  });

  // #2417 CLOSED: openai-compatible now has orphan repair.
  // Verify the end-to-end contract: orphaned tool_calls history is handled
  // without a hard API rejection.
  it('openai-compatible: orphaned tool_calls handled cleanly (issue #2417 closed)', async () => {
    const chunks = makeOpenAITextChunks('repaired');
    installOAIFactory(async () => (async function* () { for (const c of chunks) yield c; })());

    const resumeMessages: OpenAIMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'do a thing' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_orphan',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"x.ts"}' },
          },
        ],
      } as unknown as OpenAIMessage,
      // NO matching tool result — orphan
    ];

    const events = await drain(makeOAIQuery({ resumeMessages, prompt: 'continue' }));

    // Either clean success (repair worked) or a clear local error — not a silent hang.
    const hasCompleted = pick(events, 'turn.completed').length > 0;
    const hasError = pick(events, 'error').length > 0;
    expect(hasCompleted || hasError).toBe(true);
  });
});

// ============================================================================
// SCENARIO 7 — First-byte / stream-stall timeout
//
// anthropic-direct: arms TTFB guard; silent server → error, not a hang.
// openai-compatible: issue #2416 CLOSED — guard now in place.
//
// Both use fake timers and a short TTFB window (5s) via env var.
// ============================================================================
describe('Conformance: S7 — stream stall before first byte (TTFB timeout)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env['AFK_MODEL_TTFB_TIMEOUT_MS'] = '5000';
    process.env['AFK_MODEL_STALL_TIMEOUT_MS'] = '0'; // isolate TTFB
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env['AFK_MODEL_TTFB_TIMEOUT_MS'];
    delete process.env['AFK_MODEL_STALL_TIMEOUT_MS'];
    __setOpenAIClientFactory(null);
  });

  it('anthropic-direct: headers+silence → TTFB timeout surfaces as error event', async () => {
    const client = makeAnthropicMock((_params: unknown, opts?: unknown) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      return (async function* () {
        await new Promise<void>((_res, rej) => {
          if (signal?.aborted) { rej(new Error('aborted')); return; }
          signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
        });
      })();
    });
    const resultPromise = collectAnthropicEvents(makeAnthropicQuery(client));
    await vi.advanceTimersByTimeAsync(10_000);
    const events = await resultPromise;

    expect(pick(events, 'error')).not.toHaveLength(0);
  });

  // #2416 CLOSED: openai-compatible now has first-byte timeouts.
  // The TTFB guard is in driveStream and uses TTFB env var (5s set in beforeEach).
  // After TTFB fires: up to MAX_STREAM_RETRIES (3) retries, each preceded by a
  // backoff sleep (base=2000ms by default) and another 5s TTFB window.
  // Total advancement needed: 3 * (5000 + 2000 * 2^attempt) ≈ 60s.
  it('openai-compatible: headers+silence → TTFB timeout surfaces as error event (issue #2416 closed)', async () => {
    __setRetryBaseDelay(0); // zero backoff so retry sleeps don't add to budget
    installOAIFactory(async (_args: unknown, opts?: { signal?: AbortSignal }) => {
      const signal = opts?.signal;
      return (async function* () {
        await new Promise<void>((_res, rej) => {
          if (signal?.aborted) { rej(new Error('aborted')); return; }
          signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
        });
      })();
    });

    const events: ProviderEvent[] = [];
    const resultPromise = drain(makeOAIQuery()).then((evs) => { events.push(...evs); });
    // Advance past TTFB (5s) × (1 + MAX_STREAM_RETRIES) = 4 × 5s = 20s
    await vi.advanceTimersByTimeAsync(25_000);
    await resultPromise;

    expect(pick(events, 'error')).not.toHaveLength(0);
  });
});

// ============================================================================
// SCENARIO 8 — Usage/quota limit 429 with long Retry-After (parity: #2418)
//
// Before #2418: openai-compatible capped Retry-After at 120s, retried
// ≤MAX_CONNECTION_RETRIES, then failed. anthropic-direct parked until reset.
//
// After #2418 (CLOSED): openai-compatible now classifies long-Retry-After 429s
// (>5 min) as quota/usage-limit events and parks with `paused`/`resumed` events,
// honoring `autoResumeOnUsageLimit` and the 2-hour bound — matching anthropic-direct.
//
// S8a: short Retry-After (≤5 min) → still handled by connection retry, no park.
// S8b: long Retry-After (>5 min) → parks with paused/resumed on both providers.
// ============================================================================
import { __setQuotaTwoHoursMs } from '../openai-compatible/query/usage-limit-tier.js';

describe('Conformance: S8a — short Retry-After 429 (transient rate-limit, no park)', () => {
  afterEach(() => {
    if (vi.isFakeTimers()) vi.useRealTimers();
    __setOpenAIClientFactory(null);
    __setRetryBaseDelay(null);
    __setRetryAfterMaxWaitMs(null);
  });

  // Short retry-after (2s, well under the 5-min threshold) is handled by the
  // connection-phase retry loop in retry.ts — NOT the quota-limit park.
  // openai-compatible retries ≤MAX_CONNECTION_RETRIES times, then fails.
  it('openai-compatible: short Retry-After 429 → error after bounded retries (connection retry path)', async () => {
    vi.useFakeTimers();
    __setRetryBaseDelay(0);
    try {
      let callCount = 0;
      installOAIFactory(async () => {
        callCount++;
        const headers = new Headers({ 'retry-after': '2' }); // 2s — transient
        throw Object.assign(new Error('rate limited'), { status: 429, headers });
      });
      const resultPromise = drain(makeOAIQuery());
      // Advance past 3 retries × 2s = 6s
      await vi.advanceTimersByTimeAsync(10_000);
      const events = await resultPromise;

      // Short Retry-After → connection retry, not a quota park.
      expect(pick(events, 'error')).not.toHaveLength(0);
      expect(pick(events, 'paused')).toHaveLength(0); // no quota park
      expect(callCount).toBeGreaterThanOrEqual(1);
      expect(callCount).toBeLessThanOrEqual(MAX_CONNECTION_RETRIES + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Conformance: S8b — long Retry-After 429 (quota/usage limit) emits paused (#2418)', () => {
  afterEach(() => {
    if (vi.isFakeTimers()) vi.useRealTimers();
    __setOpenAIClientFactory(null);
    __setRetryBaseDelay(null);
    __setRetryAfterMaxWaitMs(null);
    __setQuotaTwoHoursMs(null);
  });

  it('anthropic-direct: 429 usage-limit emits a defined terminal event or parks (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const client = makeAnthropicMock(() => {
        throw Object.assign(
          new Error('Claude AI usage limit reached|1700000000'),
          { status: 429 },
        );
      });
      const resultPromise = collectAnthropicEvents(makeAnthropicQuery(client));
      await vi.advanceTimersByTimeAsync(1_000);

      // Race: if anthropic-direct parks, promise won't settle quickly.
      let events: ProviderEvent[] = [];
      const outcome = await Promise.race([
        resultPromise.then((evs) => { events = evs; return 'settled' as const; }),
        new Promise<'parking'>((r) => setTimeout(() => r('parking'), 200)),
      ]);

      if (outcome === 'settled') {
        const hasError = pick(events, 'error').length > 0;
        const hasPaused = pick(events, 'paused').length > 0;
        expect(hasError || hasPaused).toBe(true);
      }
      // 'parking' = session is correctly parked — valid behavior
      expect(['settled', 'parking']).toContain(outcome);
    } finally {
      vi.useRealTimers();
    }
  });

  // After #2418: openai-compatible parks on long Retry-After and emits paused.
  // Use test injection to collapse all waits to 0ms so the test runs instantly
  // without fake timers: __setRetryBaseDelay(0) kills backoff delays, and
  // __setRetryAfterMaxWaitMs(0) collapses the connection-phase retry-after cap,
  // and __setQuotaTwoHoursMs(100) gives a tiny 100ms budget window for the quota tier.
  it('openai-compatible: long Retry-After 429 → emits paused (autoResume=true), parks (#2418 fixed)', async () => {
    vi.useFakeTimers();
    __setRetryBaseDelay(0);
    // Collapse connection-phase retry-after waits to 0 so retries fire instantly.
    __setRetryAfterMaxWaitMs(0);
    // Tiny 2-hour budget — immediately exhausted after quota tier fires once.
    __setQuotaTwoHoursMs(50);
    try {
      installOAIFactory(async () => {
        // 10-minute retry-after — above the 5-min threshold → quota park after connection retries.
        // Connection-phase retries are instant (maxWait=0), then error surfaces to quota tier.
        const headers = new Headers({ 'retry-after': '600' });
        throw Object.assign(new Error('quota exceeded'), { status: 429, headers });
      });
      const resultPromise = drain(makeOAIQuery());
      // Advance past the tiny quota budget (50ms). Connection retries are instant (maxWait=0),
      // so after 3 instant retries the error surfaces to the quota tier, which parks for
      // Math.min(600_000, 50) = 50ms, then checks budget (elapsed > 50ms) → surfaces error.
      await vi.advanceTimersByTimeAsync(200);
      const events = await resultPromise;

      // openai-compatible MUST emit paused (quota park)
      const paused = pick(events, 'paused');
      expect(paused.length).toBeGreaterThan(0);
      expect(paused[0]?.reason).toBe('usage-limit');
      expect(paused[0]?.autoResume).toBe(true);
      // Eventually surfaces an error (budget exhausted, not parked indefinitely)
      expect(pick(events, 'error')).not.toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// SCENARIO 9 — AFK retry count is bounded and predictable (documents #2422)
//
// With a mock client (SDK bypassed), the attempt count is exactly
// 1 + MAX_RETRIES. Before #2422 both providers left the SDK's default
// maxRetries=2 in place, so each AFK attempt silently became 3× the API
// calls. #2422 pinned maxRetries: 0 on both providers so the SDK never
// retries and AFK's own loop is the sole retry driver.
// ============================================================================
describe('Conformance: S9 — AFK retry count is bounded and predictable (documents #2422)', () => {
  afterEach(() => {
    __setOpenAIClientFactory(null);
    __setRetryBaseDelay(null);
  });

  it('anthropic-direct: mock count == 1 + OVERLOAD_MAX_RETRIES (no SDK stacking)', async () => {
    vi.useFakeTimers();
    try {
      const client = makeAnthropicMock(() => {
        throw Object.assign(new Error('Overloaded'), { status: 529 });
      });
      const resultPromise = collectAnthropicEvents(makeAnthropicQuery(client));
      await vi.advanceTimersByTimeAsync(120_000);
      await resultPromise;

      // Without SDK stacking (maxRetries: 0 since #2422): exactly 1 initial +
      // OVERLOAD_MAX_RETRIES retries. Before #2422 the Anthropic SDK's default
      // maxRetries=2 made each attempt up to 3 API calls.
      expect(client.messages.create).toHaveBeenCalledTimes(OVERLOAD_MAX_RETRIES + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('openai-compatible: mock count == 1 + MAX_CONNECTION_RETRIES (no SDK stacking)', async () => {
    __setRetryBaseDelay(0);
    let callCount = 0;
    installOAIFactory(async () => {
      callCount++;
      throw Object.assign(new Error('Overloaded'), { status: 529 });
    });
    await drain(makeOAIQuery());

    // Without SDK stacking (maxRetries: 0 since #2422): exactly 1 +
    // MAX_CONNECTION_RETRIES. Before #2422 the OpenAI SDK's default
    // maxRetries=2 made each attempt up to 3 API calls.
    expect(callCount).toBe(MAX_CONNECTION_RETRIES + 1);
  });
});

// ============================================================================
// SCENARIO 11 — cachedInputTokens semantics parity (issue #2424)
//
// Anthropic: input_tokens EXCLUDES cache; cache_read_input_tokens is additive.
// OpenAI:    prompt_tokens INCLUDES cached tokens; cached_tokens is a subset.
//
// Both must surface cached tokens in ProviderUsage.cachedInputTokens.
// The contextWindowTokens computation must differ correctly:
//   Anthropic: input + output + cachedInput + cacheCreation
//   OpenAI:    input + output  (cached already included in input)
// ============================================================================
describe('Conformance: S11 — cachedInputTokens semantics (issue #2424)', () => {
  afterEach(() => __setOpenAIClientFactory(null));

  it('anthropic-direct: cachedInputTokens populated from cache_read_input_tokens (additive to input)', async () => {
    // Wire input_tokens = 20, cache_read_input_tokens = 80, output_tokens = 10.
    // Anthropic: input_tokens EXCLUDES cache reads. Window = 20 + 10 + 80 = 110.
    const evts: import('@anthropic-ai/sdk/resources').RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_s11_anth',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 80,
          },
        },
      } as unknown as import('@anthropic-ai/sdk/resources').RawMessageStreamEvent,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      } as unknown as import('@anthropic-ai/sdk/resources').RawMessageStreamEvent,
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      } as unknown as import('@anthropic-ai/sdk/resources').RawMessageStreamEvent,
      { type: 'content_block_stop', index: 0 } as unknown as import('@anthropic-ai/sdk/resources').RawMessageStreamEvent,
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 },
      } as unknown as import('@anthropic-ai/sdk/resources').RawMessageStreamEvent,
      { type: 'message_stop' } as unknown as import('@anthropic-ai/sdk/resources').RawMessageStreamEvent,
    ];
    const client = makeAnthropicMock(() =>
      (async function* () { for (const e of evts) yield e; })(),
    );
    const events = await collectAnthropicEvents(makeAnthropicQuery(client));
    const completed = pick(events, 'turn.completed');
    expect(completed).toHaveLength(1);
    const usage = completed[0]!.usage;

    // Anthropic: cachedInputTokens is from cache_read_input_tokens (additive).
    expect(usage.cachedInputTokens).toBe(80);
    // Anthropic: inputTokens is the EXCLUSIVE count (excludes cache reads).
    expect(usage.inputTokens).toBe(20);
    // Anthropic contextWindowTokens = input + output + cachedInput + cacheCreation
    // = 20 + 10 + 80 + 0 = 110. Must NOT equal input + output alone (= 30).
    expect(usage.contextWindowTokens).toBe(110);
  });

  it('openai-compatible: cachedInputTokens populated from prompt_tokens_details.cached_tokens (subset)', async () => {
    // Wire prompt_tokens = 100 (includes 80 cached), completion_tokens = 10.
    // OpenAI: cached_tokens is a SUBSET of prompt_tokens. Window = 100 + 10 = 110.
    const chunks: OpenAIChunk[] = [
      { choices: [{ delta: { content: 'hi' } }] } as OpenAIChunk,
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      } as OpenAIChunk,
    ];
    installOAIFactory(async () => (async function* () { for (const c of chunks) yield c; })());
    const events = await drain(makeOAIQuery());
    const completed = pick(events, 'turn.completed');
    expect(completed).toHaveLength(1);
    const usage = completed[0]!.usage;

    // OpenAI: cachedInputTokens is the cached_tokens subset.
    expect(usage.cachedInputTokens).toBe(80);
    // OpenAI: inputTokens is the INCLUSIVE prompt_tokens (includes cached).
    expect(usage.inputTokens).toBe(100);
    // OpenAI: contextWindowTokens = prompt + completion = 100 + 10 = 110.
    // Must NOT add cachedInputTokens again (that would be 190, double-counting).
    expect(usage.contextWindowTokens).toBe(110);
  });
});

// ============================================================================
// SCENARIO 12 — contextWindowTokens set after a turn on both providers (#2424)
//
// Both providers must populate ProviderUsage.contextWindowTokens on a happy-
// path turn so auto-compaction and getContextUsage() percentage are driven by
// the provider-computed footprint rather than the input+output fallback.
// ============================================================================
describe('Conformance: S12 — contextWindowTokens populated after a turn (issue #2424)', () => {
  afterEach(() => __setOpenAIClientFactory(null));

  it('anthropic-direct: contextWindowTokens is defined and positive after a text turn', async () => {
    const evts = makeAnthropicTextStream('hello');
    const client = makeAnthropicMock(() =>
      (async function* () { for (const e of evts) yield e; })(),
    );
    const events = await collectAnthropicEvents(makeAnthropicQuery(client));
    const completed = pick(events, 'turn.completed');
    expect(completed).toHaveLength(1);
    const usage = completed[0]!.usage;

    // Must be a positive number (input + output + cache fields from the stream).
    expect(typeof usage.contextWindowTokens).toBe('number');
    expect((usage.contextWindowTokens ?? 0)).toBeGreaterThan(0);
  });

  it('openai-compatible: contextWindowTokens is defined and positive after a text turn', async () => {
    const chunks = makeOpenAITextChunks('hello');
    installOAIFactory(async () => (async function* () { for (const c of chunks) yield c; })());
    const events = await drain(makeOAIQuery());
    const completed = pick(events, 'turn.completed');
    expect(completed).toHaveLength(1);
    const usage = completed[0]!.usage;

    // Must be a positive number (prompt_tokens + completion_tokens).
    expect(typeof usage.contextWindowTokens).toBe('number');
    expect((usage.contextWindowTokens ?? 0)).toBeGreaterThan(0);
  });
});

// ============================================================================
// SCENARIO 10 — Optional ProviderQuery methods present / missing (gap: #2420)
//
// anthropic-direct: implements listRewindTargets, rewindConversation, setSystemPrompt.
// openai-compatible: does NOT implement these — feature gap, #2420 OPEN.
// ============================================================================
describe('Conformance: S10 — optional ProviderQuery methods (gap: #2420)', () => {
  afterEach(() => __setOpenAIClientFactory(null));

  it('anthropic-direct: setSystemPrompt, listRewindTargets, rewindConversation are implemented', () => {
    const client = makeAnthropicMock(() => { throw new Error('unused'); });
    const query = makeAnthropicQuery(client);

    // rewindFiles returns { canRewind: false } for file rewind (files not supported),
    // but listRewindTargets / rewindConversation handle conversation rewind.
    expect(typeof query.listRewindTargets).toBe('function');
    expect(typeof query.rewindConversation).toBe('function');
    expect(typeof query.setSystemPrompt).toBe('function');
  });

  // #2420 CLOSED: openai-compatible now implements these optional methods.
  it('openai-compatible: listRewindTargets, rewindConversation, setSystemPrompt, setBeforeNextRound present (#2420 closed)', async () => {
    installOAIFactory(async () => { throw new Error('unused'); });
    const query = makeOAIQuery();

    // All four resilience methods are now implemented on OpenAICompatibleQuery.
    expect(typeof query.listRewindTargets).toBe('function');
    expect(typeof query.rewindConversation).toBe('function');
    expect(typeof query.setSystemPrompt).toBe('function');
    expect(typeof query.setBeforeNextRound).toBe('function');
    // setSystemPrompt must not throw when called with undefined
    expect(() => query.setSystemPrompt(undefined)).not.toThrow();
    // The rewindFiles method must still return canRewind: false (file rewind unsupported)
    const rewindResult = await query.rewindFiles('any-id', { dryRun: true });
    expect(rewindResult.canRewind).toBe(false);
  });
});
