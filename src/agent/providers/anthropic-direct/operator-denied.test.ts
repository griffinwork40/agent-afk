import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AnthropicDirectProvider } from './index.js';
import { OpenAICompatibleProvider } from '../openai-compatible/index.js';
import { createChildProviderFactory } from '../../tools/nesting.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { tool } from '../../tools/custom-tool.js';
import { jsonConfigTierPaths } from '../../../cli/config/json-tier-paths.js';
import { configSetHandler } from '../../tools/handlers/config-ops.js';

let project: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'afk-provider-denies-'));
  project = join(root, 'project');
  mkdirSync(project);
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AFK_HOME', join(root, 'home'));
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  for (const { path } of jsonConfigTierPaths()) mkdirSync(join(path, '..'), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function configure(entries: string[]): void {
  writeFileSync(jsonConfigTierPaths()[0]!.path, JSON.stringify({ tools: { disabled: entries } }));
}

function build(provider: unknown): SessionToolDispatcher {
  return (provider as { buildDispatcher(mode: string, opts: { cwd: string }): SessionToolDispatcher }).buildDispatcher('default', { cwd: project });
}

const schema = { name: 'mcp__late__echo', description: 'test', input_schema: { type: 'object' as const, properties: {} } };
function mcp() {
  return {
    onToolsRefreshed: undefined,
    getMcpTools: () => [schema],
    getMcpHandlers: () => new Map([[schema.name, vi.fn(async () => ({ content: 'should not run' }))]]),
    getMcpToolWireNames: () => [schema.name],
  };
}

describe('operator denies after provider unions', () => {
  it.each([['anthropic', AnthropicDirectProvider], ['openai', OpenAICompatibleProvider]] as const)('denies and hides re-unioned MCP and custom tools in %s', async (_name, Provider) => {
    configure(['mcp__late__*', 'custom_echo']);
    const handler = vi.fn(async () => ({ content: 'custom' }));
    const provider = new Provider({
      permissions: { allowedTools: ['read_file'] },
      mcpManager: mcp() as never,
      customTools: [tool('custom_echo', 'test', z.object({}), handler)],
    });
    const dispatcher = build(provider);
    expect((dispatcher as unknown as { permissions: { allowedTools: string[] } }).permissions.allowedTools).toContain(schema.name);
    expect(dispatcher.toolDefs.map((s) => s.name)).not.toContain(schema.name);
    expect(dispatcher.toolDefs.map((s) => s.name)).not.toContain('custom_echo');
    const result = await dispatcher.execute({ signal: new AbortController().signal, id: '1', name: schema.name, input: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('disabled by operator settings');
    expect((await dispatcher.execute({ signal: new AbortController().signal, id: '2', name: 'custom_echo', input: {} })).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(['sonnet', 'gpt-4o'])('child factory snapshots operator settings for %s', async (model) => {
    configure(['bash', 'mcp__late__*', 'custom_echo']);
    const provider = createChildProviderFactory()({
      model,
      childExecutor: {} as never,
      customTools: [tool('custom_echo', 'test', z.object({}), async () => ({ content: 'no' }))],
    });
    const dispatcher = build(provider);
    expect(dispatcher.toolDefs.map((s) => s.name)).not.toContain('bash');
    expect(dispatcher.toolDefs.map((s) => s.name)).not.toContain('custom_echo');
    expect((await dispatcher.execute({ signal: new AbortController().signal, id: '1', name: 'bash', input: { command: 'echo no' } })).content).toContain('disabled by operator settings');
  });
  it('does not reread settings per query and snapshots new sessions', () => {
    configure(['bash']);
    const provider = new AnthropicDirectProvider();
    configure([]);
    expect(build(provider).toolDefs.map((s) => s.name)).not.toContain('bash');
    expect(build(new AnthropicDirectProvider()).toolDefs.map((s) => s.name)).toContain('bash');
  });
  it('filters deny-only permissions with no allowlist', async () => {
    const dispatcher = new SessionToolDispatcher({ handlers: new Map([[schema.name, async () => ({ content: 'no' })]]), schemas: [schema], hookRegistry: undefined, permissions: { deniedTools: ['mcp__late__*'] } });
    expect(dispatcher.toolDefs).toEqual([]);
    expect((await dispatcher.execute({ signal: new AbortController().signal, id: '1', name: schema.name, input: {} })).isError).toBe(true);
  });
  it('config_set surfaces the operator-only refusal', async () => {
    const result = await configSetHandler({ target: 'config', key: 'tools.disabled', value: [] }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('/config → Tools');
    expect(result.content).toContain('the agent cannot change it');
  });
});
