/** Unit tests for the surface child-gate helpers and absent-option invariance. */
import { describe, expect, it, vi } from 'vitest';
import type { CanUseTool } from '../types.js';
import type { SubagentExecutor } from './subagent-executor.js';
import { createChildProviderFactory } from './nesting.js';
import { chainCanUseTool, childGateOpt, composeNodeGated } from './nesting.can-use-tool.js';
import { resolveComposeNodeProvider } from './compose-node-provider.js';

const opts = { signal: new AbortController().signal, toolUseID: 't1' };
const allow: CanUseTool = async () => ({ behavior: 'allow' });
const deny: CanUseTool = async () => ({ behavior: 'deny', message: 'no' });
const childExecutor = {} as SubagentExecutor;

describe('childGateOpt', () => {
  it('absent factory yields no key', () => {
    expect(childGateOpt(undefined, { route: 'agent', depth: 1 })).toEqual({});
  });
  it('factory returning undefined yields no key', () => {
    expect(childGateOpt(() => undefined, { route: 'agent', depth: 1 })).toEqual({});
  });
  it('missing origin still consults the factory (fail closed)', () => {
    const f = vi.fn(() => allow);
    expect(childGateOpt(f, undefined)).toEqual({ canUseTool: allow });
    expect(f).toHaveBeenCalledWith({ route: 'agent', depth: 0 });
  });
});

describe('chainCanUseTool', () => {
  it('returns either alone unchanged', () => {
    expect(chainCanUseTool(undefined, allow)).toBe(allow);
    expect(chainCanUseTool(deny, undefined)).toBe(deny);
    expect(chainCanUseTool(undefined, undefined)).toBeUndefined();
  });
  it('first deny short-circuits: the second (human) gate is never asked', async () => {
    const second = vi.fn(allow);
    const r = await chainCanUseTool(deny, second)!('write_file', {}, opts);
    expect(r.behavior).toBe('deny');
    expect(second).not.toHaveBeenCalled();
  });
  it('second sees the first rewrite and its deny wins', async () => {
    const first: CanUseTool = async () => ({ behavior: 'allow', updatedInput: { a: 2 } });
    const second = vi.fn(deny);
    expect((await chainCanUseTool(first, second)!('x', { a: 1 }, opts)).behavior).toBe('deny');
    expect(second.mock.calls[0]?.[1]).toEqual({ a: 2 });
    const r = await chainCanUseTool(first, allow)!('x', { a: 1 }, opts);
    expect(r).toEqual({ behavior: 'allow', updatedInput: { a: 2 } });
  });
});

describe('absent option: constructed child provider options are unchanged', () => {
  it.each(['sonnet', 'gpt-4o'])('%s: no gate field, identical options to a factory whose gate opts out', (model) => {
    const base = createChildProviderFactory({})({ childExecutor, model });
    const optedOut = createChildProviderFactory({ childCanUseTool: () => undefined })({ childExecutor, model, origin: { route: 'agent', depth: 1 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((base as any).canUseTool).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((base as any).providerOpts !== undefined) expect(Object.keys((base as any).providerOpts).sort()).toEqual(Object.keys((optedOut as any).providerOpts).sort());
    base.close?.(); optedOut.close?.();
  });

  it('a configured gate lands on the constructor options', () => {
    const p = createChildProviderFactory({ childCanUseTool: () => deny })({ childExecutor, model: 'gpt-4o' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((p as any).providerOpts.canUseTool).toBe(deny);
    p.close?.();
  });

  it('compose: no factory leaves restrictions untouched (same object) and unnamed store-less nodes provider-less', () => {
    const r = { readOnlyBash: true as const };
    expect(composeNodeGated(r, undefined, { id: 'a' }, 0)).toBe(r);
    expect(resolveComposeNodeProvider('sonnet', undefined, undefined, composeNodeGated({}, undefined, { id: 'a' }, 0))).toEqual({});
  });

  it('compose: a gate forces a constructed provider even with no store (else bare fallback would skip it)', () => {
    const res = resolveComposeNodeProvider('sonnet', undefined, undefined, composeNodeGated({}, () => deny, { id: 'a' }, 0));
    expect('provider' in res).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).provider.close?.();
  });
});
