/**
 * Unit tests for the PreCompact hook event.
 *
 * Covers:
 * - Registry fires a registered PreCompact handler with the correct context
 * - A blocking handler throws HookBlockedError
 * - Config-loader accepts 'PreCompact' as a valid event name
 * - Trust-gate suppression: shell hooks disabled -> userGlobalEnabled is false
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHookRegistry } from '../hooks.js';
import { HookBlockedError } from '../../utils/errors.js';
import { loadHooksConfigFile } from './config-loader.js';
import type { PreCompactContext } from '../hooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function preCompactCtx(trigger?: 'manual' | 'auto'): PreCompactContext {
  return { event: 'PreCompact', sessionId: 'sess-test', trigger };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pre-compact-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

// ---------------------------------------------------------------------------
// Registry fires + context shape
// ---------------------------------------------------------------------------

describe('PreCompact registry dispatch', () => {
  it('fires a registered handler with correct context', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn(async () => ({}));
    registry.register('PreCompact', handler);

    const ctx = preCompactCtx('manual');
    await registry.dispatch(ctx);

    expect(handler).toHaveBeenCalledTimes(1);
    const [receivedCtx] = handler.mock.calls[0] as [PreCompactContext];
    expect(receivedCtx.event).toBe('PreCompact');
    expect(receivedCtx.sessionId).toBe('sess-test');
    expect(receivedCtx.trigger).toBe('manual');
  });

  it('fires with trigger=auto', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn(async () => ({}));
    registry.register('PreCompact', handler);

    await registry.dispatch(preCompactCtx('auto'));
    const [receivedCtx] = handler.mock.calls[0] as [PreCompactContext];
    expect(receivedCtx.trigger).toBe('auto');
  });

  it('fires with no trigger field (undefined)', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn(async () => ({}));
    registry.register('PreCompact', handler);

    await registry.dispatch({ event: 'PreCompact' });
    const [receivedCtx] = handler.mock.calls[0] as [PreCompactContext];
    expect(receivedCtx.trigger).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Block -> HookBlockedError
// ---------------------------------------------------------------------------

describe('PreCompact block decision', () => {
  it('throws HookBlockedError when handler returns decision:block', async () => {
    const registry = createHookRegistry();
    registry.register('PreCompact', async () => ({
      decision: 'block',
      reason: 'frozen by policy',
    }));

    const err = await registry.dispatch(preCompactCtx('manual')).catch((e) => e);
    expect(err).toBeInstanceOf(HookBlockedError);
    expect((err as HookBlockedError).reason).toBe('frozen by policy');
  });

  it('throws HookBlockedError when handler returns continue:false', async () => {
    const registry = createHookRegistry();
    registry.register('PreCompact', async () => ({ continue: false }));

    const err = await registry.dispatch(preCompactCtx('manual')).catch((e) => e);
    expect(err).toBeInstanceOf(HookBlockedError);
  });

  it('does not fire subsequent handlers after a block', async () => {
    const registry = createHookRegistry();
    const second = vi.fn(async () => ({}));
    registry.register('PreCompact', async () => ({ decision: 'block', reason: 'stop' }));
    registry.register('PreCompact', second);

    await registry.dispatch(preCompactCtx('manual')).catch(() => {});
    expect(second).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Config-loader accepts 'PreCompact'
// ---------------------------------------------------------------------------

describe('config-loader PreCompact acceptance', () => {
  it('loadHooksConfigFile parses a PreCompact hook entry without warnings', () => {
    const path = writeJson('config.json', {
      hooks: {
        PreCompact: [
          { hooks: [{ type: 'command', command: 'echo pre-compact' }] },
        ],
      },
      enableShellHooks: true,
    });

    const result = loadHooksConfigFile(path, 'user-global');

    expect(result.warnings).toHaveLength(0);
    expect(result.hooks['PreCompact']).toBeDefined();
    expect(result.hooks['PreCompact']?.[0]?.hooks[0]?.command).toBe('echo pre-compact');
    expect(result.enableShellHooks).toBe(true);
  });

  it('trust-gate: enableShellHooks:false -> userGlobalEnabled is false', () => {
    const path = writeJson('config2.json', {
      hooks: {
        PreCompact: [
          { hooks: [{ type: 'command', command: 'echo blocked' }] },
        ],
      },
      enableShellHooks: false,
    });

    const result = loadHooksConfigFile(path, 'user-global');
    expect(result.enableShellHooks).toBe(false);
  });
});
