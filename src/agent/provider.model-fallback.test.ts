import { describe, it, expect, expectTypeOf } from 'vitest';
import type { ModelFallbackReason, ProviderEvent } from './provider.js';
import type { NoticeKind, OutputEvent } from './types/session-types.js';
import type { AgentConfig } from './types/config-types.js';

// Contract-only declarations for the main-session fallback model. These are
// compile-time checks (pnpm lint) plus a trivial runtime shape check.
describe('model fallback contracts', () => {
  it('declares ModelFallbackReason', () => {
    expectTypeOf<ModelFallbackReason>().toEqualTypeOf<'usage-limit' | 'credit-exhausted' | 'model-rejected'>();
  });

  it('declares the model.fallback_request provider event', () => {
    const ev: ProviderEvent = { type: 'model.fallback_request', reason: 'usage-limit', error: new Error('429'), sessionId: 's' };
    expect(ev.type).toBe('model.fallback_request');
    expectTypeOf<Extract<ProviderEvent, { type: 'model.fallback_request' }>>().toEqualTypeOf<{
      type: 'model.fallback_request';
      reason: ModelFallbackReason;
      error: Error;
      sessionId?: string;
    }>();
  });

  it('adds the model-fallback notice kind with an optional fallback payload', () => {
    const fallback = { from: 'opus', to: 'sonnet', reason: 'credit-exhausted' as const };
    const pe: ProviderEvent = { type: 'notice', text: 'switched', kind: 'model-fallback', fallback };
    const oe: OutputEvent = { type: 'notice', text: 'switched', kind: 'model-fallback', fallback };
    const kind: NoticeKind = 'model-fallback';
    expect([pe.type, oe.type, kind]).toEqual(['notice', 'notice', 'model-fallback']);
  });

  it('declares AgentConfig.modelFallbackArmed', () => {
    expectTypeOf<AgentConfig['modelFallbackArmed']>().toEqualTypeOf<boolean | (() => boolean) | undefined>();
  });
});
