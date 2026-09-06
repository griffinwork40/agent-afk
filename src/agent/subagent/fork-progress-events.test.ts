/**
 * Unit tests for wireProgressEvents: the opt-in wiring that injects the
 * emit_progress custom tool into a child's AgentConfig.
 *
 * Covers the four cases the review identified as untested:
 *   (a) disabled path leaves config.customTools unchanged
 *   (b) enabled path appends a tool named emit_progress
 *   (c) returned bindProgressHandle sets the ref so handler succeeds
 *   (d) calling handler before bindProgressHandle returns not-initialized error
 */

import { describe, it, expect } from 'vitest';
import { wireProgressEvents } from './fork-progress-events.js';
import type { AgentConfig } from '../types.js';

/**
 * Build a minimal AgentConfig stub with only the fields wireProgressEvents
 * reads and mutates (customTools).
 */
function makeConfig(customTools?: AgentConfig['customTools']): AgentConfig {
  return { customTools } as unknown as AgentConfig;
}

/** Minimal handle double matching the SubagentHandleImpl surface emit_progress uses. */
function makeHandleDouble() {
  const _progressEvents: Array<{ message: string }> = [];
  return {
    id: 'test-handle',
    _currentStatus: 'running' as const,
    _progressEvents,
    emitProgress(payload: { message: string }): void {
      if (
        this._currentStatus === 'succeeded' ||
        this._currentStatus === 'failed' ||
        this._currentStatus === 'cancelled'
      ) {
        return;
      }
      _progressEvents.push(payload);
    },
  } as Parameters<ReturnType<typeof wireProgressEvents>>[0];
}

describe('wireProgressEvents', () => {
  // (a) Disabled path
  it('returns a no-op bindHandle and does not modify config when enabled is falsy', () => {
    const config = makeConfig();
    const bindHandle = wireProgressEvents(config, false, undefined, undefined);
    expect(config.customTools).toBeUndefined();
    // bindHandle is a no-op — calling it should not throw
    bindHandle(makeHandleDouble());
  });

  it('returns a no-op bindHandle when enabled is undefined', () => {
    const config = makeConfig();
    const bindHandle = wireProgressEvents(config, undefined, undefined, undefined);
    expect(config.customTools).toBeUndefined();
    bindHandle(makeHandleDouble());
  });

  it('preserves existing customTools when disabled', () => {
    const existingTool = { schema: { name: 'existing' } } as AgentConfig['customTools'] extends (infer T)[] | undefined ? T : never;
    const config = makeConfig([existingTool]);
    wireProgressEvents(config, false, undefined, undefined);
    expect(config.customTools).toHaveLength(1);
    expect(config.customTools![0]).toBe(existingTool);
  });

  // (b) Enabled path appends emit_progress
  it('appends an emit_progress tool to config.customTools when enabled', () => {
    const config = makeConfig();
    wireProgressEvents(config, true, undefined, undefined);
    expect(config.customTools).toHaveLength(1);
    expect(config.customTools![0]!.schema.name).toBe('emit_progress');
  });

  it('preserves existing customTools and appends emit_progress', () => {
    const existingTool = { schema: { name: 'existing' } } as AgentConfig['customTools'] extends (infer T)[] | undefined ? T : never;
    const config = makeConfig([existingTool]);
    wireProgressEvents(config, true, undefined, undefined);
    expect(config.customTools).toHaveLength(2);
    expect(config.customTools![0]!.schema.name).toBe('existing');
    expect(config.customTools![1]!.schema.name).toBe('emit_progress');
  });

  // (c) bindProgressHandle sets ref so handler succeeds
  it('returns { delivered: true } after bindProgressHandle is called', async () => {
    const queueCalls: string[] = [];
    const parentRef = {
      pushUserMessage: () => {},
      queueFrameworkContext: (text: string) => { queueCalls.push(text); },
    };
    const config = makeConfig();
    const bindHandle = wireProgressEvents(config, true, parentRef, undefined);
    const handle = makeHandleDouble();
    bindHandle(handle);

    // Invoke the tool handler directly
    const toolDef = config.customTools![0]!;
    const result = await toolDef.handler({ message: 'test progress' }, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content as string)).toEqual({ delivered: true });
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]).toContain('<child-progress');
  });

  // (d) Handler before bindProgressHandle returns not-initialized error
  it('returns isError when handler is called before bindProgressHandle', async () => {
    const config = makeConfig();
    wireProgressEvents(config, true, undefined, undefined);
    const toolDef = config.customTools![0]!;
    const result = await toolDef.handler({ message: 'too early' }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('handle not yet initialized');
  });
});
