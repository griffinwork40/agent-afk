import { describe, expect, it } from 'vitest';
import { createBuiltinHandlers } from './index.js';
import { BUILTIN_TOOL_NAMES } from '../schemas.js';

describe('createBuiltinHandlers', () => {
  it('returns a Map with all 22 built-in tools', () => {
    const handlers = createBuiltinHandlers();
    expect(handlers.size).toBe(23);
  });

  it('has an entry for every tool in BUILTIN_TOOL_NAMES', () => {
    const handlers = createBuiltinHandlers();
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(handlers.has(name), `missing handler for "${name}"`).toBe(true);
      expect(typeof handlers.get(name)).toBe('function');
    }
  });

  it('does not include the agent stub', () => {
    const handlers = createBuiltinHandlers();
    expect(handlers.has('agent')).toBe(false);
  });


  it('cwd parameter: returns a Map even when only cwd is supplied (no permissionMode)', () => {
    // Regression guard: the wiring uses createBashHandler('default', cwd)
    // when permissionMode is undefined but cwd is set. Ensure we get a
    // valid map back and bash is still callable.
    const handlers = createBuiltinHandlers(undefined, '/tmp');
    expect(handlers.size).toBe(23);
    expect(typeof handlers.get('bash')).toBe('function');
    expect(typeof handlers.get('grep')).toBe('function');
    expect(typeof handlers.get('glob')).toBe('function');
  });

  it('cwd parameter: builds handler set with both permissionMode and cwd', () => {
    const handlers = createBuiltinHandlers('default', '/tmp');
    expect(handlers.size).toBe(23);
    expect(typeof handlers.get('bash')).toBe('function');
  });

  it('registers all five browser-control handlers', () => {
    const handlers = createBuiltinHandlers();
    for (const name of [
      'browser_open',
      'browser_observe',
      'browser_act',
      'browser_screenshot',
      'browser_close',
    ]) {
      expect(handlers.has(name), `missing browser handler "${name}"`).toBe(true);
      expect(typeof handlers.get(name)).toBe('function');
    }
  });
});
