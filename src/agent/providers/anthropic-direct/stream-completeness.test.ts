// Unit tests for the end-of-stream completeness check extracted from
// translate.ts. The anti-regression test here is the LAST one: the error text
// must not assert a cause it cannot know (see the module docblock).

import { describe, it, expect } from 'vitest';
import { incompleteStreamError, isStreamComplete } from './stream-completeness.js';
import { StreamIncompleteError } from '../../../utils/errors.js';

describe('isStreamComplete', () => {
  it('is complete when message_stop arrived', () => {
    expect(isStreamComplete(true, null)).toBe(true);
  });

  it('is complete when a real stop_reason arrived even without message_stop', () => {
    // The model DID say why it stopped; only the framing event was lost. Treating
    // this as a cut would fail a turn that actually finished.
    expect(isStreamComplete(false, 'end_turn')).toBe(true);
    expect(isStreamComplete(false, 'tool_use')).toBe(true);
    expect(isStreamComplete(false, 'max_tokens')).toBe(true);
  });

  it('is INCOMPLETE only when neither terminal signal arrived', () => {
    expect(isStreamComplete(false, null)).toBe(false);
  });
});

describe('incompleteStreamError', () => {
  it('is a StreamIncompleteError so subagent consumers route it to status:failed', () => {
    const err = incompleteStreamError();
    expect(err).toBeInstanceOf(StreamIncompleteError);
    expect(err).toBeInstanceOf(Error);
  });

  it('states the observable facts: no message_stop, no stop_reason, turn incomplete', () => {
    const msg = incompleteStreamError().message;
    expect(msg).toContain('message_stop');
    expect(msg).toContain('stop_reason');
    expect(msg).toContain('incomplete');
  });

  it('points the reader at the trace phases that DO identify the cause', () => {
    const msg = incompleteStreamError().message;
    expect(msg).toContain('ttfb_timeout');
    expect(msg).toContain('idle_watchdog_fired');
    expect(msg).toContain('rate_limit');
  });

  it('does NOT assert an intermediary/proxy cause — the layer cannot know it', () => {
    // Regression guard. The old text claimed the cut was "typically an
    // intermediary closing the connection". That guess was wrong often enough to
    // misdirect two investigations into the network layer, when the SDK ends
    // iteration identically for its own bare-abort request timeout. Do not
    // reintroduce a cause claim here.
    const msg = incompleteStreamError().message.toLowerCase();
    expect(msg).not.toContain('intermediary');
    expect(msg).not.toContain('proxy');
    expect(msg).not.toContain('gateway');
    expect(msg).not.toContain('load balancer');
    expect(msg).not.toContain('typically');
    expect(msg).toContain('not knowable');
  });
});
