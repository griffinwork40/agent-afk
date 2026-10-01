/**
 * Tests for bash tool detach contract (#2542).
 *
 * Verifies:
 *  - Normal execution is unchanged when no detachRegistry is provided.
 *  - When a detachRegistry is present and detachAll() fires BEFORE the
 *    command completes, the handler returns the detach placeholder result
 *    and the process keeps running.
 *  - deliver() is called with the real output once the process finishes.
 *  - When detachAll() fires AFTER the command has already completed (race),
 *    the command result is returned normally (settle() guard wins).
 *
 * NOTE: These tests spawn real shell processes (fast echo/sleep commands).
 * They are designed to run quickly and use short timeouts.
 *
 * @module agent/tools/handlers/bash.detach.test
 */

import { describe, expect, it } from 'vitest';
import { createBashHandler } from './bash.js';
import { DetachableToolRegistry, type DetachedToolResult } from '../detach-registry.js';
import type { ToolHandlerContext } from '../types.js';

function makeContext(
  detachRegistry: DetachableToolRegistry,
  toolUseId: string,
): ToolHandlerContext {
  return { detachRegistry, toolUseId };
}

describe('bash detach contract (#2542)', () => {
  it('normal execution is unchanged when no detachRegistry is provided', async () => {
    const handler = createBashHandler('default');
    const signal = new AbortController().signal;
    const result = await handler({ command: 'echo hello' }, signal);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello');
  });

  it('returns detach placeholder when detachAll() fires before the command completes', async () => {
    const handler = createBashHandler('default');
    const registry = new DetachableToolRegistry();
    const signal = new AbortController().signal;

    const context = makeContext(registry, 'call-1');

    // Start a slow command, then immediately detach before it finishes
    const handlerPromise = handler(
      { command: 'sleep 5 && echo done', timeout_ms: 10000 },
      signal,
      context,
    );

    // Give the process a moment to spawn, then fire detachAll
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    registry.detachAll();

    const result = await handlerPromise;

    // Handler must return the detach placeholder (not an error, not the real output)
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('detached');
    const parsed = JSON.parse(result.content as string) as { status: string };
    expect(parsed.status).toBe('detached');
  });

  it('deliver() receives the real output once the detached process finishes', async () => {
    const handler = createBashHandler('default');
    const registry = new DetachableToolRegistry();
    const signal = new AbortController().signal;
    const context = makeContext(registry, 'call-2');

    const deliveredResults: DetachedToolResult[] = [];
    registry.on('settled', (r: DetachedToolResult) => deliveredResults.push(r));

    // Use a short sleep so the test doesn't take long
    const handlerPromise = handler(
      { command: 'sleep 0.1 && echo detached-output', timeout_ms: 5000 },
      signal,
      context,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    registry.detachAll();

    // Handler returns immediately with placeholder
    const result = await handlerPromise;
    const parsed = JSON.parse(result.content as string) as { status: string };
    expect(parsed.status).toBe('detached');

    // Wait for the process to finish and deliver
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    expect(deliveredResults).toHaveLength(1);
    expect(deliveredResults[0]!.output).toContain('detached-output');
    expect(deliveredResults[0]!.status).toBe('completed');
    expect(deliveredResults[0]!.toolUseId).toBe('call-2');
  });

  it('returns normal result when command completes before detachAll() fires (race)', async () => {
    const handler = createBashHandler('default');
    const registry = new DetachableToolRegistry();
    const signal = new AbortController().signal;
    const context = makeContext(registry, 'call-3');

    // Command completes very quickly
    const result = await handler(
      { command: 'echo fast', timeout_ms: 5000 },
      signal,
      context,
    );

    // Fire detachAll after handler has already returned
    registry.detachAll();

    // Should be normal success result, not a detach placeholder
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('fast');
    // Not a detach placeholder
    try {
      const parsed = JSON.parse(result.content as string) as { status?: string };
      expect(parsed.status).not.toBe('detached');
    } catch {
      // Not JSON — definitely not a detach placeholder
    }
  });
});
