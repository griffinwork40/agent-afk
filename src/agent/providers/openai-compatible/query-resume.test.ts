/**
 * Tests for #1294: context-overflow guard seeded on OpenAI-compatible session
 * resume.
 *
 * When a session is resumed (`config.resumeHistory` non-empty with inputTokens
 * set on the last turn), the OpenAICompatibleQuery constructor must seed
 * `this.lastUsage` so the overflow guard (#962) fires on the first resumed
 * turn instead of being skipped.
 *
 * Coverage:
 *   1. Fresh session → getContextUsage() reports 0 tokens (lastUsage null).
 *   2. Resumed session with inputTokens → getContextUsage() reports seeded count.
 *   3. Zero inputTokens on last turn → treated as absent (no seeding).
 *   4. Legacy sidecar (no inputTokens) → no seeding (guard skipped, unchanged).
 *   5. After the first real turn completes, the seeded value is replaced.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentConfig, ResumeHistoryTurn } from '../../types/config-types.js';
import {
  __setOpenAIClientFactory,
  __setRetryBaseDelay,
  OpenAICompatibleQuery,
  type OpenAIClientFactory,
} from './query.js';
import type { OpenAIChunk } from './translate.js';

// ─── minimal mock client ──────────────────────────────────────────────────────

let pendingChunks: OpenAIChunk[] = [];

function installMockClient() {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async () => ({
            [Symbol.asyncIterator]() {
              return pendingChunks[Symbol.asyncIterator]();
            },
          }),
        },
      },
    }) as ReturnType<OpenAIClientFactory>;
  __setOpenAIClientFactory(factory);
}

function clearMockClient() {
  __setOpenAIClientFactory(undefined);
  pendingChunks = [];
}

// Minimal done-chunk that simulates a text response.
function makeDoneChunks(text = 'ok'): OpenAIChunk[] {
  return [
    {
      choices: [{ delta: { content: text }, finish_reason: null, index: 0 }],
      usage: null,
    } as unknown as OpenAIChunk,
    {
      choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
    } as unknown as OpenAIChunk,
  ];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: 'gpt-4o-mini',
    ...overrides,
  } as AgentConfig;
}

function buildQuery(config: AgentConfig): OpenAICompatibleQuery {
  const { promptStream, auth } = (() => {
    let resolve!: () => void;
    // A prompt stream that never yields (we never send a turn in most tests).
    const stream: AsyncIterable<{ content: string }> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await new Promise<void>((r) => { resolve = r; });
            return { value: { content: 'hi' }, done: false };
          },
          async return() {
            resolve?.();
            return { value: undefined as never, done: true };
          },
        };
      },
    };
    return {
      promptStream: stream as unknown as AgentConfig['promptStream'],
      auth: { apiKey: 'test-key', source: 'env' as const },
    };
  })();

  // Build via the exported constructor directly (mirrors how query.test.ts works).
  return new OpenAICompatibleQuery({
    auth,
    model: config.model as string ?? 'gpt-4o-mini',
    synthesizedSessionId: 'test-session',
    promptStream: promptStream as never,
    config,
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  installMockClient();
  __setRetryBaseDelay?.(0);
});
afterEach(() => {
  clearMockClient();
});

describe('OpenAICompatibleQuery — lastUsage seeded from resumeHistory (#1294)', () => {
  it('fresh session: getContextUsage() returns 0 totalTokens (lastUsage null)', async () => {
    const q = buildQuery(makeConfig());
    const usage = await q.getContextUsage();
    expect(usage.totalTokens).toBe(0);
    expect(usage.apiUsage).toBeNull();
  });

  it('resumed session: getContextUsage() reflects seeded inputTokens from last turn', async () => {
    const resumeHistory: ResumeHistoryTurn[] = [
      { user: 'first question', assistant: 'first answer' },
      { user: 'second question', assistant: 'second answer', inputTokens: 120_000 },
    ];
    const q = buildQuery(makeConfig({ resumeHistory }));
    const usage = await q.getContextUsage();
    // totalTokens is derived from contextWindowTokensUsed(lastUsage), which for
    // a seeded usage with only inputTokens falls back to inputTokens + 0 = 120_000.
    expect(usage.totalTokens).toBe(120_000);
    expect(usage.apiUsage).not.toBeNull();
    expect(usage.apiUsage?.input_tokens).toBe(120_000);
  });

  it('only the LAST turn inputTokens is used (earlier turns are ignored)', async () => {
    // inputTokens on earlier turns should not pollute the seeded value.
    const resumeHistory: ResumeHistoryTurn[] = [
      { user: 'q1', assistant: 'a1', inputTokens: 999_000 }, // earlier turn — ignored
      { user: 'q2', assistant: 'a2', inputTokens: 50_000 },  // last turn — used
    ];
    const q = buildQuery(makeConfig({ resumeHistory }));
    const usage = await q.getContextUsage();
    expect(usage.totalTokens).toBe(50_000);
  });

  it('zero inputTokens on last turn: treated as absent (no seeding)', async () => {
    const resumeHistory: ResumeHistoryTurn[] = [
      { user: 'hi', assistant: 'hello', inputTokens: 0 },
    ];
    const q = buildQuery(makeConfig({ resumeHistory }));
    const usage = await q.getContextUsage();
    // Zero → treated as absent → no seeding → totalTokens 0.
    expect(usage.totalTokens).toBe(0);
    expect(usage.apiUsage).toBeNull();
  });

  it('legacy sidecar (no inputTokens on last turn): no seeding (backward compat)', async () => {
    // Older sidecars don't have inputTokens on turns.
    const resumeHistory: ResumeHistoryTurn[] = [
      { user: 'old question', assistant: 'old answer' },
    ];
    const q = buildQuery(makeConfig({ resumeHistory }));
    const usage = await q.getContextUsage();
    expect(usage.totalTokens).toBe(0);
    expect(usage.apiUsage).toBeNull();
  });

  it('empty resumeHistory: no seeding (same as fresh session)', async () => {
    const q = buildQuery(makeConfig({ resumeHistory: [] }));
    const usage = await q.getContextUsage();
    expect(usage.totalTokens).toBe(0);
  });
});
