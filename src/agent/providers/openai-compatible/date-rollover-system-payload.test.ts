/**
 * Integration test for mid-session date rollover in the openai-compatible
 * provider's system payload — the twin of
 * `anthropic-direct/date-rollover-system-payload.test.ts` for issue #785.
 *
 * `OpenAICompatibleProvider.query()` assembles the `# Environment` fragment
 * (and the rest of the system prompt) ONCE per `query()` call, exactly like
 * anthropic-direct's `userSystem`. Before the fix, `buildMessages()`
 * (messages.ts) read that frozen string on every turn via
 * `resolveSystemPrompt()`, so a session resident across local midnight kept
 * sending yesterday's `- Date:` line for the rest of its life. The fix calls
 * `refreshEnvironmentDate()` on the resolved system string inside
 * `buildMessages()`, which runs once per `runIteration()` — i.e. once per turn.
 *
 * Asserted at the `chat.completions.create` boundary — the closest observable
 * point to what the model actually sees. Only `Date` is faked; timers stay
 * real so the streaming machinery is untouched. The two instants are 48h
 * apart so the local date differs in EVERY host timezone, keeping the
 * assertion valid on the ubuntu/macos/windows CI legs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type OpenAI from 'openai';
import type { AgentConfig } from '../../types/config-types.js';
import type { ProviderUserTurn } from '../../provider.js';
import { __setOpenAIClientFactory, type OpenAIClientFactory } from './query.js';
import { OpenAICompatibleProvider } from './index.js';
import type { OpenAIChunk } from './translate.js';

const createCalls: Array<{ args: { messages: Array<{ role: string; content: string }> } }> = [];
let callCount = 0;
let rollAt: Date | null = null;

function makeTextStream(text: string): OpenAIChunk[] {
  return [
    { choices: [{ delta: { content: text } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    },
  ];
}

/** Roll the fake clock to `rollAt` right after the FIRST `create()` call is
 * recorded — mirrors `rollClockAfterFirstCall` in the anthropic-direct sibling
 * test, so turn 2's `buildMessages()` runs on the far side of the rollover. */
function installClockRollingClient(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean }) => {
            if (!args.stream) throw new Error('mock only supports streaming mode');
            createCalls.push({ args: args as never });
            callCount += 1;
            if (callCount === 1 && rollAt !== null) vi.setSystemTime(rollAt);
            const chunks = makeTextStream('ok');
            return (async function* () {
              for (const c of chunks) yield c;
            })();
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

async function* twoTurns(): AsyncIterable<ProviderUserTurn> {
  yield { content: 'first' };
  yield { content: 'second' };
}

async function drain(query: AsyncIterable<unknown>): Promise<void> {
  for await (const _ev of query) {
    void _ev;
  }
}

function runTwoTurns(): AsyncIterable<unknown> {
  const provider = new OpenAICompatibleProvider();
  return provider.query({
    prompt: twoTurns(),
    config: { model: 'gpt-4o-mini', apiKey: 'sk-test-key' } as AgentConfig,
  }) as AsyncIterable<unknown>;
}

function systemTextOfCall(i: number): string {
  return createCalls[i]?.args.messages[0]?.content ?? '';
}

function dateLineOf(systemText: string): string | undefined {
  return systemText.split('\n').find((l) => l.startsWith('- Date: '));
}

const DAY_ONE = new Date('2026-07-30T12:00:00Z');
const DAY_THREE = new Date('2026-08-01T12:00:00Z'); // +48h: a different local date everywhere

describe('OpenAICompatibleQuery — mid-session date rollover (#785)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY_ONE);
    createCalls.length = 0;
    callCount = 0;
    rollAt = null;
    __setOpenAIClientFactory(null);
    installClockRollingClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    __setOpenAIClientFactory(null);
  });

  it('re-renders the Date line on the turn after the local day changes', async () => {
    rollAt = DAY_THREE;
    await drain(runTwoTurns());

    expect(createCalls.length).toBeGreaterThanOrEqual(2);
    const first = dateLineOf(systemTextOfCall(0));
    const second = dateLineOf(systemTextOfCall(1));

    expect(first).toMatch(/^- Date: \w+, \d{4}-\d{2}-\d{2} \(.+\)$/);
    expect(second).toMatch(/^- Date: \w+, \d{4}-\d{2}-\d{2} \(.+\)$/);
    expect(second).not.toBe(first);
  });

  // Cache economics: the same-day payload must be byte-identical — ideally
  // the same string reference — which is what proves the fix does not churn
  // the request payload (and, on backends that cache by prefix, the
  // prompt-cache breakpoint) on every turn. `refreshEnvironmentDate` returns
  // its input by reference when the rendered date is unchanged, and
  // `resolveSystemPrompt` reads the same frozen `config.systemPrompt` string
  // every turn, so the `content` sent on turn 2 is the same value (and
  // reference, for the underlying string) as the one sent on turn 1.
  it('leaves the system payload untouched (same reference) across turns within the same day', async () => {
    rollAt = null;
    await drain(runTwoTurns());

    expect(createCalls.length).toBeGreaterThanOrEqual(2);
    const first = systemTextOfCall(0);
    const second = systemTextOfCall(1);
    expect(second).toBe(first);
  });
});
