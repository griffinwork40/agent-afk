/**
 * Regression tests: turn-scoped budgets must survive a retry-tier replay.
 *
 * Invariant: the retry tiers (overload pause → usage limit → auth) recover by
 * calling `runTurn(runInput)` AGAIN for the same user turn. Every turn-scoped
 * budget — the soft wall-clock deadline, the tool-round cap — and the turn's
 * usage tally must be measured from the ORIGINAL turn, not from the replay.
 *
 * History: 2026-09-28, two compose children (claude-opus-5-5, 45-min hard
 * budget, 40-min soft deadline) never wound down. Their witness traces show a
 * silent `loop_end` → `loop_start` ~33 min in (an OAuth 401 → refresh → replay;
 * the auth tier emits no trace event). The replay built a fresh
 * `TurnAccumulator`, so the soft-deadline clock restarted at ~33 min and would
 * have fired at ~73 min — after the 45-min hard abort. One child ran to 44.7
 * min; the other was hard-killed with no final answer. The same reset also
 * restarted the round cap and dropped the pre-replay rounds' usage from the
 * turn's `turn.completed` (so closure tokens/cost undercounted).
 *
 * These tests drive the REAL provider query path (driver → retry tiers →
 * runTurn) with a mocked SDK. The "slow model" is simulated with a Date-only
 * fake clock advanced inside the tool / request — nothing sleeps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ProviderEvent } from '../../provider.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import { tool } from '../../tools/custom-tool.js';
import { fromArray, makeTextStream, makeToolUseStream } from './loop.test-helpers.js';
import { SOFT_DEADLINE_WIND_DOWN } from '../shared/soft-deadline.js';
import { OVERLOAD_EXHAUSTED } from './overload-pause.js';

vi.mock('../../awareness/workspace-source.js', () => ({
  gatherWorkspace: vi.fn(() => ({ branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null })),
}));

const createMock = vi.fn();
class MockAnthropic {
  messages = { create: createMock };
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}
async function drain(q: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of q) out.push(ev);
  return out;
}
function make401(): Error {
  const e = new Error('Unauthorized');
  (e as unknown as { status: number }).status = 401;
  return e;
}
function injectRefresher(query: unknown): ReturnType<typeof vi.fn> {
  const refresher = vi.fn(async () => new MockAnthropic() as unknown as Anthropic);
  (query as { retry: { tokenRefresher?: () => Promise<Anthropic | null> } }).retry.tokenRefresher = refresher;
  return refresher;
}
function completedOf(events: ProviderEvent[]): Extract<ProviderEvent, { type: 'turn.completed' }> {
  const c = events.filter((e) => e.type === 'turn.completed');
  expect(c).toHaveLength(1);
  return c[0] as Extract<ProviderEvent, { type: 'turn.completed' }>;
}

const OAUTH_CONFIG = { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' } as const;

describe('anthropic-direct: turn budgets survive a retry-tier replay', () => {
  let advanceInTool = 0;
  const slowTool = tool('slow_probe', 'a slow tool', z.object({}), async () => {
    // Simulated slow work: moves the wall clock without sleeping.
    vi.setSystemTime(Date.now() + advanceInTool);
    return { content: 'probe ok' };
  });

  beforeEach(() => {
    createMock.mockReset();
    advanceInTool = 0;
    // Fake ONLY Date: the loop's real setTimeout-based watchdogs keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
  });
  afterEach(() => {
    __setAnthropicClientFactory(null);
    vi.useRealTimers();
  });

  it('soft deadline is measured from the ORIGINAL turn start after an OAuth 401 replay', async () => {
    // 60s soft deadline. Round 1 burns 40s; round 2's request gets a 401 and the
    // auth tier replays the turn; the replayed round burns another 30s. The turn
    // is now 70s old — past the deadline — but only 30s past the replay.
    advanceInTool = 40_000;
    const tools: unknown[] = [];
    let call = 0;
    createMock.mockImplementation((params: { tools?: unknown }) => {
      call += 1;
      tools.push(params.tools);
      if (call === 1) return fromArray(makeToolUseStream('toolu_1', 'slow_probe', '{}'));
      if (call === 2) { advanceInTool = 30_000; throw make401(); }
      if (call === 3) return fromArray(makeToolUseStream('toolu_3', 'slow_probe', '{}'));
      return fromArray(makeTextStream('Summary of what I established.'));
    });

    const provider = new AnthropicDirectProvider({ customTools: [slowTool] });
    const query = provider.query({ prompt: singleInput('go'), config: { ...OAUTH_CONFIG, softDeadlineMs: 60_000 } });
    const refresher = injectRefresher(query);
    const events = await drain(query);

    expect(refresher).toHaveBeenCalledOnce();
    expect(call).toBe(4);
    // The 4th request is the wind-down: tools stripped.
    expect(tools[3]).toBeUndefined();
    expect(completedOf(events).usage.stopReason).toBe(SOFT_DEADLINE_WIND_DOWN);
  });

  it('tool-round cap counts rounds from before the replay', async () => {
    // Cap = 2 rounds. One round before the 401, one after: the cap is spent, so
    // the next request must be the tools-stripped wind-down.
    const tools: unknown[] = [];
    let call = 0;
    createMock.mockImplementation((params: { tools?: unknown }) => {
      call += 1;
      tools.push(params.tools);
      if (call === 1) return fromArray(makeToolUseStream('toolu_1', 'slow_probe', '{}'));
      if (call === 2) throw make401();
      if (call === 3) return fromArray(makeToolUseStream('toolu_3', 'slow_probe', '{}'));
      return fromArray(makeTextStream('wrapped up'));
    });

    const provider = new AnthropicDirectProvider({ customTools: [slowTool] });
    const query = provider.query({ prompt: singleInput('go'), config: { ...OAUTH_CONFIG, maxToolUseIterations: 2 } });
    injectRefresher(query);
    const events = await drain(query);

    expect(call).toBe(4);
    expect(tools[3]).toBeUndefined();
    expect(completedOf(events).usage.stopReason).toBe('tool_use_loop_capped');
  });

  it("turn usage includes the pre-replay rounds (no silent undercount)", async () => {
    // Per helper: tool_use stream = 10 in / 9 out; text stream = 10 in / 5 out.
    let call = 0;
    createMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return fromArray(makeToolUseStream('toolu_1', 'slow_probe', '{}'));
      if (call === 2) throw make401();
      if (call === 3) return fromArray(makeToolUseStream('toolu_3', 'slow_probe', '{}'));
      return fromArray(makeTextStream('done'));
    });

    const provider = new AnthropicDirectProvider({ customTools: [slowTool] });
    const query = provider.query({ prompt: singleInput('go'), config: { ...OAUTH_CONFIG } });
    injectRefresher(query);
    const usage = completedOf(await drain(query)).usage;

    // Three billed responses (the 401 produced none): 9 + 9 + 5 out, 10 × 3 in.
    expect(usage.outputTokens).toBe(23);
    expect(usage.inputTokens).toBe(30);
  });

  it('a model request still waiting when the soft deadline arrives winds down at the next boundary', async () => {
    // Round 1's tool takes 10s. Round 2's REQUEST is slow: the model is still
    // "thinking" (no first byte) when the 60s deadline passes — simulated by
    // advancing the clock inside messages.create. The in-flight round is not
    // cut off; its tools run; the very next boundary arms the wind-down, and the
    // wind-down request is sent with tools stripped. No extra tool round.
    advanceInTool = 10_000;
    const tools: unknown[] = [];
    let call = 0;
    createMock.mockImplementation((params: { tools?: unknown }) => {
      call += 1;
      tools.push(params.tools);
      if (call === 1) return fromArray(makeToolUseStream('toolu_1', 'slow_probe', '{}'));
      if (call === 2) {
        advanceInTool = 0;
        vi.setSystemTime(Date.now() + 65_000); // request waited past the deadline
        return fromArray(makeToolUseStream('toolu_2', 'slow_probe', '{}'));
      }
      return fromArray(makeTextStream('Here is what I have.'));
    });

    const provider = new AnthropicDirectProvider({ customTools: [slowTool] });
    const events = await drain(
      provider.query({ prompt: singleInput('go'), config: { ...OAUTH_CONFIG, softDeadlineMs: 60_000 } }),
    );

    expect(call).toBe(3);
    expect(tools[1]).toBeDefined(); // the in-flight round was a normal round
    expect(tools[2]).toBeUndefined(); // the next request is the wind-down
    const msg = events.find((e) => e.type === 'assistant.message');
    expect(msg?.type === 'assistant.message' ? msg.text : '').toContain('Here is what I have.');
    expect(completedOf(events).usage.stopReason).toBe(SOFT_DEADLINE_WIND_DOWN);
  });
});

describe('anthropic-direct: turn budgets survive an overload-park replay', () => {
  // This suite uses full fake timers (Date + setTimeout) so the connection-phase
  // backoff sleeps (jitterBackoff) and the overload-park probe sleep
  // (sleepWithAbort inside turnWithOverloadPause) can be advanced without
  // slowing the test. The watchdog timers are also faked; they do not fire
  // because vi.advanceTimersByTimeAsync interleaves microtask processing.
  //
  // Scenario: round 1 burns 40s (soft deadline = 60s). Round 2's request
  // exhausts the 529 connection-phase budget (3 throws), producing an
  // OVERLOAD_EXHAUSTED sentinel. The overload-pause tier parks for a 120s
  // probe interval. The clock is advanced 90s during the park so the total
  // elapsed time is ~130s — well past the 60s soft deadline. When the probe
  // replays the turn, the soft-deadline check at the next round boundary should
  // already be expired and trigger the wind-down, not another tool round.
  const createMock2 = vi.fn();
  class MockAnthropic2 {
    messages = { create: createMock2 };
  }

  const probeTool = tool('overload_probe', 'a probe tool', z.object({}), async () => ({
    content: 'probe ok',
  }));

  function make529(): Error {
    const e = new Error('Overloaded');
    (e as unknown as { status: number }).status = 529;
    return e;
  }

  beforeEach(() => {
    createMock2.mockReset();
    // Full fake timers: Date + setTimeout, so backoff sleeps can be advanced.
    vi.useFakeTimers();
    __setAnthropicClientFactory(() => new MockAnthropic2() as unknown as Anthropic);
    // Pin Math.random so nextProbeDelayMs returns a fixed interval (120s max).
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    // 1-minute ceiling for the overload park (enough for one probe).
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '120000';
  });
  afterEach(() => {
    __setAnthropicClientFactory(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env['AFK_OVERLOAD_PAUSE_MS'];
  });

  it('soft deadline measured from original turn fires even when the park elapses past it', async () => {
    // Round 1 (call 1): returns a tool-use stream and advances Date by 40s.
    // Round 2 (calls 2-4): three 529 throws exhaust the connection-phase budget.
    // Overload-park probe (call 5): returns a tool-use stream (round 2 replay).
    // Wind-down (call 6): tools-stripped text stream.
    const tools: unknown[] = [];
    let call = 0;
    createMock2.mockImplementation(async (params: { tools?: unknown }) => {
      call += 1;
      tools.push(params.tools);
      if (call === 1) {
        // Round 1: slow tool-use round — advance Date so 40s appear to pass.
        vi.setSystemTime(Date.now() + 40_000);
        return fromArray(makeToolUseStream('toolu_1', 'overload_probe', '{}'));
      }
      if (call === 2 || call === 3 || call === 4) {
        // Three consecutive 529s exhaust OVERLOAD_MAX_RETRIES=3.
        throw make529();
      }
      if (call === 5) {
        // First probe after park: returns a tool-use stream. The soft deadline
        // was 60s; now 130s have elapsed (40s pre-overload + 90s park), so
        // the NEXT round boundary should arm the wind-down immediately.
        return fromArray(makeToolUseStream('toolu_5', 'overload_probe', '{}'));
      }
      // Wind-down (call 6): no tools, final answer.
      return fromArray(makeTextStream('Wrapped up after overload.'));
    });

    const provider = new AnthropicDirectProvider({ customTools: [probeTool] });
    const promise = drain(
      provider.query({
        prompt: (async function* () { yield { content: 'go' }; })(),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-test', softDeadlineMs: 60_000 },
      }),
    );

    // Advance through connection-phase backoff sleeps (5s + 10s = 15s) and then
    // the park probe interval (pinned ~120s, clamped to the 120s ceiling).
    // Advancing 90s past the overload puts the total elapsed time at ~130s >
    // 60s soft deadline; the NEXT round boundary after the probe fires wind-down.
    await vi.advanceTimersByTimeAsync(200_000);
    const events = await promise;

    // The overload exhaustion terminal should be swallowed (park recovered).
    expect(events.some((e) => e.type === 'turn.completed' && e.usage.stopReason === OVERLOAD_EXHAUSTED)).toBe(false);
    // The wind-down request (call 6) must have no tools — deadline was expired.
    expect(call).toBe(6);
    expect(tools[5]).toBeUndefined();
    expect(completedOf(events).usage.stopReason).toBe(SOFT_DEADLINE_WIND_DOWN);
  });
});
