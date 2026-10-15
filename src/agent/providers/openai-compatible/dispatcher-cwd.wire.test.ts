/**
 * Locks the dispatcher containment base on the OpenAI-compatible provider.
 *
 * Regression (#3704): `query()` built every dispatcher with
 * `cwd: _currentCwd`, where `_currentCwd = config.cwd ?? process.cwd()` is the
 * DISPLAY cwd cell. For an unconfined session (no worktree, no `config.cwd`,
 * e.g. a fork of an unconfined parent) that turned "no containment" into
 * "contained to process.cwd() with read roots []", so every typed read_file /
 * grep / glob failed with "outside the allowed read roots []". #3734 fixed the
 * same shape on anthropic-direct only; witness traces after that fix show the
 * error exclusively on gpt-* (openai-compatible) forks.
 *
 * Driven end-to-end through `OpenAICompatibleProvider.query()` with a scripted
 * wire, so the assertion is on the real tool result the model would see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import type { ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import { __setOpenAIClientFactory, type OpenAIClientFactory } from './query.js';
import type { OpenAIChunk } from './translate.js';
import { OpenAICompatibleProvider } from './index.js';

async function* oneTurn(content: string): AsyncIterable<ProviderUserTurn> { yield { content }; }
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const readCall = (filePath: string): OpenAIChunk[] => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: filePath }) } }] }, finish_reason: null }] } as OpenAIChunk,
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage } as OpenAIChunk,
];
const done: OpenAIChunk[] = [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage } as OpenAIChunk];

type Call = { messages: Array<{ role: string; content?: unknown }> };
function scripted(turns: OpenAIChunk[][]): { factory: OpenAIClientFactory; calls: Call[] } {
  const calls: Call[] = [];
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

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-oai-dispatcher-cwd-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AFK_HOME', join(root, 'home'));
  mkdirSync(join(root, 'project'), { recursive: true });
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  // The display fallback: an unconfined session's `process.cwd()`.
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'project'));
  outside = join(root, 'elsewhere', 'data.txt');
  writeFileSync(outside, 'READ-ME-CONTENT');
});
afterEach(() => { __setOpenAIClientFactory(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function toolResultFor(config: Partial<AgentConfig>): Promise<string> {
  const s = scripted([readCall(outside), done]);
  __setOpenAIClientFactory(s.factory);
  const q = new OpenAICompatibleProvider({}).query({
    prompt: oneTurn('go'),
    // A forked child (depth 1): never registers presence.
    config: { model: 'gpt-4o-mini', apiKey: 'sk-test', depth: 1, parentSessionId: 'parent', ...config } as AgentConfig,
  });
  for await (const _ev of q) { /* drain */ }
  const toolMsg = s.calls[1]?.messages.find((m) => m.role === 'tool');
  return JSON.stringify(toolMsg?.content);
}

describe('openai-compatible dispatcher containment base', () => {
  it('leaves an unconfined fork unconfined (no "read roots []" deny-all)', async () => {
    const result = await toolResultFor({});
    expect(result).not.toContain('outside the allowed read roots');
    expect(result).toContain('READ-ME-CONTENT');
  });

  it('still confines a fork that has a cwd', async () => {
    const result = await toolResultFor({ cwd: join(root, 'project') });
    expect(result).toContain('outside the allowed read roots');
    expect(result).not.toContain('READ-ME-CONTENT');
  });
});
