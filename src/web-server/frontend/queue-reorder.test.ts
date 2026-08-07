import { describe, expect, it } from 'vitest';
import { editAt, insert, moveDown, moveUp, removeAt } from './queue-reorder.js';

describe('moveUp', () => {
  it('swaps the item with its predecessor', () => {
    const list = ['a', 'b', 'c'];
    expect(moveUp(list, 1)).toEqual(['b', 'a', 'c']);
    expect(list).toEqual(['a', 'b', 'c']); // unmutated
  });

  it('is a no-op at index 0', () => {
    const list = ['a', 'b', 'c'];
    expect(moveUp(list, 0)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for a negative index', () => {
    const list = ['a', 'b', 'c'];
    expect(moveUp(list, -1)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for an index beyond the end', () => {
    const list = ['a', 'b', 'c'];
    expect(moveUp(list, 5)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op on an empty list', () => {
    expect(moveUp([], 0)).toEqual([]);
  });

  it('returns a new array reference, not the same one', () => {
    const list = ['a', 'b'];
    expect(moveUp(list, 1)).not.toBe(list);
  });
});

describe('moveDown', () => {
  it('swaps the item with its successor', () => {
    const list = ['a', 'b', 'c'];
    expect(moveDown(list, 1)).toEqual(['a', 'c', 'b']);
    expect(list).toEqual(['a', 'b', 'c']); // unmutated
  });

  it('is a no-op at the last index', () => {
    const list = ['a', 'b', 'c'];
    expect(moveDown(list, 2)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for a negative index', () => {
    const list = ['a', 'b', 'c'];
    expect(moveDown(list, -1)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for an index beyond the end', () => {
    const list = ['a', 'b', 'c'];
    expect(moveDown(list, 99)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op on an empty list', () => {
    expect(moveDown([], 0)).toEqual([]);
  });
});

describe('removeAt', () => {
  it('removes the item at index', () => {
    expect(removeAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
  });

  it('is a no-op for a negative index', () => {
    expect(removeAt(['a', 'b'], -1)).toEqual(['a', 'b']);
  });

  it('is a no-op for an out-of-range index', () => {
    expect(removeAt(['a', 'b'], 2)).toEqual(['a', 'b']);
  });

  it('does not mutate the input', () => {
    const list = ['a', 'b', 'c'];
    removeAt(list, 0);
    expect(list).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op on an empty list', () => {
    expect(removeAt([], 0)).toEqual([]);
  });
});

describe('editAt', () => {
  it('replaces the item at index', () => {
    expect(editAt(['a', 'b', 'c'], 1, 'B')).toEqual(['a', 'B', 'c']);
  });

  it('is a no-op for a negative index', () => {
    expect(editAt(['a', 'b'], -1, 'X')).toEqual(['a', 'b']);
  });

  it('is a no-op for an out-of-range index', () => {
    expect(editAt(['a', 'b'], 2, 'X')).toEqual(['a', 'b']);
  });

  it('does not mutate the input', () => {
    const list = ['a', 'b'];
    editAt(list, 0, 'A');
    expect(list).toEqual(['a', 'b']);
  });
});

describe('insert', () => {
  it('inserts before the given index', () => {
    expect(insert(['a', 'c'], 1, 'b')).toEqual(['a', 'b', 'c']);
  });

  it('inserts at the front for index 0', () => {
    expect(insert(['b', 'c'], 0, 'a')).toEqual(['a', 'b', 'c']);
  });

  it('appends when index equals list length', () => {
    expect(insert(['a', 'b'], 2, 'c')).toEqual(['a', 'b', 'c']);
  });

  it('clamps a negative index to the front rather than no-op', () => {
    expect(insert(['b', 'c'], -5, 'a')).toEqual(['a', 'b', 'c']);
  });

  it('clamps an index beyond the end to append rather than no-op', () => {
    expect(insert(['a', 'b'], 99, 'c')).toEqual(['a', 'b', 'c']);
  });

  it('inserts into an empty list', () => {
    expect(insert([], 0, 'a')).toEqual(['a']);
  });

  it('does not mutate the input', () => {
    const list = ['a', 'c'];
    insert(list, 1, 'b');
    expect(list).toEqual(['a', 'c']);
  });
});
