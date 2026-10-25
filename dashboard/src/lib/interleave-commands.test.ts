import { describe, expect, it } from 'vitest';
import { interleaveCommands } from './interleave-commands';

const cmd = (key: number, afterCount: number) => ({ key, afterCount });

describe('interleaveCommands', () => {
  it('returns one transcript segment when there are no commands', () => {
    expect(interleaveCommands(['a', 'b'], [])).toEqual([{ kind: 'transcript', items: ['a', 'b'] }]);
  });

  it('places a command at its anchor, not at the bottom', () => {
    const segs = interleaveCommands(['a', 'b', 'c'], [cmd(1, 1)]);
    expect(segs).toEqual([
      { kind: 'transcript', items: ['a'] },
      { kind: 'command', item: cmd(1, 1) },
      { kind: 'transcript', items: ['b', 'c'] },
    ]);
  });

  it('keeps insertion order for outputs sharing an anchor and handles anchor 0', () => {
    const segs = interleaveCommands(['a'], [cmd(2, 0), cmd(1, 0)]);
    expect(segs.map((s) => (s.kind === 'command' ? s.item.key : s.items.join('')))).toEqual([1, 2, 'a']);
  });

  it('clamps anchors beyond the transcript to the end', () => {
    const segs = interleaveCommands(['a'], [cmd(1, 9)]);
    expect(segs).toEqual([{ kind: 'transcript', items: ['a'] }, { kind: 'command', item: cmd(1, 9) }]);
  });

  it('reproduces the transcript exactly when segments are concatenated', () => {
    const items = ['a', 'b', 'c', 'd'];
    const segs = interleaveCommands(items, [cmd(1, 2), cmd(2, 4), cmd(3, 1)]);
    expect(segs.flatMap((s) => (s.kind === 'transcript' ? s.items : []))).toEqual(items);
  });
});
