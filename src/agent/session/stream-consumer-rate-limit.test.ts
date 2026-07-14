/**
 * Tests for the `rate_limit` ProviderEvent → OutputEvent mapping in
 * {@link transformProviderEvent}.
 *
 * Contract: the provider emits `rate_limit` (with a `retryAfterMs` parsed from
 * the throttled response's `retry-after` header) while the SDK sleeps out a
 * 429/503/529 backoff. The stream consumer must forward it as an OutputEvent
 * carrying `retryAfterMs` so the interactive surface can render a live
 * `rate-limited · retrying in ~Ns` banner. Trace-only fields (status/attempt)
 * are intentionally dropped at this boundary.
 */

import { describe, it, expect } from 'vitest';
import type { ProviderEvent } from '../provider.js';
import { transformProviderEvent, type TransformDeps } from './stream-consumer.js';
import type { Message, SessionMetadata } from '../types.js';

/**
 * Minimal deps stub — the `rate_limit` branch is a pure passthrough (no side
 * effects), so the callbacks are never invoked. Provided so the required
 * fields on {@link TransformDeps} are satisfied without pulling in a full
 * session harness.
 */
function stubDeps(): TransformDeps {
  return {
    conversationHistory: [] as Message[],
    getSessionMetadata: () => ({}) as SessionMetadata,
    setSessionMetadata: () => {},
    updateSessionIdentity: () => {},
    resolveInitialization: () => {},
    setLastResponseMetadata: () => {},
  };
}

describe('transformProviderEvent — rate_limit', () => {
  it('maps rate_limit with retryAfterMs to a rate_limit OutputEvent carrying the delay', () => {
    const evt: ProviderEvent = {
      type: 'rate_limit',
      sessionId: 's1',
      status: 429,
      attempt: 1,
      retryAfterMs: 70_000,
    };
    const out = transformProviderEvent(evt, stubDeps());
    expect(out).toEqual({ type: 'rate_limit', retryAfterMs: 70_000 });
  });

  it('omits retryAfterMs when the provider event has none (header absent)', () => {
    const evt: ProviderEvent = {
      type: 'rate_limit',
      sessionId: 's1',
      status: 529,
      attempt: 2,
    };
    const out = transformProviderEvent(evt, stubDeps());
    expect(out).toEqual({ type: 'rate_limit' });
    // Explicitly assert the key is absent, not just undefined-valued.
    expect(out && 'retryAfterMs' in out).toBe(false);
  });

  it('drops the trace-only status/attempt fields at the surface boundary', () => {
    const evt: ProviderEvent = {
      type: 'rate_limit',
      sessionId: 's1',
      status: 503,
      attempt: 3,
      retryAfterMs: 5_000,
    };
    const out = transformProviderEvent(evt, stubDeps());
    expect(out).not.toBeNull();
    expect(out && 'status' in out).toBe(false);
    expect(out && 'attempt' in out).toBe(false);
  });
});
