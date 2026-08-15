/**
 * Tests for PreToolUse injectContext support (block path).
 *
 * When a PreToolUse handler blocks AND sets injectContext, the
 * HookBlockedError thrown by hook-registry must carry that text so
 * dispatcher.ts can append it to the isError tool_result content.
 */

import { describe, expect, it } from 'vitest';
import { createHookRegistryImpl } from '../hook-registry.js';
import { dispatchPreToolUse } from '../subagent-hooks.js';
import { HookBlockedError } from '../../utils/errors.js';
import type { HookDecision } from '../hooks.js';

const preCtx = {
  event: 'PreToolUse' as const,
  toolName: 'bash',
  input: { command: 'rm -rf /' },
};

describe('PreToolUse injectContext — block path', () => {
  it('HookBlockedError carries injectContext when handler blocks with it', async () => {
    const registry = createHookRegistryImpl();
    registry.register('PreToolUse', async () => ({
      decision: 'block' as const,
      reason: 'destructive command',
      injectContext: 'Use a safer alternative instead.',
    }));

    let caught: HookBlockedError | undefined;
    try {
      await registry.dispatch(preCtx);
    } catch (err) {
      if (err instanceof HookBlockedError) caught = err;
    }

    expect(caught).toBeInstanceOf(HookBlockedError);
    expect(caught?.injectContext).toBe('Use a safer alternative instead.');
    expect(caught?.reason).toBe('destructive command');
  });

  it('HookBlockedError has no injectContext when handler blocks without it', async () => {
    const registry = createHookRegistryImpl();
    registry.register('PreToolUse', async () => ({
      decision: 'block' as const,
      reason: 'not allowed',
    }));

    let caught: HookBlockedError | undefined;
    try {
      await registry.dispatch(preCtx);
    } catch (err) {
      if (err instanceof HookBlockedError) caught = err;
    }

    expect(caught).toBeInstanceOf(HookBlockedError);
    expect(caught?.injectContext).toBeUndefined();
  });

  it('dispatchPreToolUse returns HookDecision on approve', async () => {
    const registry = createHookRegistryImpl();
    registry.register('PreToolUse', async () => ({
      decision: 'approve' as const,
    }));

    const result: HookDecision = await dispatchPreToolUse(registry, preCtx);
    expect(result).toMatchObject({ decision: 'approve' });
  });

  it('dispatchPreToolUse returns empty decision when no registry', async () => {
    const result: HookDecision = await dispatchPreToolUse(undefined, preCtx);
    expect(result).toEqual({});
  });

  it('dispatchPreToolUse re-throws HookBlockedError on block', async () => {
    const registry = createHookRegistryImpl();
    registry.register('PreToolUse', async () => ({
      decision: 'block' as const,
      reason: 'blocked',
      injectContext: 'explanation',
    }));

    await expect(dispatchPreToolUse(registry, preCtx)).rejects.toBeInstanceOf(HookBlockedError);
  });
});
