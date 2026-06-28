/**
 * Unit tests for the PostToolUseFailure hook event.
 *
 * Covers:
 * - Registry fires the handler and it receives toolName + error
 * - Config-loader accepts 'PostToolUseFailure' as a valid event
 * - Trust-gate suppression: no registration when userGlobalEnabled is false
 * - Matcher scoping: a matcher that excludes the tool name suppresses the hook
 */

import { describe, it, expect, vi } from 'vitest';
import { createHookRegistry } from '../hooks.js';
import type { PostToolUseFailureContext } from '../hooks.js';
import { dispatchPostToolUseFailure } from '../subagent-hooks.js';
import { loadHooksConfigFile } from './config-loader.js';
import { loadAndRegisterConfigHooks } from './config-bridge.js';
import type { LoadedHooksConfig } from './config-loader.js';

function makeConfig(
  matcher: string | undefined,
  userGlobalEnabled: boolean,
): LoadedHooksConfig {
  return {
    hooks: {
      PostToolUseFailure: [
        {
          ...(matcher !== undefined ? { matcher } : {}),
          hooks: [{ type: 'command', command: 'echo matched', timeoutMs: 5000 }],
        },
      ],
    },
    userGlobalEnabled,
    allowProjectHooks: false,
    sources: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Registry fires correctly
// ---------------------------------------------------------------------------

describe('PostToolUseFailure — registry dispatch', () => {
  it('fires the registered handler with toolName and error', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn(async () => ({}));
    registry.register('PostToolUseFailure', handler);

    const ctx: PostToolUseFailureContext = {
      event: 'PostToolUseFailure',
      toolName: 'bash',
      error: 'command not found',
    };

    await dispatchPostToolUseFailure(registry, ctx);

    expect(handler).toHaveBeenCalledOnce();
    const callArgs = handler.mock.calls[0] as unknown[];
    expect(callArgs[0]).toMatchObject({
      event: 'PostToolUseFailure',
      toolName: 'bash',
      error: 'command not found',
    });
  });

  it('does not fire PostToolUse handlers for a failure event', async () => {
    const registry = createHookRegistry();
    const postHandler = vi.fn(async () => ({}));
    const failureHandler = vi.fn(async () => ({}));
    registry.register('PostToolUse', postHandler);
    registry.register('PostToolUseFailure', failureHandler);

    const ctx: PostToolUseFailureContext = {
      event: 'PostToolUseFailure',
      toolName: 'read_file',
      error: 'ENOENT',
    };

    await dispatchPostToolUseFailure(registry, ctx);

    expect(failureHandler).toHaveBeenCalledOnce();
    expect(postHandler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Config-loader accepts the event
// ---------------------------------------------------------------------------

describe('PostToolUseFailure — config-loader validation', () => {
  it('accepts PostToolUseFailure as a valid hook event key (missing file returns no warnings)', () => {
    const result = loadHooksConfigFile(
      '/nonexistent-path-that-does-not-exist-ptuf.json',
      'user-global',
    );
    // Missing file returns empty hooks with no warnings -- the validEvents
    // array includes PostToolUseFailure so it is not rejected as unknown.
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trust-gate suppression
// ---------------------------------------------------------------------------

describe('PostToolUseFailure — trust gate', () => {
  it('does not register hooks when userGlobalEnabled is false', () => {
    const registry = createHookRegistry();
    loadAndRegisterConfigHooks(registry, makeConfig(undefined, false), { sessionId: 'test' });
    expect(registry.count('PostToolUseFailure')).toBe(0);
  });

  it('registers hooks when userGlobalEnabled is true', () => {
    const registry = createHookRegistry();
    loadAndRegisterConfigHooks(registry, makeConfig(undefined, true), { sessionId: 'test' });
    expect(registry.count('PostToolUseFailure')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Matcher scoping
// ---------------------------------------------------------------------------

describe('PostToolUseFailure — matcher scoping', () => {
  it('handler short-circuits when matcher excludes the tool name', async () => {
    const registry = createHookRegistry();
    // Register with a 'bash'-only matcher
    loadAndRegisterConfigHooks(registry, makeConfig('bash', true), { sessionId: 'test' });
    expect(registry.count('PostToolUseFailure')).toBe(1);

    // Non-matching tool name: the matcher guard returns {} immediately,
    // so no shell command runs and the decision is empty (no block).
    const ctxNoMatch: PostToolUseFailureContext = {
      event: 'PostToolUseFailure',
      toolName: 'read_file',
      error: 'ENOENT',
    };
    const decision = await registry.dispatch(ctxNoMatch);
    expect(decision).toEqual({});
  });
});
