import { describe, expect, it, vi } from 'vitest';
import { operatorDispatcherToolDefs, withOperatorDeniedDispatcher } from './operator-denied-dispatcher.js';
import { parseToolsConfig } from '../../cli/config/json-tier-parse.tools.js';

const defs = [
  { name: 'bash', input_schema: { type: 'object' as const } },
  { name: 'read_file', input_schema: { type: 'object' as const } },
];

describe('external dispatcher operator guard', () => {
  it('filters the fallback catalog, rejects denied calls and preserves allowed routing', async () => {
    const execute = vi.fn(async () => ({ content: 'ok' }));
    const setResolveBase = vi.fn();
    const setAllowAll = vi.fn();
    const wrapped = withOperatorDeniedDispatcher({ execute, setResolveBase, setAllowAll } as never, { deniedTools: ['bash'] })!;
    expect(operatorDispatcherToolDefs(wrapped, defs)).toEqual([defs[1]]);
    expect((await wrapped.execute({ id: '1', name: 'bash', input: {}, signal: new AbortController().signal })).content).toContain('disabled by operator settings');
    expect(execute).not.toHaveBeenCalled();
    expect((await wrapped.execute({ id: '2', name: 'read_file', input: {}, signal: new AbortController().signal })).content).toBe('ok');
    wrapped.setResolveBase?.('/new');
    wrapped.setAllowAll?.(true);
    expect(setResolveBase).toHaveBeenCalledWith('/new');
    expect(setAllowAll).toHaveBeenCalledWith(true);
  });
  it('keeps every non-denied fallback entry, including get_runtime_state (regression)', () => {
    const fallback = [...defs, { name: 'get_runtime_state', input_schema: { type: 'object' as const } }];
    const wrapped = withOperatorDeniedDispatcher({ execute: async () => ({ content: 'ok' }) }, { deniedTools: ['bash'] })!;
    expect(operatorDispatcherToolDefs(wrapped, fallback).map((s) => s.name)).toEqual(['read_file', 'get_runtime_state']);
  });
  it('returns the fallback unchanged for an unguarded external dispatcher (pre-deny behaviour)', () => {
    const inner = { execute: async () => ({ content: 'ok' }) };
    expect(operatorDispatcherToolDefs(inner, defs)).toBe(defs);
  });
  it('does not wrap when no operator denies exist', () => {
    const inner = { execute: async () => ({ content: 'ok' }) };
    expect(withOperatorDeniedDispatcher(inner, undefined)).toBe(inner);
  });
  it('double-wrapping is idempotent (returns inner unchanged when already guarded)', () => {
    const inner = { execute: async () => ({ content: 'ok' }) };
    const first = withOperatorDeniedDispatcher(inner, { deniedTools: ['bash'] })!;
    const second = withOperatorDeniedDispatcher(first, { deniedTools: ['bash'] });
    expect(second).toBe(first);
  });
  it('same-set different-order is idempotent (order-independent set equality)', () => {
    const inner = { execute: async () => ({ content: 'ok' }) };
    const first = withOperatorDeniedDispatcher(inner, { deniedTools: ['bash', 'read_file'] })!;
    const second = withOperatorDeniedDispatcher(first, { deniedTools: ['read_file', 'bash'] });
    expect(second).toBe(first);
  });
  it('re-wrapping with a different deny list stores the union and filters/rejects both sets', async () => {
    const execute = vi.fn(async () => ({ content: 'ok' }));
    const inner = { execute };
    const signal = new AbortController().signal;

    // Wrap first with ['bash']
    const firstWrapped = withOperatorDeniedDispatcher(inner, { deniedTools: ['bash'] })!;
    // Re-wrap with ['read_file'] — should produce a new wrapper denying the union ['bash', 'read_file']
    const reWrapped = withOperatorDeniedDispatcher(firstWrapped, { deniedTools: ['read_file'] })!;

    // Must be a new object (not the original firstWrapped)
    expect(reWrapped).not.toBe(firstWrapped);

    // Catalog must advertise neither bash nor read_file
    const filtered = operatorDispatcherToolDefs(reWrapped, defs);
    expect(filtered.map((s) => s.name)).toEqual([]);

    // Execution must reject both denied tools
    const bashResult = await reWrapped.execute({ id: '1', name: 'bash', input: {}, signal });
    expect(bashResult.isError).toBe(true);
    expect(String(bashResult.content)).toContain('disabled by operator settings');

    const rfResult = await reWrapped.execute({ id: '2', name: 'read_file', input: {}, signal });
    expect(rfResult.isError).toBe(true);
    expect(String(rfResult.content)).toContain('disabled by operator settings');

    // Execution must not have reached the inner dispatcher for either denied call
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('OpenAI external-dispatcher schema filtering', () => {
  it('operatorDispatcherToolDefs filters denied tools from fallback for guarded dispatcher', () => {
    const inner = { execute: async () => ({ content: 'ok' }) };
    const guarded = withOperatorDeniedDispatcher(inner, { deniedTools: ['bash'] })!;
    const filtered = operatorDispatcherToolDefs(guarded, defs);
    expect(filtered.map((s) => s.name)).toEqual(['read_file']);
  });
  it('operatorDispatcherToolDefs returns fallback unchanged for unguarded dispatcher', () => {
    const inner = { execute: async () => ({ content: 'ok' }) };
    expect(operatorDispatcherToolDefs(inner, defs)).toBe(defs);
  });
});

describe('CLI tools config view', () => {
  it('preserves strings and drops malformed array items', () => {
    expect(parseToolsConfig({ tools: { disabled: ['bash', 42] } } as never)).toEqual({ tools: { disabled: ['bash'] } });
  });
  it('ignores a non-array value', () => {
    expect(parseToolsConfig({ tools: { disabled: 'bash' } } as never)).toEqual({});
  });
});
