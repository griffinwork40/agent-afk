import { describe, expect, it } from 'vitest';
import type { OutputEvent } from '../types/session-types.js';
import { countRuntimeRounds } from './handle.streaming.js';

const progress = (roundsUsed: number): OutputEvent =>
  ({ type: 'progress', progress: { taskId: 't', description: 'Working', roundsUsed, totalTokens: 0, toolUses: roundsUsed, durationMs: 1 } }) as OutputEvent;

function count(values: number[]): number {
  const handle = { _runtimeRoundsUsed: 0 };
  let last = 0;
  for (const v of values) last = countRuntimeRounds(handle, progress(v), last);
  return handle._runtimeRoundsUsed;
}

describe('countRuntimeRounds (D4 runtime round counter)', () => {
  it('a Stop-hook restart that resets the round counter starts a new segment: 1,2,3 then 1,2 counts 5', () => {
    expect(count([1, 2, 3, 1, 2])).toBe(5);
  });

  it('a Stop-hook restart after a 1-round segment counts both segments: 1 then 1 counts 2', () => {
    expect(count([1, 1])).toBe(2);
    expect(count([2, 1, 2])).toBe(4);
  });

  it('a retry-tier replay continues the monotonic count (anthropic-direct turnState): 1,2 then 3 counts 3', () => {
    expect(count([1, 2, 3])).toBe(3);
  });

  it('ignores non-progress events and progress without roundsUsed', () => {
    const handle = { _runtimeRoundsUsed: 0 };
    let last = countRuntimeRounds(handle, { type: 'chunk', chunk: 'x' } as unknown as OutputEvent, 0);
    last = countRuntimeRounds(handle, { type: 'progress', progress: { taskId: 't', description: 'd', totalTokens: 0, toolUses: 0, durationMs: 1 } } as OutputEvent, last);
    expect(last).toBe(0);
    expect(handle._runtimeRoundsUsed).toBe(0);
  });
});
