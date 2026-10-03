// Unit tests for the shared isMidStreamNetworkTermination predicate (#2780).
//
// The predicate itself lives in providers/shared/network-termination.ts; this
// file is its canonical unit suite. The anthropic-direct network-termination
// test file still keeps a parallel predicate block beside its isMidStreamCut
// cases (isMidStreamCut couples to StreamIncompleteError, an anthropic-specific
// concept). The runTurn integration tests stay in their respective provider
// test files.

import { describe, it, expect } from 'vitest';
import { isMidStreamNetworkTermination } from './network-termination.js';
import { StreamIncompleteError } from '../../../utils/errors.js';

/** The exact shape undici throws on a mid-body socket close. */
function undiciTerminated(): TypeError {
  const socketErr = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  return new TypeError('terminated', { cause: socketErr });
}

describe('isMidStreamNetworkTermination (shared predicate)', () => {
  it("matches undici's TypeError('terminated')", () => {
    expect(isMidStreamNetworkTermination(new TypeError('terminated'))).toBe(true);
    expect(isMidStreamNetworkTermination(undiciTerminated())).toBe(true);
  });

  it('matches a termination code on the error itself', () => {
    expect(
      isMidStreamNetworkTermination(
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      ),
    ).toBe(true);
    expect(
      isMidStreamNetworkTermination(
        Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }),
      ),
    ).toBe(true);
    expect(
      isMidStreamNetworkTermination(
        Object.assign(new Error('connection closed'), { code: 'UND_ERR_CLOSED' }),
      ),
    ).toBe(true);
  });

  it('matches a termination code deeper in the cause chain', () => {
    const inner = Object.assign(new Error('closed'), { code: 'UND_ERR_CLOSED' });
    const outer = new Error('wrapped', { cause: new Error('middle', { cause: inner }) });
    expect(isMidStreamNetworkTermination(outer)).toBe(true);
  });

  it('does NOT match unrelated errors (stays narrower than isNetworkError)', () => {
    expect(isMidStreamNetworkTermination(new TypeError('boom'))).toBe(false);
    expect(isMidStreamNetworkTermination(new Error('terminated'))).toBe(false); // not a TypeError
    expect(isMidStreamNetworkTermination(new Error('network failure'))).toBe(false);
    expect(isMidStreamNetworkTermination(new Error('connect timeout'))).toBe(false);
    expect(
      isMidStreamNetworkTermination(Object.assign(new Error('x'), { code: 'ENOTFOUND' })),
    ).toBe(false);
    expect(isMidStreamNetworkTermination(null)).toBe(false);
    expect(isMidStreamNetworkTermination('terminated')).toBe(false);
    expect(isMidStreamNetworkTermination(undefined)).toBe(false);
    expect(isMidStreamNetworkTermination(42)).toBe(false);
  });

  it('terminates on a self-referential cause instead of looping', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    expect(isMidStreamNetworkTermination(e)).toBe(false);
  });

  it('does NOT match a StreamIncompleteError (that is isMidStreamCut territory)', () => {
    expect(
      isMidStreamNetworkTermination(
        new StreamIncompleteError('ended without a terminal message'),
      ),
    ).toBe(false);
  });
});
