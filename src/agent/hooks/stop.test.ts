/**
 * Tests for the Stop harness hook event.
 *
 * Covers:
 * - Registry fires Stop and handler receives the StopContext
 * - config-loader accepts 'Stop' in a hooks config file
 * - Trust-gate suppression when shell hooks are disabled
 */

import { describe, it, expect, vi } from 'vitest';
import { createHookRegistry } from '../hooks.js';
import type { StopContext, HookHandler } from '../hooks.js';
import { loadHooksConfigFile } from './config-loader.js';
import { loadAndRegisterConfigHooks } from './config-bridge.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Registry fires Stop
// ---------------------------------------------------------------------------

describe('Stop hook -- registry dispatch', () => {
  it('fires a registered Stop handler with the correct StopContext', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn<HookHandler>(async () => ({}));
    registry.register('Stop', handler);

    const ctx: StopContext = { event: 'Stop', sessionId: 'sess-42' };
    await registry.dispatch(ctx);

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0]?.[0] as StopContext;
    expect(received.event).toBe('Stop');
    expect(received.sessionId).toBe('sess-42');
  });

  it('count reflects a registered Stop handler', () => {
    const registry = createHookRegistry();
    expect(registry.count('Stop')).toBe(0);
    registry.register('Stop', async () => ({}));
    expect(registry.count('Stop')).toBe(1);
  });

  it('unsubscribe removes the Stop handler', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn<HookHandler>(async () => ({}));
    const unsub = registry.register('Stop', handler);
    unsub();
    await registry.dispatch({ event: 'Stop', sessionId: 's-1' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('Stop handler receives parentSessionId when provided', async () => {
    const registry = createHookRegistry();
    const received: StopContext[] = [];
    registry.register('Stop', async (ctx) => {
      received.push(ctx as StopContext);
      return {};
    });

    await registry.dispatch({
      event: 'Stop',
      sessionId: 'child',
      parentSessionId: 'parent',
    });

    expect(received[0]?.parentSessionId).toBe('parent');
  });
});

// ---------------------------------------------------------------------------
// config-loader accepts 'Stop'
// ---------------------------------------------------------------------------

describe('Stop hook -- config-loader', () => {
  it('loadHooksConfigFile parses a Stop hook entry without warnings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-hook-loader-'));
    const cfgPath = join(dir, 'afk.config.json');
    try {
      writeFileSync(
        cfgPath,
        JSON.stringify({
          enableShellHooks: true,
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'echo stop' }] },
            ],
          },
        }),
      );

      const result = loadHooksConfigFile(cfgPath, 'user-global');
      expect(result.warnings).toHaveLength(0);
      expect(result.hooks['Stop']).toBeDefined();
      expect(result.hooks['Stop']?.[0]?.hooks[0]?.command).toBe('echo stop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Trust-gate suppression
// ---------------------------------------------------------------------------

describe('Stop hook -- trust-gate suppression', () => {
  it('does not register Stop handlers when userGlobalEnabled is false', () => {
    const registry = createHookRegistry();
    const hookConfig = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command' as const, command: 'echo blocked', timeoutMs: 5000 }],
            tier: 'user-global' as const,
          },
        ],
      },
      userGlobalEnabled: false,
      allowProjectHooks: false,
      sources: [],
      warnings: [],
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadAndRegisterConfigHooks(registry, hookConfig, {});
    warnSpy.mockRestore();

    expect(registry.count('Stop')).toBe(0);
  });

  it('registers Stop handlers when userGlobalEnabled is true', () => {
    const registry = createHookRegistry();
    const hookConfig = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command' as const, command: 'echo stop', timeoutMs: 5000 }],
            tier: 'user-global' as const,
          },
        ],
      },
      userGlobalEnabled: true,
      allowProjectHooks: false,
      sources: [],
      warnings: [],
    };

    loadAndRegisterConfigHooks(registry, hookConfig, {});
    expect(registry.count('Stop')).toBe(1);
  });
});
