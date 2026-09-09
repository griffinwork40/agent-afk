/**
 * Tests for `SessionOwner` — the class that owns every `AgentSession` this
 * `afk web` process can actually drive.
 *
 * Constraint: `SessionOwner.create()` constructs a real `AgentSession`, which
 * needs a model API key and network access. This file deliberately never
 * calls `create()`. Most cases cover what is reachable with zero owned
 * sessions: `submitPrompt`/`interrupt` on an unknown id, `list()` on a fresh
 * owner, `isBusy()` for an unknown id, and `closeAll()` on an empty owner.
 *
 * The final case reaches a fake session into the private `sessions` map to
 * pin the one behaviour that is not observable from the outside and that
 * `handlePrompt`'s 409 depends on: `isBusy` rising synchronously on accept.
 * Reaching into a private is the lesser evil against widening the class's
 * public surface purely for a test. What still is NOT covered is a real turn
 * streaming real provider events — that needs network.
 */

import { describe, it, expect } from 'vitest';
import { SessionOwner } from './session-owner.js';

function freshOwner(): SessionOwner {
  return new SessionOwner({ model: 'test-model' });
}

describe('SessionOwner — construction', () => {
  it('starts with no owned sessions', () => {
    const owner = freshOwner();
    expect(owner.owned.size).toBe(0);
    expect(owner.list()).toEqual([]);
  });
});

describe('SessionOwner — submitPrompt on an unknown id', () => {
  it('rejects rather than silently no-op-ing', async () => {
    const owner = freshOwner();
    await expect(owner.submitPrompt('nope', 'hi')).rejects.toThrow(
      /nope.*not owned by this process/,
    );
  });
});

describe('SessionOwner — submitSkillMessage on an unknown id', () => {
  it('rejects rather than silently no-op-ing', async () => {
    const owner = freshOwner();
    await expect(
      owner.submitSkillMessage('nope', [{ type: 'text', text: 'mock' }]),
    ).rejects.toThrow(/nope.*not owned by this process/);
  });
});

describe('SessionOwner — getSessionCwd on an unknown id', () => {
  it('returns undefined rather than throwing', () => {
    const owner = freshOwner();
    expect(owner.getSessionCwd('nope')).toBeUndefined();
  });
});

describe('SessionOwner — getProviderSessionId on an unknown id', () => {
  it('returns undefined rather than throwing', () => {
    const owner = freshOwner();
    expect(owner.getProviderSessionId('nope')).toBeUndefined();
  });
});

describe('SessionOwner — interrupt on an unknown id', () => {
  it('rejects rather than silently no-op-ing', async () => {
    const owner = freshOwner();
    await expect(owner.interrupt('nope')).rejects.toThrow(/nope.*not owned by this process/);
  });
});

describe('SessionOwner — isBusy on an unknown id', () => {
  it('reports false rather than throwing', () => {
    const owner = freshOwner();
    expect(owner.isBusy('nope')).toBe(false);
  });
});

describe('SessionOwner — list on a fresh owner', () => {
  it('returns an empty array', () => {
    expect(freshOwner().list()).toEqual([]);
  });
});

describe('SessionOwner — closeAll on an empty owner', () => {
  it('resolves without throwing and leaves state empty', async () => {
    const owner = freshOwner();
    await expect(owner.closeAll()).resolves.toBeUndefined();
    expect(owner.owned.size).toBe(0);
    expect(owner.list()).toEqual([]);
  });

  it('is safe to call twice in a row', async () => {
    const owner = freshOwner();
    await owner.closeAll();
    await expect(owner.closeAll()).resolves.toBeUndefined();
  });
});

/**
 * Invariant: `isBusy` must flip true SYNCHRONOUSLY inside `submitPrompt`,
 * before it returns — not from inside the chained `.then()` that actually
 * runs the turn.
 *
 * `handlePrompt` (routes.ts) 409s on `isBusy` before calling `submitPrompt`.
 * If the flag were raised on a later microtask, two POSTs arriving in that
 * window would both read `isBusy === false`, both clear the gate, and both
 * chain — the unbounded chaining the 409 exists to stop. Asserting without an
 * intervening `await` is what makes this test able to fail: any deferral of
 * the marking, by even one microtask, turns the first expectation red.
 *
 * A fake session is reached into `SessionOwner`'s private map because the only
 * public path to a driveable session is `create()`, which constructs a real
 * `AgentSession` and needs a model API key plus network.
 */
describe('SessionOwner — isBusy is raised synchronously on accept', () => {
  interface OwnerInternals {
    sessions: Map<string, { sendMessageStream: (text: string) => AsyncIterable<unknown> }>;
  }

  it('reports busy before submitPrompt resolves, and idle after the turn drains', async () => {
    const owner = freshOwner();
    let releaseTurn: () => void = () => {};
    const turnFinished = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    (owner as unknown as OwnerInternals).sessions.set('s1', {
      // eslint-disable-next-line require-yield
      async *sendMessageStream(): AsyncIterable<unknown> {
        await turnFinished;
      },
    });

    expect(owner.isBusy('s1')).toBe(false);

    // Deliberately NOT awaited: the flag must already be up on return.
    const accepted = owner.submitPrompt('s1', 'hello');
    expect(owner.isBusy('s1')).toBe(true);

    await accepted;
    expect(owner.isBusy('s1')).toBe(true);

    releaseTurn();
    await new Promise((r) => setTimeout(r, 0));
    expect(owner.isBusy('s1')).toBe(false);
  });
});

/**
 * Invariant: `reserveTurn` / `releaseTurn` correctly manage the pending
 * counter for the backpressure gap fix (Item 4).
 *
 * `reserveTurn` claims a slot synchronously before an async slash dispatch.
 * `releaseTurn` releases it on non-turn paths, keeping the net count at 0.
 * When a skill turn IS queued, `submitSkillMessage` increments pending itself
 * and then `releaseTurn` is called — net count stays 1 (the real turn).
 */
describe('SessionOwner — reserveTurn / releaseTurn', () => {
  it('makes isBusy true after reserve and false after release', () => {
    const owner = freshOwner();
    expect(owner.isBusy('s1')).toBe(false);
    owner.reserveTurn('s1');
    expect(owner.isBusy('s1')).toBe(true);
    owner.releaseTurn('s1');
    expect(owner.isBusy('s1')).toBe(false);
  });

  it('is safe to releaseTurn on an unknown id (floors at 0)', () => {
    const owner = freshOwner();
    // Should not throw; isBusy stays false.
    owner.releaseTurn('unknown');
    expect(owner.isBusy('unknown')).toBe(false);
  });

  it('reserve then release nets to zero (non-turn path)', () => {
    const owner = freshOwner();
    owner.reserveTurn('s2');
    expect(owner.isBusy('s2')).toBe(true);
    owner.releaseTurn('s2');
    expect(owner.isBusy('s2')).toBe(false);
  });

  it('reserve + submitPrompt increment + release nets to 1 (skill-turn path simulation)', () => {
    const owner = freshOwner();
    // Simulate: reserve (count=1), then submitSkillMessage increments
    // (count=2), then releaseTurn releases the reservation (count=1).
    owner.reserveTurn('s3');         // count = 1
    owner.reserveTurn('s3');         // simulate submitSkillMessage increment → count = 2
    owner.releaseTurn('s3');         // release reservation → count = 1
    expect(owner.isBusy('s3')).toBe(true); // real turn still in flight
  });
});
