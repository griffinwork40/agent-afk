/**
 * Live integration smoke test against the real OpenAI API.
 *
 * Skipped automatically when no OpenAI auth is resolvable. Runs only when
 * `OPENAI_API_KEY` is set (the most common case) OR when `~/.codex/auth.json`
 * contains an API key. Network access required; not part of CI by default.
 *
 * To run manually (RUN_LIVE_API=1 lifts the config-level *.live.test.ts
 * exclude — a bare `pnpm test <file>` can't, and prints "No test files found"):
 *
 *   RUN_LIVE_API=1 OPENAI_API_KEY=sk-... pnpm vitest run src/agent/providers/openai-compatible/openai-compatible.live.test.ts
 *
 * What this verifies that the stubbed tests cannot:
 *   - The OpenAI SDK actually accepts the request shape we build
 *   - SSE streaming works end-to-end (chunks arrive, deltas accumulate)
 *   - The `tools[]` field with our schemas is accepted by the API
 *   - A tool call round-trips: model emits → harness dispatches → result fed
 *     back → model produces final text
 *
 * Model: pinned to `gpt-4o-mini` — cheapest model that supports tool calls
 * reliably. ~$0.0001 per run.
 */

import { describe, it, expect } from 'vitest';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { createHookRegistry } from '../../hooks.js';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import type { ToolHandler } from '../../tools/types.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import { resolveOpenAIAuth } from './auth.js';
import { buildQueryFromConfig, OpenAICompatibleQuery } from './query.js';

// Skip the whole suite when no auth is configured.
const auth = resolveOpenAIAuth(undefined);
const haveAuth = auth.apiKey !== null;
const describeMaybe = haveAuth ? describe : describe.skip;

async function* yieldOnce(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

async function collect(q: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of q) events.push(ev);
  return events;
}

describeMaybe('openai-compatible — live smoke (requires OPENAI_API_KEY)', () => {
  it(
    'streams a normal one-shot response',
    async () => {
      const config: AgentConfig = {
        model: 'gpt-4o-mini',
      } as AgentConfig;

      const q = buildQueryFromConfig(config, yieldOnce('Say exactly the word "pong" and nothing else.'));
      const events = await collect(q);

      const types = events.map((e) => e.type);
      expect(types[0]).toBe('session.init');
      expect(types).toContain('delta.text');
      expect(types).toContain('assistant.message');
      expect(types.at(-1)).toBe('turn.completed');

      const finalMsg = events.find((e) => e.type === 'assistant.message');
      expect(finalMsg?.type).toBe('assistant.message');
      if (finalMsg?.type === 'assistant.message') {
        expect(finalMsg.text.toLowerCase()).toContain('pong');
      }

      const completed = events.find((e) => e.type === 'turn.completed');
      if (completed?.type === 'turn.completed') {
        expect(completed.usage.outputTokens).toBeGreaterThan(0);
        expect(completed.usage.inputTokens).toBeGreaterThan(0);
      }
    },
    { timeout: 30_000 },
  );

  it(
    'dispatches a tool call against a real model and feeds the result back',
    async () => {
      // Single tool the model can use: get_pi returns the value of pi
      // (no side effects — model has no obvious reason NOT to call it
      // when asked).
      const handlerCalls: Array<unknown> = [];
      const getPiHandler: ToolHandler = async () => {
        handlerCalls.push('get_pi');
        return { content: '3.14159265358979' };
      };
      const schemas: AnthropicToolDef[] = [
        {
          name: 'get_pi',
          description: 'Returns the value of mathematical pi to 14 decimals.',
          input_schema: {
            type: 'object',
            properties: {},
          },
        },
      ];

      const dispatcher = new SessionToolDispatcher({
        handlers: new Map<string, ToolHandler>([['get_pi', getPiHandler]]),
        schemas,
        hookRegistry: createHookRegistry(),
      });

      const config: AgentConfig = { model: 'gpt-4o-mini' } as AgentConfig;
      const q = new OpenAICompatibleQuery({
        auth,
        model: 'gpt-4o-mini',
        synthesizedSessionId: `live-${Date.now()}`,
        promptStream: yieldOnce(
          'Use the get_pi tool to look up the value of pi, then tell me the result. ' +
          'Do not include the decimal beyond what the tool returned.',
        ),
        config,
        toolDispatcher: dispatcher,
      });

      const events = await collect(q);
      const types = events.map((e) => e.type);

      // Must include at least one tool.use.start + tool.output pair.
      expect(types).toContain('tool.use.start');
      expect(types).toContain('tool.output');
      // Handler was actually invoked through the dispatcher.
      expect(handlerCalls.length).toBeGreaterThan(0);

      // Final assistant message must end up referencing the value we fed in.
      const final = events.find((e) => e.type === 'assistant.message');
      expect(final?.type).toBe('assistant.message');
      if (final?.type === 'assistant.message') {
        expect(final.text).toMatch(/3\.14159/);
      }
    },
    { timeout: 60_000 },
  );
});

// Always-running test: when no auth is configured, document why and don't
// silently pass.
if (!haveAuth) {
  describe('openai-compatible — live smoke (skipped)', () => {
    it('skipped: no OpenAI auth resolvable in environment', () => {
      // eslint-disable-next-line no-console
      console.log(
        '[openai-compatible.live.test] Skipped: ' +
          `resolveOpenAIAuth returned source=${auth.source}. ` +
          'Set OPENAI_API_KEY or run `codex login --api-key` to enable.',
      );
      expect(haveAuth).toBe(false);
    });
  });
}
