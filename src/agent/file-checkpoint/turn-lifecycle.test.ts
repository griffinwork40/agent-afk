/** Checkpoint turn links (#4271): object-identity mapping from prompts to checkpoints. */
import { describe, expect, it } from 'vitest';
import { checkpointTurnIdFor, linkCheckpointTurn, withCheckpointTurnIds } from './turn-lifecycle.js';

describe('checkpoint turn links', () => {
  it('decorates only targets whose message object was linked', () => {
    const first = { role: 'user', content: 'first' };
    const reply = { role: 'assistant', content: 'ok' };
    const second = { role: 'user', content: 'second' };
    linkCheckpointTurn(second, 'turn-2');
    const targets = withCheckpointTurnIds(
      [{ turnIndex: 2, preview: 'second' }, { turnIndex: 0, preview: 'first' }],
      [first, reply, second],
    );
    expect(targets).toEqual([
      { turnIndex: 2, preview: 'second', checkpointTurnId: 'turn-2' },
      { turnIndex: 0, preview: 'first' },
    ]);
  });

  it('keys by identity, so an equal-looking replacement message has no link', () => {
    const original = { role: 'user', content: 'same' };
    linkCheckpointTurn(original, 'turn-x');
    expect(checkpointTurnIdFor({ ...original })).toBeUndefined();
    expect(checkpointTurnIdFor(original)).toBe('turn-x');
    expect(checkpointTurnIdFor(undefined)).toBeUndefined();
  });
});
