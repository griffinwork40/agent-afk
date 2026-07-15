/**
 * Unit tests for dispatchSessionStart's injectContext return contract.
 *
 * SessionStart fires during init before any turn exists, so its injectContext
 * cannot be delivered inline; dispatchSessionStart returns the merged string
 * and AgentSession queues it for the first user message (see
 * framework-context-queue.test.ts for the end-to-end delivery test).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

import { createHookRegistry } from '../hooks.js';
import { HookBlockedError } from '../../utils/errors.js';
import { dispatchSessionStart } from './hooks-dispatch.js';

describe('dispatchSessionStart injectContext return', () => {
  it('returns undefined when no registry is provided', async () => {
    expect(await dispatchSessionStart(undefined, { event: 'SessionStart' })).toBeUndefined();
  });

  it('returns undefined when no handler injects context', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => ({}));
    expect(await dispatchSessionStart(registry, { event: 'SessionStart' })).toBeUndefined();
  });

  it('returns a single handler injectContext value', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => ({ injectContext: 'hello' }));
    expect(await dispatchSessionStart(registry, { event: 'SessionStart' })).toBe('hello');
  });

  it('returns the merged injectContext across multiple handlers', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => ({ injectContext: 'one' }));
    registry.register('SessionStart', () => ({ injectContext: 'two' }));
    // Registry concatenates non-blocking handlers' injectContext, joined by '\n'.
    expect(await dispatchSessionStart(registry, { event: 'SessionStart' })).toBe('one\ntwo');
  });

  it('throws HookBlockedError when a handler blocks', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => ({ decision: 'block', reason: 'nope' }));
    await expect(
      dispatchSessionStart(registry, { event: 'SessionStart' }),
    ).rejects.toBeInstanceOf(HookBlockedError);
  });
});
