/**
 * Unit tests for the UserPromptSubmit hook event.
 *
 * Covers:
 * - Handler receives correct prompt + sessionId from dispatched context
 * - Blocking handler causes registry to throw HookBlockedError with correct reason
 * - Handler returning injectContext is reflected in the dispatch result
 * - Config-loader: UserPromptSubmit group populates hooks result
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHookRegistry } from '../hooks.js';
import type { UserPromptSubmitContext } from '../hooks.js';
import { HookBlockedError } from '../../utils/errors.js';
import { loadHooksConfigFile } from './config-loader.js';

// ---------------------------------------------------------------------------
// Registry dispatch tests
// ---------------------------------------------------------------------------

describe('UserPromptSubmit — registry dispatch', () => {
  it('dispatches UserPromptSubmit and handler receives correct prompt and sessionId', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn(async () => ({}));
    registry.register('UserPromptSubmit', handler);

    const ctx: UserPromptSubmitContext = {
      event: 'UserPromptSubmit',
      prompt: 'explain recursion',
      sessionId: 'sess-1',
    };

    await registry.dispatch(ctx);

    expect(handler).toHaveBeenCalledOnce();
    const [calledCtx] = handler.mock.calls[0]!;
    expect((calledCtx as UserPromptSubmitContext).prompt).toBe('explain recursion');
    expect((calledCtx as UserPromptSubmitContext).sessionId).toBe('sess-1');
  });

  it('dispatches UserPromptSubmit without sessionId (early turns)', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn(async () => ({}));
    registry.register('UserPromptSubmit', handler);

    const ctx: UserPromptSubmitContext = {
      event: 'UserPromptSubmit',
      prompt: 'first prompt',
    };

    await registry.dispatch(ctx);

    expect(handler).toHaveBeenCalledOnce();
    const [calledCtx] = handler.mock.calls[0]!;
    expect((calledCtx as UserPromptSubmitContext).sessionId).toBeUndefined();
  });

  it('blocking handler causes registry to throw HookBlockedError with correct reason', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({
      decision: 'block' as const,
      reason: 'blocked by policy',
    }));

    const ctx: UserPromptSubmitContext = {
      event: 'UserPromptSubmit',
      prompt: 'dangerous prompt',
    };

    await expect(registry.dispatch(ctx)).rejects.toBeInstanceOf(HookBlockedError);
    await expect(registry.dispatch(ctx)).rejects.toMatchObject({
      reason: 'blocked by policy',
    });
  });

  it('handler returning injectContext is reflected in dispatch result', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({
      injectContext: '[SYSTEM NOTE] Always be helpful.\n',
    }));

    const ctx: UserPromptSubmitContext = {
      event: 'UserPromptSubmit',
      prompt: 'what is 2+2',
    };

    const decision = await registry.dispatch(ctx);
    expect(decision.injectContext).toBe('[SYSTEM NOTE] Always be helpful.\n');
  });

  it('handler that returns empty object does not inject context (false branch covered)', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({}));

    const ctx: UserPromptSubmitContext = {
      event: 'UserPromptSubmit',
      prompt: 'plain prompt',
    };

    const decision = await registry.dispatch(ctx);
    expect(decision.injectContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Config-loader trust gate
// ---------------------------------------------------------------------------

describe('UserPromptSubmit — config-loader', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ups-config-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeJson(name: string, body: unknown): string {
    const path = join(tmp, name);
    writeFileSync(path, JSON.stringify(body), 'utf-8');
    return path;
  }

  it('UserPromptSubmit group populates hooks result', () => {
    const path = writeJson('config.json', {
      enableShellHooks: true,
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'echo ups', timeout_ms: 3000 }] },
        ],
      },
    });

    const result = loadHooksConfigFile(path, 'user-global');
    expect(result.warnings).toEqual([]);
    expect(result.hooks.UserPromptSubmit).toHaveLength(1);
    expect(result.hooks.UserPromptSubmit![0]!.hooks[0]!.command).toBe('echo ups');
    expect(result.hooks.UserPromptSubmit![0]!.hooks[0]!.timeoutMs).toBe(3000);
  });

  it('UserPromptSubmit group is ignored alongside other events when disabled', () => {
    const path = writeJson('config.json', {
      enableShellHooks: false,
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'echo ups' }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo start' }] },
        ],
      },
    });

    // loadHooksConfigFile still parses both (enableShellHooks is a trust gate
    // for config-bridge, not config-loader — the loader always parses all
    // events; the bridge decides whether to register shell handlers).
    const result = loadHooksConfigFile(path, 'user-global');
    expect(result.enableShellHooks).toBe(false);
    // Both event groups are parsed regardless of enableShellHooks.
    expect(result.hooks.UserPromptSubmit).toHaveLength(1);
    expect(result.hooks.SessionStart).toHaveLength(1);
  });
});
