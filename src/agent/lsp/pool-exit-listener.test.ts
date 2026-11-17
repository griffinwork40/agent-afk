import { describe, expect, it } from 'vitest';
import { getLspPool } from './pool.js';

describe('LSP pool exit cleanup', () => {
  it('leaves hard-exit cleanup to the spawn-time guardian without a duplicate listener', () => {
    const before = process.listeners('exit');
    const pool = getLspPool();
    expect(getLspPool()).toBe(pool);
    expect(process.listeners('exit')).toEqual(before);
  });
});
