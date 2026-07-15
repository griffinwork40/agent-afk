import { describe, expect, it } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import type { ToolCall, ToolResult } from './types.js';
import { DenialCircuitBreakerError } from '../../../utils/errors.js';
import { DENIAL_BREAKER_FAILURE_CLASS } from '../../tools/denial-circuit-breaker.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeToolUseStream,
  makeClient,
  makeBatchDispatcher,
} from './loop.test-helpers.js';

// #546: when the dispatcher trips the denial circuit breaker it tags the
// tool result `failureClass: 'denial-breaker'`. The loop MUST surface that as a
// loud terminal `error` event (→ DenialCircuitBreakerError, rethrown into a
// structured failure by the shared subagent handle) and STOP — never silently
// continue looping to the wall-clock budget, and never dress it as a success.
describe('loop.ts — denial circuit breaker fail-loud', () => {
  it('yields a terminal DenialCircuitBreakerError event and stops the loop on a denial-breaker result', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      // Round 1: the model issues a read. Round 2 (a text answer) must NEVER be
      // reached — tripping the breaker ends the turn immediately.
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_r', 'read_file', '{"file_path":"/out-of-scope/x.ts"}'));
      }
      return fromArray(makeTextStream('this second round should never run'));
    });

    const DENIAL_MSG =
      'Denial circuit breaker: this forked sub-agent hit 5 consecutive path-approval read denials';
    const dispatcher = makeBatchDispatcher(
      async (calls: ToolCall[]): Promise<ToolResult[]> =>
        calls.map(() => ({
          content: DENIAL_MSG,
          isError: true,
          failureClass: DENIAL_BREAKER_FAILURE_CLASS,
        })),
    );

    const messages: MessageParam[] = [{ role: 'user', content: 'read a bunch of files' }];
    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );

    // 1. A loud error event was emitted, carrying the actionable message.
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error).toBeInstanceOf(DenialCircuitBreakerError);
      expect(errorEvent.error.message).toContain('Denial circuit breaker');
    }

    // 2. The loop STOPPED — the model was called exactly once, never looping to
    //    a second round (which is the wall-clock-budget burn #546 kills).
    expect(client.messages.create).toHaveBeenCalledTimes(1);

    // 3. Fail LOUD, not a silent success: no clean turn.completed after the trip.
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false);
  });
});
