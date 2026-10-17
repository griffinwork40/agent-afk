import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicDirectProvider } from './index.js';
import { OpenAICompatibleProvider } from '../openai-compatible/index.js';
import { createChildProviderFactory } from '../../tools/nesting.js';
import type { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { jsonConfigTierPaths } from '../../../cli/config/json-tier-paths.js';
import { DEFAULT_SLOT_BINDINGS, resetSlotBindings, setSlotBindings } from '../../session/model-slots.js';

// Provider-level coverage for tools.disabledBySlot: the per-slot list flows
// through the SAME buildDispatcher → composeDispatcherPermissions path as
// tools.disabled, so the advertised schemas and the execution gate agree.
let project: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'afk-provider-slot-denies-'));
  project = join(root, 'project');
  mkdirSync(project);
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AFK_HOME', join(root, 'home'));
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  for (const { path } of jsonConfigTierPaths()) mkdirSync(join(path, '..'), { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setSlotBindings({ ...DEFAULT_SLOT_BINDINGS, local: { id: 'qwen-local', provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1' } });
});
afterEach(() => { resetSlotBindings(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function configure(content: unknown): void {
  writeFileSync(jsonConfigTierPaths()[1]!.path, JSON.stringify(content));
}

function build(provider: unknown, slotModel?: string): SessionToolDispatcher {
  return (provider as { buildDispatcher(mode: string, opts: { cwd: string; slotModel?: string }): SessionToolDispatcher })
    .buildDispatcher('default', { cwd: project, ...(slotModel !== undefined ? { slotModel } : {}) });
}
const names = (d: SessionToolDispatcher) => d.toolDefs.map((s) => s.name);
const call = (d: SessionToolDispatcher, name: string) =>
  d.execute({ signal: new AbortController().signal, id: '1', name, input: { command: 'echo no' } });

describe.each([['anthropic', AnthropicDirectProvider], ['openai', OpenAICompatibleProvider]] as const)('tools.disabledBySlot in %s', (_n, Provider) => {
  it('no config: the local slot keeps every tool (unchanged behaviour)', () => {
    expect(names(build(new Provider(), 'local'))).toEqual(names(build(new Provider())));
  });
  it('slot list removes schemas AND blocks execution for that slot only', async () => {
    configure({ tools: { disabledBySlot: { local: ['bash', 'browser'] } } });
    const provider = new Provider();
    const local = build(provider, 'local');
    expect(names(local)).not.toContain('bash');
    expect(names(local)).not.toContain('browser_open');
    const r = await call(local, 'bash');
    expect(r.isError).toBe(true);
    expect(r.content).toContain('disabled by operator settings');
    // Raw id bound to the slot resolves to the same list.
    expect(names(build(provider, 'qwen-local'))).not.toContain('bash');
    // Hosted slots / fixed aliases on the SAME provider keep every tool.
    for (const hosted of ['large', 'medium', 'sonnet']) expect(names(build(provider, hosted))).toContain('bash');
  });
  it('locked tools in a slot list stay available', () => {
    configure({ tools: { disabledBySlot: { local: ['read_file', 'agent'] } } });
    expect(names(build(new Provider(), 'local'))).toContain('read_file');
  });
  it('unions with the global tools.disabled list', () => {
    configure({ tools: { disabled: ['peer'], disabledBySlot: { local: ['bash'] } } });
    const provider = new Provider();
    expect(names(build(provider, 'local'))).not.toContain('bash');
    expect(names(build(provider, 'local'))).not.toContain('send_to_session');
    expect(names(build(provider, 'large'))).toContain('bash');
    expect(names(build(provider, 'large'))).not.toContain('send_to_session');
  });
});

describe('subagent children', () => {
  it('a child on another slot gets its own slot list, not the parent slot list', async () => {
    configure({ tools: { disabledBySlot: { local: ['bash'], large: ['image'] } } });
    const factory = createChildProviderFactory();
    // The child provider is built for its own model; its per-query dispatcher
    // resolves the slot list from the child's model (config.model at query()).
    const localChild = build(factory({ model: 'local', childExecutor: {} as never }), 'local');
    expect(names(localChild)).not.toContain('bash');
    expect((await call(localChild, 'bash')).isError).toBe(true);
    const largeChild = build(factory({ model: 'large', childExecutor: {} as never }), 'large');
    expect(names(largeChild)).toContain('bash');
    expect(names(largeChild)).not.toContain('image_generate');
  });
});
