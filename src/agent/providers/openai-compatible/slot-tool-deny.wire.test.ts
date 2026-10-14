import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import { __setOpenAIClientFactory, type OpenAIClientFactory } from './query.js';
import type { OpenAIChunk } from './translate.js';
import { OpenAICompatibleProvider } from './index.js';
import { jsonConfigTierPaths } from '../../../cli/config/json-tier-paths.js';
import { DEFAULT_SLOT_BINDINGS, resetSlotBindings, setSlotBindings } from '../../session/model-slots.js';

// End-to-end on the OpenAI wire: a `tools.disabledBySlot.local` entry is
// absent from the request's `tools` array AND a model call to it is refused.
async function* oneTurn(content: string): AsyncIterable<ProviderUserTurn> { yield { content }; }
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const bashCall: OpenAIChunk[] = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo leaked"}' } }] }, finish_reason: null }] } as OpenAIChunk,
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage } as OpenAIChunk,
];
const done: OpenAIChunk[] = [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage } as OpenAIChunk];

function scripted(turns: OpenAIChunk[][]): { factory: OpenAIClientFactory; calls: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: unknown }> }> } {
  const calls: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: unknown }> }> = [];
  let i = 0;
  const factory: OpenAIClientFactory = () => ({
    chat: { completions: { create: async (args: never) => {
      calls.push(args);
      const chunks = turns[i++] ?? done;
      return (async function* () { for (const c of chunks) yield c; })();
    } } },
  }) as unknown as OpenAI;
  return { factory, calls };
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'afk-slot-wire-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AFK_HOME', join(root, 'home'));
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'project'));
  for (const { path } of jsonConfigTierPaths()) mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(jsonConfigTierPaths()[1]!.path, JSON.stringify({ tools: { disabledBySlot: { local: ['bash'] } } }));
  setSlotBindings({ ...DEFAULT_SLOT_BINDINGS, local: { id: 'qwen-local', provider: 'openai' } });
});
afterEach(() => { __setOpenAIClientFactory(null); resetSlotBindings(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function run(model: string, turns: OpenAIChunk[][]) {
  const s = scripted(turns);
  __setOpenAIClientFactory(s.factory);
  const events: ProviderEvent[] = [];
  const q = new OpenAICompatibleProvider({}).query({ prompt: oneTurn('go'), config: { model, apiKey: 'sk-test' } as AgentConfig });
  for await (const ev of q) events.push(ev);
  return { calls: s.calls, events };
}

describe('tools.disabledBySlot on the OpenAI wire', () => {
  it('local slot: bash schema is not advertised and a bash call is refused', async () => {
    const { calls } = await run('local', [bashCall, done]);
    expect(calls[0]!.tools!.map((t) => t.function.name)).not.toContain('bash');
    expect(calls[0]!.tools!.map((t) => t.function.name)).toContain('read_file');
    const toolMsg = calls[1]!.messages.find((m) => m.role === 'tool');
    expect(JSON.stringify(toolMsg?.content)).toContain('disabled by operator settings');
    expect(JSON.stringify(toolMsg?.content)).not.toContain('leaked');
  });
  it('an unlisted model on the same provider still advertises bash', async () => {
    const { calls } = await run('gpt-4o-mini', [done]);
    expect(calls[0]!.tools!.map((t) => t.function.name)).toContain('bash');
  });
});
