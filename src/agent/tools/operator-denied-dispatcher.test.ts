import { describe, expect, it, vi } from 'vitest';
import { operatorDispatcherToolDefs, withOperatorDeniedDispatcher } from './operator-denied-dispatcher.js';
import { parseToolsConfig } from '../../cli/config/json-tier-parse.tools.js';

const defs = [
  { name: 'bash', input_schema: { type: 'object' as const } },
  { name: 'read_file', input_schema: { type: 'object' as const } },
];

describe('external dispatcher operator guard', () => {
  it('filters its catalog, rejects denied calls and preserves allowed routing', async () => {
    const execute = vi.fn(async () => ({ content: 'ok' }));
    const setResolveBase = vi.fn();
    const setAllowAll = vi.fn();
    const wrapped = withOperatorDeniedDispatcher({ execute, setResolveBase, setAllowAll, toolDefs: defs } as never, { deniedTools: ['bash'] })!;
    expect(operatorDispatcherToolDefs(wrapped, [])).toEqual([defs[1]]);
    expect((await wrapped.execute({ id: '1', name: 'bash', input: {}, signal: new AbortController().signal })).content).toContain('disabled by operator settings');
    expect(execute).not.toHaveBeenCalled();
    expect((await wrapped.execute({ id: '2', name: 'read_file', input: {}, signal: new AbortController().signal })).content).toBe('ok');
    wrapped.setResolveBase?.('/new');
    wrapped.setAllowAll?.(true);
    expect(setResolveBase).toHaveBeenCalledWith('/new');
    expect(setAllowAll).toHaveBeenCalledWith(true);
  });
  it('uses the builtin fallback when the inner has no catalog', () => {
    const wrapped = withOperatorDeniedDispatcher({ execute: async () => ({ content: 'ok' }) }, { deniedTools: ['bash'] })!;
    expect(operatorDispatcherToolDefs(wrapped, []).map((s) => s.name)).not.toContain('bash');
    expect(operatorDispatcherToolDefs(wrapped, []).map((s) => s.name)).toContain('read_file');
  });
  it('does not wrap when no operator denies exist', () => {
    const inner = { execute: async () => ({ content: 'ok' }) };
    expect(withOperatorDeniedDispatcher(inner, undefined)).toBe(inner);
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
