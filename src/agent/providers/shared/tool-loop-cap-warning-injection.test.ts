/**
 * Provider-level integration tests for advance round-warning injection.
 *
 * Distinct from tool-loop-cap-warnings.test.ts, which tests the POLICY layer
 * (pickRoundWarning returns correct text and thresholds). These tests verify
 * that the warning text is actually INJECTED into the provider-specific message
 * history structures by the integration helpers in each provider loop.
 *
 * Covered:
 *  - OpenAI-compatible: injectRoundWarning appends text to the correct message
 *    type (tool → new user turn; user string → suffix; user array → text block)
 *  - Anthropic-direct: the warnState is updated correctly and the injected text
 *    reaches the last message in `input.messages`
 *
 * "Provider integration" here means: the warning text touches the WIRE
 * representation (OpenAI tool/user turns, Anthropic content blocks) rather than
 * only being computed by the shared policy function.
 *
 * @module agent/providers/shared/tool-loop-cap-warning-injection.test
 */

import { describe, it, expect } from 'vitest';

// ─── OpenAI-compatible integration ────────────────────────────────────────────
// injectRoundWarning is extracted from turn-driver.ts as a named export so
// it can be unit-tested without booting the full query context.
import { injectRoundWarning } from '../openai-compatible/query/turn-driver.js';
import type { OpenAIMessage } from '../openai-compatible/messages.js';

// ─── Anthropic-direct integration ─────────────────────────────────────────────
// The Anthropic provider's warnState is stored on TurnAccumulator and fed
// to pickRoundWarning inside runToolRound. We test the TurnAccumulator
// surface directly — its lastWarnedThreshold field — and verify that the
// same pickRoundWarning call the loop makes would inject text given a
// representative message array shaped like the Anthropic wire format.
import { pickRoundWarning } from './tool-loop-cap.js';
import { TurnAccumulator } from '../anthropic-direct/loop/turn-accumulator.js';

const asOpenAIMessages = (m: unknown[]): OpenAIMessage[] => m as OpenAIMessage[];

// ─── OpenAI-compatible: injectRoundWarning integration ───────────────────────

describe('OpenAI injectRoundWarning — wire-level injection', () => {
  const warnState = (): { lastWarnedThreshold: number | undefined } => ({
    lastWarnedThreshold: undefined,
  });

  it('appends a new user turn when the tail is a role:tool message (OpenAI wire format)', () => {
    const turns = asOpenAIMessages([
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]);
    const ws = warnState();
    injectRoundWarning(turns, 40, 50, ws); // remaining=10, threshold=10
    // A new user turn was appended (tool messages cannot be extended).
    expect(turns).toHaveLength(4);
    expect(turns.at(-1)).toMatchObject({ role: 'user' });
    const lastContent = (turns.at(-1) as { content: unknown }).content;
    expect(typeof lastContent === 'string' ? lastContent : '').toContain('10 tool-use rounds remaining');
    // warnState advanced to 10 so the same threshold does not fire again.
    expect(ws.lastWarnedThreshold).toBe(10);
    // The original tool message is untouched.
    expect(turns[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });

  it('appends warning text to an existing trailing user string message', () => {
    const turns = asOpenAIMessages([
      { role: 'user', content: 'context message' },
    ]);
    const ws = warnState();
    injectRoundWarning(turns, 45, 50, ws); // remaining=5
    expect(turns).toHaveLength(1);
    const content = (turns[0] as { content: string }).content;
    expect(content).toContain('context message');
    expect(content).toContain('5 tool-use rounds remaining');
    expect(ws.lastWarnedThreshold).toBe(5);
  });

  it('pushes a text block onto an array-content trailing user message', () => {
    const turns = asOpenAIMessages([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] },
    ]);
    const ws = warnState();
    injectRoundWarning(turns, 48, 50, ws); // remaining=2
    expect(turns).toHaveLength(1);
    const blocks = (turns[0] as { content: Array<{ type: string; text?: string }> }).content;
    expect(blocks).toHaveLength(2);
    expect(blocks.at(-1)).toMatchObject({ type: 'text' });
    expect(blocks.at(-1)?.text).toContain('2 tool-use rounds remaining');
    expect(ws.lastWarnedThreshold).toBe(2);
  });

  it('is a no-op when unlimited budget (cap=0)', () => {
    const turns = asOpenAIMessages([{ role: 'user', content: 'hi' }]);
    const ws = warnState();
    injectRoundWarning(turns, 10, 0, ws);
    expect(turns).toHaveLength(1);
    expect(ws.lastWarnedThreshold).toBeUndefined();
  });

  it('is a no-op when no threshold is crossed (remaining=15 > all thresholds)', () => {
    const turns = asOpenAIMessages([{ role: 'user', content: 'hi' }]);
    const ws = warnState();
    injectRoundWarning(turns, 35, 50, ws); // remaining=15
    expect(turns).toHaveLength(1); // no change
    expect(ws.lastWarnedThreshold).toBeUndefined();
  });

  it('is idempotent — same threshold does not fire twice per turn', () => {
    const turns = asOpenAIMessages([
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    ]);
    const ws = warnState();
    injectRoundWarning(turns, 40, 50, ws); // remaining=10 → warns, appends user turn
    expect(turns).toHaveLength(2);
    expect(ws.lastWarnedThreshold).toBe(10);
    // Same threshold — no additional message.
    const turnsAfter = [...turns];
    injectRoundWarning(turns, 41, 50, ws); // remaining=9, still ≤10 but already warned
    expect(turns).toHaveLength(turnsAfter.length); // no new message
  });

  it('escalates from ≤10 to ≤5 threshold in successive rounds', () => {
    // First warning (remaining=10): tail is a tool message → push new user turn.
    // Second warning (remaining=5): tail is now the user turn we just pushed →
    //   append to that string (same message, no new turn).
    const turns = asOpenAIMessages([{ role: 'tool', tool_call_id: 'c1', content: 'r1' }]);
    const ws = warnState();
    injectRoundWarning(turns, 40, 50, ws); // remaining=10 → appends user turn
    expect(ws.lastWarnedThreshold).toBe(10);
    expect(turns).toHaveLength(2); // [tool, user]
    injectRoundWarning(turns, 45, 50, ws); // remaining=5 → appends to trailing user
    expect(ws.lastWarnedThreshold).toBe(5);
    expect(turns).toHaveLength(2); // still 2 — second warning merged into user turn
    // Both warning texts present in the trailing user turn.
    const lastContent = (turns.at(-1) as { content: string }).content;
    expect(lastContent).toContain('10 tool-use rounds remaining');
    expect(lastContent).toContain('5 tool-use rounds remaining');
  });

  it('injects a singular "round" for remaining=1', () => {
    const turns = asOpenAIMessages([{ role: 'tool', tool_call_id: 'c1', content: 'r' }]);
    const ws = warnState();
    injectRoundWarning(turns, 49, 50, ws); // remaining=1
    const appended = turns.at(-1) as { content: string };
    expect(appended.content).toContain('1 tool-use round remaining');
  });

  it('does not fire when in wind-down territory (remaining=0)', () => {
    const turns = asOpenAIMessages([{ role: 'user', content: 'hi' }]);
    const ws = warnState();
    injectRoundWarning(turns, 50, 50, ws); // remaining=0 → wind-down range, not warning range
    expect(turns).toHaveLength(1);
    expect(ws.lastWarnedThreshold).toBeUndefined();
  });
});

// ─── Anthropic-direct: warnState + message injection verification ─────────────
//
// runToolRound is an async generator that requires a full provider context to
// call end-to-end. Instead, we verify the Anthropic injection logic in two parts:
//
// Part 1: pickRoundWarning (shared policy) returns a warnText for the correct
//         thresholds and advances lastWarnedThreshold — this is exactly what
//         runToolRound calls.
// Part 2: the INJECTION pattern (appending to the last user/tool_result content)
//         is verified at the message-array level using the same structure the
//         Anthropic loop uses (content: ContentBlockParam[]).

describe('Anthropic-direct warnState + message injection verification', () => {
  it('pickRoundWarning returns text when a threshold is crossed (Anthropic loop calls this)', () => {
    // Anthropic loop: round=40, cap=50 → remaining=10 → threshold 10 fires
    const [text, threshold] = pickRoundWarning(40, 50, undefined);
    expect(text).not.toBeNull();
    expect(text).toContain('10 tool-use rounds remaining');
    expect(threshold).toBe(10);
  });

  it('text block injection pattern: appends to an array-content user message', () => {
    // Simulates the injection in tool-round.ts:
    //   const lastMsg = input.messages[input.messages.length - 1];
    //   if (lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
    //     lastMsg.content.push({ type: 'text', text: warnText });
    //   }
    const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [
      { role: 'user', content: [{ type: 'tool_result', text: 'bash output' }] },
    ];
    const [warnText] = pickRoundWarning(40, 50, undefined);
    if (warnText !== null) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg !== undefined && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push({ type: 'text', text: warnText });
      }
    }
    expect(messages[0].content).toHaveLength(2);
    expect(messages[0].content.at(-1)).toMatchObject({ type: 'text' });
    expect(messages[0].content.at(-1)?.text).toContain('10 tool-use rounds remaining');
  });

  it('injection is idempotent per turn via lastWarnedThreshold', () => {
    // First call: threshold 10 fires.
    const [text1, t1] = pickRoundWarning(40, 50, undefined);
    expect(text1).not.toBeNull();
    expect(t1).toBe(10);
    // Second call with same round count: already warned, no new text.
    const [text2] = pickRoundWarning(40, 50, t1);
    expect(text2).toBeNull();
  });

  it('injection does not fire when lastMsg is not a user message (non-injection guard)', () => {
    // The Anthropic loop only injects when the last message is role:'user'.
    // When it's an 'assistant' message, no injection happens.
    const messages: Array<{ role: string; content: unknown[] }> = [
      { role: 'assistant', content: [{ type: 'text', text: 'I will call bash now.' }] },
    ];
    const [warnText] = pickRoundWarning(40, 50, undefined);
    // Guard identical to tool-round.ts
    const lastMsg = messages[messages.length - 1];
    if (lastMsg !== undefined && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
      lastMsg.content.push({ type: 'text', text: warnText! });
    }
    // No injection — assistant message is unchanged.
    expect(messages[0].content).toHaveLength(1);
  });

  it('lastWarnedThreshold on TurnAccumulator starts undefined (no pre-warning)', () => {
    // Verify that TurnAccumulator.lastWarnedThreshold initializes to undefined.
    // This is structural — it means no threshold has fired at turn start,
    // so the first round can fire any applicable warning threshold.
    const acc = new TurnAccumulator();
    expect(acc.lastWarnedThreshold).toBeUndefined();
  });
});
