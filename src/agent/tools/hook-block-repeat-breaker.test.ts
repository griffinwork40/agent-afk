/**
 * Tests for the hook-block repeat circuit breaker (#3736).
 *
 * Coverage:
 *   - Pure helpers: gateKey, recordHookBlock, resetHookBlockRepeat, message builders.
 *   - Dispatcher integration: fork trip, top-level escalation, reset-on-success,
 *     distinct keys do not trip, below-threshold stays hook-block, session_phase emission.
 *
 * @module agent/tools/hook-block-repeat-breaker.test
 */

import { describe, expect, it } from 'vitest';
import { SessionToolDispatcher } from './dispatcher.js';
import { builtinToolSchemas } from './schemas.js';
import type { ToolCall, ToolHandler } from './types.js';
import { createHookRegistry } from '../hook-registry.js';
import type { HookRegistry } from '../hooks.js';
import {
  HOOK_BLOCK_REPEAT_THRESHOLD,
  HOOK_BLOCK_REPEAT_FAILURE_CLASS,
  gateKey,
  recordHookBlock,
  resetHookBlockRepeat,
  buildHookBlockRepeatMessage,
  buildHookBlockRepeatEscalation,
  type HookBlockRepeatState,
} from './hook-block-repeat-breaker.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('hook-block-repeat-breaker pure helpers', () => {
  it('HOOK_BLOCK_REPEAT_THRESHOLD is a small positive constant', () => {
    expect(HOOK_BLOCK_REPEAT_THRESHOLD).toBeGreaterThan(0);
    expect(HOOK_BLOCK_REPEAT_THRESHOLD).toBeLessThanOrEqual(5);
  });

  it('HOOK_BLOCK_REPEAT_FAILURE_CLASS is a distinct tag', () => {
    expect(HOOK_BLOCK_REPEAT_FAILURE_CLASS).toBe('hook-block-repeat');
  });

  it('gateKey returns toolName (stable, never raw reason)', () => {
    expect(gateKey('bash')).toBe('bash');
    expect(gateKey('read_file')).toBe('read_file');
  });

  it('recordHookBlock: first call initialises count to 1', () => {
    const { state, count } = recordHookBlock(null, 'bash');
    expect(count).toBe(1);
    expect(state.key).toBe('bash');
    expect(state.count).toBe(1);
    expect(state.escalated).toBe(false);
  });

  it('recordHookBlock: same key increments count', () => {
    const { state: s1 } = recordHookBlock(null, 'bash');
    const { state: s2, count } = recordHookBlock(s1, 'bash');
    expect(count).toBe(2);
    expect(s2.count).toBe(2);
  });

  it('recordHookBlock: different tool key resets count to 1', () => {
    const { state: s1 } = recordHookBlock(null, 'bash');
    const { state: s2, count } = recordHookBlock(s1, 'read_file');
    expect(count).toBe(1);
    expect(s2.key).toBe('read_file');
  });

  it('resetHookBlockRepeat returns null', () => {
    expect(resetHookBlockRepeat()).toBeNull();
  });

  it('buildHookBlockRepeatMessage is loud and actionable', () => {
    const msg = buildHookBlockRepeatMessage('bash', 3);
    expect(msg).toContain('bash');
    expect(msg).toContain('3');
    expect(msg).toContain('Stop retrying');
    expect(msg).toContain('Blocked');
  });

  it('buildHookBlockRepeatEscalation references tool and count', () => {
    const msg = buildHookBlockRepeatEscalation('read_file', 3);
    expect(msg).toContain('read_file');
    expect(msg).toContain('3');
    expect(msg).toContain('Report Blocked');
  });
});

// ---------------------------------------------------------------------------
// Dispatcher integration helpers
// ---------------------------------------------------------------------------

const PARENT = 'parent-session-for-repeat-test';

/** Hook that blocks every call to any tool in blockTools, with a stable reason. */
function blockingHook(blockTools: ReadonlySet<string>, reason = 'Blocked by org policy'): HookRegistry {
  const registry = createHookRegistry();
  registry.register('PreToolUse', async (ctx) => {
    if (ctx.event === 'PreToolUse' && blockTools.has(ctx.toolName)) {
      return { decision: 'block' as const, reason };
    }
    return {};
  });
  return registry;
}

function echoHandler(): ToolHandler {
  return async (input: unknown) => ({ content: String((input as { message?: string }).message ?? 'ok') });
}

function bashHandler(): ToolHandler {
  return async () => ({ content: 'bash output' });
}

/** Fork dispatcher (parentSessionId set). */
function makeForkDispatcher(blockTools: ReadonlySet<string>): SessionToolDispatcher {
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([
      ['echo', echoHandler()],
      ['bash', bashHandler()],
    ]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: ['echo', 'bash', 'read_file'] },
    hookRegistry: blockingHook(blockTools),
    parentSessionId: PARENT,
  });
}

/** Top-level dispatcher (no parentSessionId). */
function makeTopLevelDispatcher(blockTools: ReadonlySet<string>): SessionToolDispatcher {
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([
      ['echo', echoHandler()],
      ['bash', bashHandler()],
    ]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: ['echo', 'bash'] },
    hookRegistry: blockingHook(blockTools),
  });
}

function bashCall(n: number): ToolCall {
  return {
    id: `bash-${n}`,
    name: 'bash',
    input: { command: `echo variant-${n}` },
    signal: new AbortController().signal,
  };
}

function echoCall(n: number): ToolCall {
  return {
    id: `echo-${n}`,
    name: 'echo',
    input: { message: `progress-${n}` },
    signal: new AbortController().signal,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher integration: fork path
// ---------------------------------------------------------------------------

describe('hook-block repeat breaker — fork dispatcher', () => {
  it('trips at exactly THRESHOLD with failureClass hook-block-repeat', async () => {
    const d = makeForkDispatcher(new Set(['bash']));

    // First THRESHOLD-1 blocks return ordinary hook-block
    for (let i = 1; i < HOOK_BLOCK_REPEAT_THRESHOLD; i++) {
      const r = await d.execute(bashCall(i));
      expect(r.isError).toBe(true);
      expect(r.failureClass).toBe('hook-block');
    }

    // THRESHOLDth block trips the breaker
    const trip = await d.execute(bashCall(HOOK_BLOCK_REPEAT_THRESHOLD));
    expect(trip.isError).toBe(true);
    expect(trip.failureClass).toBe(HOOK_BLOCK_REPEAT_FAILURE_CLASS);
    expect(trip.content).toContain('bash');
    expect(trip.content).toContain(String(HOOK_BLOCK_REPEAT_THRESHOLD));
  });

  it('below threshold — never trips', async () => {
    const d = makeForkDispatcher(new Set(['bash']));
    for (let i = 1; i < HOOK_BLOCK_REPEAT_THRESHOLD; i++) {
      const r = await d.execute(bashCall(i));
      expect(r.failureClass).toBe('hook-block');
    }
  });

  it('resets on any successful tool call (consecutive, not lifetime)', async () => {
    const d = makeForkDispatcher(new Set(['bash']));

    // THRESHOLD-1 blocks, then a success
    for (let i = 1; i < HOOK_BLOCK_REPEAT_THRESHOLD; i++) {
      await d.execute(bashCall(i));
    }
    const ok = await d.execute(echoCall(1));
    expect(ok.isError).toBeUndefined();

    // THRESHOLD-1 more blocks after reset — still no trip
    for (let i = 10; i < 10 + HOOK_BLOCK_REPEAT_THRESHOLD - 1; i++) {
      const r = await d.execute(bashCall(i));
      expect(r.failureClass).toBe('hook-block');
    }

    // THRESHOLDth consecutive block after reset trips
    const trip = await d.execute(bashCall(99));
    expect(trip.failureClass).toBe(HOOK_BLOCK_REPEAT_FAILURE_CLASS);
  });

  it('distinct tool keys do not accumulate toward each other', async () => {
    // Block both bash and echo; alternate between them.
    const d = makeForkDispatcher(new Set(['bash', 'echo']));
    // Alternate THRESHOLD*2 times — neither key reaches THRESHOLD consecutively
    for (let i = 0; i < HOOK_BLOCK_REPEAT_THRESHOLD * 2; i++) {
      const call = i % 2 === 0 ? bashCall(i) : echoCall(i);
      const r = await d.execute(call);
      expect(r.failureClass).toBe('hook-block');
    }
  });

  it('only the blocked tool trips — unblocked tool succeeds and resets', async () => {
    const d = makeForkDispatcher(new Set(['bash']));

    // Accumulate THRESHOLD-1 bash blocks
    for (let i = 0; i < HOOK_BLOCK_REPEAT_THRESHOLD - 1; i++) {
      await d.execute(bashCall(i));
    }
    // echo succeeds → resets
    const ok = await d.execute(echoCall(0));
    expect(ok.isError).toBeUndefined();
    // bash blocks again from 1
    const r = await d.execute(bashCall(100));
    expect(r.failureClass).toBe('hook-block'); // count=1 after reset
  });
});

// ---------------------------------------------------------------------------
// Dispatcher integration: top-level path
// ---------------------------------------------------------------------------

describe('hook-block repeat breaker — top-level dispatcher', () => {
  it('appends escalation message at threshold (does not upgrade failureClass)', async () => {
    const d = makeTopLevelDispatcher(new Set(['bash']));

    for (let i = 1; i < HOOK_BLOCK_REPEAT_THRESHOLD; i++) {
      const r = await d.execute(bashCall(i));
      expect(r.failureClass).toBe('hook-block');
      // No escalation yet
      expect(String(r.content)).not.toContain('Report Blocked');
    }

    const trip = await d.execute(bashCall(HOOK_BLOCK_REPEAT_THRESHOLD));
    expect(trip.failureClass).toBe('hook-block'); // NOT upgraded for top-level
    expect(String(trip.content)).toContain('Report Blocked');
  });

  it('escalation is appended only once', async () => {
    const d = makeTopLevelDispatcher(new Set(['bash']));

    for (let i = 0; i <= HOOK_BLOCK_REPEAT_THRESHOLD + 2; i++) {
      await d.execute(bashCall(i));
    }

    // Get the last result: content must contain "Report Blocked" at most once
    const last = await d.execute(bashCall(99));
    const content = String(last.content);
    const occurrences = (content.match(/Report Blocked/g) ?? []).length;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('resets on success — escalation not added before THRESHOLD after reset', async () => {
    const d = makeTopLevelDispatcher(new Set(['bash']));

    // Trip once
    for (let i = 0; i < HOOK_BLOCK_REPEAT_THRESHOLD; i++) {
      await d.execute(bashCall(i));
    }
    // Reset
    const ok = await d.execute(echoCall(0));
    expect(ok.isError).toBeUndefined();

    // THRESHOLD-1 blocks after reset — no escalation
    for (let i = 10; i < 10 + HOOK_BLOCK_REPEAT_THRESHOLD - 1; i++) {
      const r = await d.execute(bashCall(i));
      expect(r.failureClass).toBe('hook-block');
      expect(String(r.content)).not.toContain('Report Blocked');
    }
  });
});
