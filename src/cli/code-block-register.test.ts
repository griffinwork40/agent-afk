import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCodeBlock,
  getCodeBlocks,
  getCodeBlock,
  resetCodeBlockRegister,
} from './code-block-register.js';

beforeEach(() => {
  resetCodeBlockRegister();
});

describe('code-block-register', () => {
  it('starts empty', () => {
    expect(getCodeBlocks()).toHaveLength(0);
    expect(getCodeBlock(1)).toBeUndefined();
  });

  it('registers blocks with 1-based indices', () => {
    const i1 = registerCodeBlock('bash', 'echo hello');
    const i2 = registerCodeBlock('python', 'print("hi")');
    expect(i1).toBe(1);
    expect(i2).toBe(2);
    expect(getCodeBlocks()).toHaveLength(2);
  });

  it('retrieves blocks by 1-based index', () => {
    registerCodeBlock('bash', 'echo hello');
    registerCodeBlock('python', 'print("hi")');
    const block = getCodeBlock(2);
    expect(block).toEqual({ index: 2, lang: 'python', text: 'print("hi")' });
  });

  it('returns undefined for out-of-range index', () => {
    registerCodeBlock('bash', 'echo hello');
    expect(getCodeBlock(0)).toBeUndefined();
    expect(getCodeBlock(2)).toBeUndefined();
  });

  it('resets the register', () => {
    registerCodeBlock('bash', 'echo hello');
    registerCodeBlock('python', 'print("hi")');
    resetCodeBlockRegister();
    expect(getCodeBlocks()).toHaveLength(0);
    // New registrations start at 1 again.
    const i = registerCodeBlock('text', 'foo');
    expect(i).toBe(1);
  });
});
