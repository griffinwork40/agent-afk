import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jsonConfigTierPaths } from '../../cli/config/json-tier-paths.js';
import { resetSlotBindings, setSlotBindings, DEFAULT_SLOT_BINDINGS } from '../session/model-slots.js';
import { resolveSlotDeniedTools, slotDenyKey, slotForActiveModel } from './operator-denied.slots.js';
import { composeDispatcherPermissions } from './permissions-compose.js';
import { withSlotDeniedDispatcher, operatorDispatcherToolDefs } from './operator-denied-dispatcher.js';
import { toolGroups } from './operator-denied.js';
import { setConfigValue } from '../../config/mutate.js';
import type { ToolDispatcher } from '../providers/anthropic-direct/types.js';

let root: string;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-slot-denies-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AFK_HOME', join(root, 'home'));
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'project'));
  for (const { path } of jsonConfigTierPaths()) mkdirSync(join(path, '..'), { recursive: true });
  warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  setSlotBindings({ ...DEFAULT_SLOT_BINDINGS, local: { id: 'qwen-local', name: 'goblin', provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1' } });
});
afterEach(() => { resetSlotBindings(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function tier(index: number, content: unknown): void {
  writeFileSync(jsonConfigTierPaths()[index]!.path, typeof content === 'string' ? content : JSON.stringify(content));
}

describe('tools.disabledBySlot resolution', () => {
  it('no config => no slot denies and compose output is unchanged', () => {
    expect(resolveSlotDeniedTools('local')).toEqual([]);
    expect(slotDenyKey('local')).toBe('');
    const base = { allowedTools: ['bash'] };
    expect(composeDispatcherPermissions(base, undefined, [], 'local')).toEqual(composeDispatcherPermissions(base, undefined, []));
    expect(composeDispatcherPermissions(undefined, undefined, [], 'local')).toBeUndefined();
  });
  it('resolves by tier name, custom name and bound raw id; not by fixed aliases or unbound ids', () => {
    expect(slotForActiveModel('local')).toBe('local');
    expect(slotForActiveModel('goblin')).toBe('local');
    expect(slotForActiveModel('qwen-local')).toBe('local');
    expect(slotForActiveModel('sonnet')).toBeUndefined();
    expect(slotForActiveModel('gpt-4o')).toBeUndefined();
    expect(slotForActiveModel(undefined)).toBeUndefined();
  });
  it('expands groups, unions tiers, and leaves hosted slots unaffected', () => {
    tier(0, { tools: { disabledBySlot: { local: ['browser', 'bash'] } } });
    tier(1, { tools: { disabledBySlot: { local: ['peer'] } } });
    const denied = new Set(resolveSlotDeniedTools('goblin'));
    expect(denied).toEqual(new Set([...toolGroups()['browser']!, 'bash', ...toolGroups()['peer']!]));
    expect(resolveSlotDeniedTools('large')).toEqual([]);
    expect(resolveSlotDeniedTools('medium')).toEqual([]);
    expect(composeDispatcherPermissions(undefined, undefined, [], 'large')).toBeUndefined();
  });
  it('ignores LOCKED_TOOLS with the tools.disabled warning', () => {
    tier(1, { tools: { disabledBySlot: { local: ['read_file', 'agent', 'bash'] } } });
    expect(resolveSlotDeniedTools('local')).toEqual(['bash']);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('Ignoring locked core tool "read_file"');
  });
  it('tolerates malformed values without dropping other tiers', () => {
    tier(0, '{bad');
    tier(1, { tools: { disabledBySlot: { local: 'bash' } } });
    tier(2, { tools: { disabledBySlot: { local: ['bash', 7] } } });
    expect(resolveSlotDeniedTools('local')).toEqual(['bash']);
    tier(1, { tools: { disabledBySlot: ['bash'] } });
    expect(resolveSlotDeniedTools('local')).toEqual(['bash']);
  });
  it('composes slot denies after the MCP/custom unions and on top of the global deny', () => {
    tier(1, { tools: { disabledBySlot: { local: ['custom_x', 'mcp__srv__*'] } } });
    const out = composeDispatcherPermissions({ allowedTools: ['read_file'], deniedTools: ['bash'] }, ['mcp__srv__a'], ['custom_x'], 'local');
    expect(out?.allowedTools).toEqual(expect.arrayContaining(['mcp__srv__a', 'custom_x']));
    expect(new Set(out?.deniedTools)).toEqual(new Set(['bash', 'custom_x', 'mcp__srv__*']));
  });
  it('slotDenyKey changes with the list so the router rebuilds', () => {
    tier(1, { tools: { disabledBySlot: { local: ['bash'] } } });
    const a = slotDenyKey('local');
    tier(1, { tools: { disabledBySlot: { local: ['bash', 'peer'] } } });
    expect(slotDenyKey('local')).not.toBe(a);
    expect(slotDenyKey('large')).toBe('');
  });
});

describe('consumer-owned dispatcher guard', () => {
  const inner: ToolDispatcher = { execute: vi.fn(async () => ({ content: 'ran' })) };
  it('returns inner unchanged when the slot has no list', () => {
    expect(withSlotDeniedDispatcher(inner, 'large')).toBe(inner);
    expect(withSlotDeniedDispatcher(undefined, 'local')).toBeUndefined();
  });
  it('hides and blocks the slot list on the external path', async () => {
    tier(1, { tools: { disabledBySlot: { local: ['bash'] } } });
    const guarded = withSlotDeniedDispatcher(inner, 'local')!;
    const defs = [{ name: 'bash', description: '', input_schema: { type: 'object' as const, properties: {} } }];
    expect(operatorDispatcherToolDefs(guarded, defs)).toEqual([]);
    const r = await guarded.execute({ signal: new AbortController().signal, id: '1', name: 'bash', input: {} });
    expect(r.isError).toBe(true);
    expect(inner.execute).not.toHaveBeenCalled();
  });
});

describe('config_set gating', () => {
  it('refuses tools.disabledBySlot like tools.disabled', () => {
    expect(() => setConfigValue('tools.disabledBySlot.local', ['bash'])).toThrow(/operator-only/);
  });
});
