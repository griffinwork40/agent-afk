/**
 * Wiring test for the yield contract: both providers derive the dispatcher's
 * `userAttention` from `planExitControls` (top-level sessions only), late-bound
 * so the REPL can install `hasPendingUserMessage` after construction.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicDirectProvider } from './anthropic-direct/index.js';
import { OpenAICompatibleProvider } from './openai-compatible/index.js';
import { isUserWaiting, type UserAttention } from '../tools/user-yield.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
function attentionOf(provider: unknown, opts: Record<string, unknown>): UserAttention | undefined {
  const d = (provider as any).buildDispatcher('default', opts);
  return (d as any).userAttention as UserAttention | undefined;
}

const providers = [
  ['anthropic-direct', () => new AnthropicDirectProvider()],
  ['openai-compatible', () => new OpenAICompatibleProvider({})],
] as const;

describe.each(providers)('%s dispatcher userAttention wiring', (_label, make) => {
  it('is absent without planExitControls (subagents)', () => {
    expect(attentionOf(make(), {})).toBeUndefined();
  });

  it('reads the REPL predicate late, after construction', () => {
    const controls: { hasPendingUserMessage?: () => boolean } = {};
    const attention = attentionOf(make(), { planExitControls: controls });
    expect(attention).toBeDefined();
    expect(isUserWaiting(attention)).toBe(false);
    controls.hasPendingUserMessage = () => true;
    expect(isUserWaiting(attention)).toBe(true);
  });
});
