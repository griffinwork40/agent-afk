import { describe, expect, it, vi } from 'vitest';
import { SessionToolDispatcher } from './dispatcher.js';
import { categorizeTool } from '../tool-category.js';
import { classifyRiskDetailed } from '../risk-classifier.js';
import { createPlanModeGate } from '../plan-mode-gate.js';
import { createHookRegistry } from '../hook-registry.js';
import type { ToolHandlerContext } from './types.js';

const writes = [
  { subcommand: 'rename' },
  { subcommand: 'rename', apply: true },
  { subcommand: 'rename', apply: 'false' },
  { subcommand: 'code_actions', apply: true },
];
const reads = [
  { subcommand: 'rename', apply: false },
  { subcommand: 'code_actions' },
  { subcommand: 'code_actions', apply: false },
  ...['definition', 'references', 'hover', 'document_symbols', 'workspace_symbols'].map(subcommand => ({ subcommand })),
];
const call = (input: unknown) => ({ name: 'code_symbols', input, id: 'lsp', signal: new AbortController().signal });

describe('code_symbols mutation policy', () => {
  it.each(writes)('classifies and plan-blocks mutation %j', input => {
    expect(categorizeTool('code_symbols', input)).toBe('write');
    expect(classifyRiskDetailed('code_symbols', { ...input, file_path: '/project/a.ts' }, { cwd: '/project' }))
      .toMatchObject({ level: 'medium', category: 'workspace-write' });
    expect(createPlanModeGate(() => 'plan')({ event: 'PreToolUse', toolName: 'code_symbols', input }).decision).toBe('block');
  });
  it.each(reads)('retains read behavior %j', input => {
    expect(categorizeTool('code_symbols', input)).toBe('read');
    expect(classifyRiskDetailed('code_symbols', input, { cwd: '/project' }).level).toBe('safe');
    expect(createPlanModeGate(() => 'plan')({ event: 'PreToolUse', toolName: 'code_symbols', input }).decision).not.toBe('block');
  });
  it.each(writes)('plan hook refuses mutation %j on the actual dispatch path', async input => {
    const registry = createHookRegistry();
    registry.register('PreToolUse', createPlanModeGate(() => 'plan'));
    const handler = vi.fn(async () => ({ content: 'executed' }));
    const d = new SessionToolDispatcher({ handlers: new Map([['code_symbols', handler]]), schemas: [], hookRegistry: registry });
    expect((await d.execute(call(input))).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
  it('does not bypass credential path risk', () => {
    expect(classifyRiskDetailed('code_symbols', { subcommand: 'rename', file_path: '/etc/shadow' }, { cwd: '/project' }).level).toBe('high');
  });
  it.each(writes)('read-only dispatcher refuses %j before execution', async input => {
    const handler = vi.fn(async () => ({ content: 'executed' }));
    const d = new SessionToolDispatcher({ handlers: new Map([['code_symbols', handler]]), schemas: [], hookRegistry: undefined, readOnlyBash: true });
    expect((await d.execute(call(input))).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
  it('read-only dispatcher allows preview in a batch, refuses apply', async () => {
    const handler = vi.fn(async () => ({ content: 'preview' }));
    const d = new SessionToolDispatcher({ handlers: new Map([['code_symbols', handler]]), schemas: [], hookRegistry: undefined, readOnlyBash: true });
    const results = await d.executeBatch([call({ subcommand: 'rename', apply: false }), call({ subcommand: 'rename' })]);
    expect(results[0]?.isError).not.toBe(true);
    expect(results[1]?.isError).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('dispatcher install eligibility is trusted context only', () => {
  it.each([
    [{}, false],
    [{ lspInstallAllowed: true }, true],
    [{ lspInstallAllowed: true, isNonInteractive: true }, false],
    [{ lspInstallAllowed: true, parentSessionId: 'parent' }, false],
    [{ lspInstallAllowed: true, subagentId: 'child' }, false],
  ] as const)('enforces %j => %s', async (opts, expected) => {
    let seen: ToolHandlerContext | undefined;
    const d = new SessionToolDispatcher({ ...opts, schemas: [], hookRegistry: undefined,
      handlers: new Map([['code_symbols', async (_input, _signal, context) => { seen = context; return { content: 'ok' }; }]]),
    });
    await d.execute(call({ lspInstallAllowed: true }));
    expect(seen?.lspInstallAllowed).toBe(expected);
  });
});
