import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AnthropicDirectProvider } from './index.js';
import { OpenAICompatibleProvider } from '../openai-compatible/index.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import type { ProviderQuery } from '../../provider.js';
import type { AnthropicToolDef } from '../../tools/types.js';
import { tool } from '../../tools/custom-tool.js';
import { jsonConfigTierPaths } from '../../../cli/config/json-tier-paths.js';
import { DEFAULT_SLOT_BINDINGS, resetSlotBindings, setSlotBindings } from '../../session/model-slots.js';

let project: string;
const queries: ProviderQuery[] = [];
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'afk-live-slot-'));
  project = join(root, 'project');
  mkdirSync(project);
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AFK_HOME', join(root, 'home'));
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const { path } of jsonConfigTierPaths()) mkdirSync(join(path, '..'), { recursive: true });
  setSlotBindings({ ...DEFAULT_SLOT_BINDINGS, local: { id: 'qwen-local', provider: 'openai' } });
});
afterEach(() => {
  for (const q of queries.splice(0)) q.close();
  resetSlotBindings(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function configure(tools: unknown): void {
  writeFileSync(jsonConfigTierPaths()[1]!.path, JSON.stringify({ tools }));
}
async function* empty() { /* No wire calls needed to observe live query state. */ }
function query(provider: AnthropicDirectProvider | OpenAICompatibleProvider, model: string): ProviderQuery {
  const q = provider.query({ prompt: empty(), config: { model, apiKey: 'sk-test', cwd: project } });
  queries.push(q);
  return q;
}
/** Inspect the same live fields read by the providers' turn drivers, not provider.buildDispatcher. */
function live(q: ProviderQuery): { dispatcher: ToolDispatcher; names: string[] } {
  const value = q as unknown as {
    state?: { toolDispatcher: ToolDispatcher };
    tools?: AnthropicToolDef[];
    toolDispatcher?: ToolDispatcher;
    openAITools?: { function: { name: string } }[];
  };
  return value.state
    ? { dispatcher: value.state.toolDispatcher, names: value.tools!.map((t) => t.name) }
    : { dispatcher: value.toolDispatcher!, names: value.openAITools!.map((t) => t.function.name) };
}
const call = (d: ToolDispatcher, name: string) => d.execute({ signal: new AbortController().signal, id: '1', name, input: {} });

describe.each([['anthropic', AnthropicDirectProvider], ['openai', OpenAICompatibleProvider]] as const)('%s concrete query slot policies', (name, Provider) => {
  // Only openai-compatible advertises customTools on the external-dispatcher
  // path (its catalog is this.schemas); anthropic-direct's external catalog is
  // builtins + get_runtime_state, so there the deny is an execution guard only.
  const advertisesCustomOnExternal = name === 'openai';
  it('external dispatcher recognizes custom slot denies, hiding and refusing them', async () => {
    configure({ disabledBySlot: { local: ['custom_echo'] } });
    const execute = vi.fn(async () => ({ content: 'executed' }));
    const q = query(new Provider({ tools: { execute }, customTools: [tool('custom_echo', 'test', z.object({}), execute)] }), 'large');
    if (advertisesCustomOnExternal) expect(live(q).names).toContain('custom_echo');
    await q.setModel('local');
    expect(live(q).names).not.toContain('custom_echo');
    expect((await call(live(q).dispatcher, 'custom_echo')).content).toContain('disabled by operator settings');
    expect(execute).not.toHaveBeenCalled();
    await q.setModel('large');
    if (advertisesCustomOnExternal) expect(live(q).names).toContain('custom_echo');
    expect((await call(live(q).dispatcher, 'custom_echo')).isError).not.toBe(true);
  });
  it('external catalogs honor both slot and global denies at query construction', async () => {
    configure({ disabled: ['image'], disabledBySlot: { local: ['bash'] } });
    const execute = vi.fn(async () => ({ content: 'executed' }));
    const q = query(new Provider({ tools: { execute } }), 'local');
    expect(live(q).names).not.toContain('bash');
    expect(live(q).names).not.toContain('image_generate');
    expect((await call(live(q).dispatcher, 'bash')).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    await q.setModel('large');
    expect(live(q).names).toContain('bash');
    expect(live(q).names).not.toContain('image_generate');
  });
  it('built-in dispatcher and catalog follow both switch directions and preserve same-key identity', async () => {
    configure({ disabledBySlot: { local: ['bash'] } });
    const q = query(new Provider(), 'large');
    const original = live(q).dispatcher;
    expect(live(q).names).toContain('bash');
    await q.setModel('medium');
    expect(live(q).dispatcher).toBe(original);
    await q.setModel('local');
    expect(live(q).dispatcher).not.toBe(original);
    expect(live(q).names).not.toContain('bash');
    expect((await call(live(q).dispatcher, 'bash')).content).toContain('disabled by operator settings');
    const restricted = live(q).dispatcher;
    await q.setModel('qwen-local');
    expect(live(q).dispatcher).toBe(restricted);
    q.setCwd?.(project);
    expect((await call(live(q).dispatcher, 'bash')).content).toContain('disabled by operator settings');
    if (name === 'anthropic') expect(live(q).names).not.toContain('bash'); // catalog must agree with execution
    await q.setModel('large');
    expect(live(q).names).toContain('bash');
    // Invalid input proves the call passed the operator gate without executing a shell.
    expect((await call(live(q).dispatcher, 'bash')).content).not.toContain('disabled by operator settings');
  });
  // Only anthropic-direct re-reads slot policy on a cwd re-anchor (its cwd
  // rebuild re-runs buildDispatcher); openai-compatible keeps its dispatcher
  // across setCwd, so a live edit there waits for the next /model or session.
  it.runIf(name === 'anthropic')('cwd re-anchor after a same-key switch rebuilds under the active slot, not the launch model', async () => {
    configure({});
    const q = query(new Provider(), 'large');
    await q.setModel('local'); // identical (empty) deny keys: no dispatcher rebuild
    configure({ disabledBySlot: { local: ['bash'] } }); // live operator edit
    q.setCwd?.(project);
    expect((await call(live(q).dispatcher, 'bash')).content).toContain('disabled by operator settings');
  });
  // #3710: after a live slot-deny edit + cwd re-anchor, the advertised catalog
  // must agree with the execution guard (was: dispatcher refused, catalog still
  // advertised the tool). openai-compatible does not rebuild on setCwd so this
  // gap cannot occur there; the test is anthropic-direct only.
  it.runIf(name === 'anthropic')('setCwd after live slot-deny edit: catalog and execution agree', async () => {
    configure({});
    const q = query(new Provider(), 'local');
    expect(live(q).names).toContain('bash');
    configure({ disabledBySlot: { local: ['bash'] } }); // operator edits while session is live
    q.setCwd?.(project); // re-anchor triggers rebuild
    // Both the execution guard and the advertised catalog must now deny bash.
    expect((await call(live(q).dispatcher, 'bash')).content).toContain('disabled by operator settings');
    expect(live(q).names).not.toContain('bash');
  });
});
