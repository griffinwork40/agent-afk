import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCodeBlock,
  getCodeBlocks,
  getCodeBlock,
  resetCodeBlockRegister,
  enableCodeBlockRegister,
  disableCodeBlockRegister,
} from './code-block-register.js';

beforeEach(() => {
  // Always start each test with a clean, disabled register.
  disableCodeBlockRegister();
  resetCodeBlockRegister();
});

describe('code-block-register', () => {
  it('starts empty', () => {
    enableCodeBlockRegister();
    expect(getCodeBlocks()).toHaveLength(0);
    expect(getCodeBlock(1)).toBeUndefined();
  });

  it('registers blocks with 1-based indices', () => {
    enableCodeBlockRegister();
    const i1 = registerCodeBlock('bash', 'echo hello');
    const i2 = registerCodeBlock('python', 'print("hi")');
    expect(i1).toBe(1);
    expect(i2).toBe(2);
    expect(getCodeBlocks()).toHaveLength(2);
  });

  it('retrieves blocks by 1-based index', () => {
    enableCodeBlockRegister();
    registerCodeBlock('bash', 'echo hello');
    registerCodeBlock('python', 'print("hi")');
    const block = getCodeBlock(2);
    expect(block).toEqual({ index: 2, lang: 'python', text: 'print("hi")' });
  });

  it('returns undefined for out-of-range index', () => {
    enableCodeBlockRegister();
    registerCodeBlock('bash', 'echo hello');
    expect(getCodeBlock(0)).toBeUndefined();
    expect(getCodeBlock(2)).toBeUndefined();
  });

  it('resets the register', () => {
    enableCodeBlockRegister();
    registerCodeBlock('bash', 'echo hello');
    registerCodeBlock('python', 'print("hi")');
    resetCodeBlockRegister();
    expect(getCodeBlocks()).toHaveLength(0);
    // New registrations start at 1 again.
    const i = registerCodeBlock('text', 'foo');
    expect(i).toBe(1);
  });

  // --- enabled flag tests (issue #1289) ---

  it('registerCodeBlock is a no-op when disabled (default)', () => {
    // Register is disabled in beforeEach — no enable() call here.
    const idx = registerCodeBlock('bash', 'echo hello');
    expect(idx).toBe(0);
    expect(getCodeBlocks()).toHaveLength(0);
    expect(getCodeBlock(1)).toBeUndefined();
  });

  it('registerCodeBlock works when enabled', () => {
    enableCodeBlockRegister();
    const idx = registerCodeBlock('bash', 'echo hello');
    expect(idx).toBe(1);
    expect(getCodeBlocks()).toHaveLength(1);
    expect(getCodeBlock(1)).toEqual({ index: 1, lang: 'bash', text: 'echo hello' });
  });

  it('disableCodeBlockRegister makes registerCodeBlock a no-op again', () => {
    enableCodeBlockRegister();
    registerCodeBlock('bash', 'echo first');
    disableCodeBlockRegister();
    const idx = registerCodeBlock('python', 'print("second")');
    // Should not have been registered.
    expect(idx).toBe(0);
    expect(getCodeBlocks()).toHaveLength(1);
    expect(getCodeBlock(2)).toBeUndefined();
  });

  it('resetCodeBlockRegister clears blocks regardless of enabled state', () => {
    enableCodeBlockRegister();
    registerCodeBlock('bash', 'echo hello');
    expect(getCodeBlocks()).toHaveLength(1);
    resetCodeBlockRegister();
    expect(getCodeBlocks()).toHaveLength(0);
  });

  it('enable is idempotent — calling it twice does not double-register', () => {
    enableCodeBlockRegister();
    enableCodeBlockRegister();
    registerCodeBlock('bash', 'echo hello');
    expect(getCodeBlocks()).toHaveLength(1);
  });
});
