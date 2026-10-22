import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderQuery, ProviderUserTurn } from '../provider.js';
import type { FileCheckpointRegistry } from './file-checkpoint.js';
import { FileCheckpointState } from '../providers/openai-compatible/query.file-checkpoint.js';
import { readTurnLog } from './turn-log.js';
import * as checkpoints from './file-checkpoint.js';
vi.mock('./file-checkpoint.js', async original => ({ ...await original<typeof import('./file-checkpoint.js')>() }));
import { AnthropicDirectQuery } from '../providers/anthropic-direct/query.js';
import { OpenAICompatibleQuery, __setOpenAIClientFactory } from '../providers/openai-compatible/query.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'afk-provider-checkpoint-'));
  vi.stubEnv('AFK_STATE_DIR', path.join(tmp, 'state'));
  vi.stubEnv('AFK_VITALS', '0');
});
afterEach(() => {
  __setOpenAIClientFactory(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('FileCheckpointState.begin without dispatcher wiring', () => {
  it.each([undefined, {}])('is an enabled no-op for dispatcher %j', async dispatcher => {
    const registrySpy = vi.spyOn(checkpoints, 'createFileCheckpointRegistry');
    const checkpoint = new FileCheckpointState(true, 'unwired-session');
    expect(checkpoint.begin(dispatcher, 'unwired-turn')).toBeUndefined();
    expect(registrySpy).not.toHaveBeenCalled();
    // An accidental currentTurnId would reject rewind as an in-flight turn.
    const result = await checkpoint.rewind('unwired-turn');
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/No file checkpoint/);
    expect(result.error).not.toMatch(/in flight/);
  });
});

async function* input(userMessageId?: string): AsyncIterable<ProviderUserTurn> {
  yield { content: 'change the file', ...(userMessageId ? { userMessageId } : {}) };
}

function anthropicStream(tool: boolean): unknown[] {
  const block = tool
    ? { type: 'tool_use', id: 'call-write', name: 'write_file', input: {} }
    : { type: 'text', text: 'done', citations: [] };
  return [
    { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    ...(tool ? [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }] : []),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
}

async function* stream(items: unknown[]) { for (const item of items) yield item; }

function makeQuery(provider: string, userMessageId?: string, duringWrite?: (q: ProviderQuery) => Promise<void>): { query: ProviderQuery; file: string } {
  const file = path.join(tmp, 'target.txt');
  writeFileSync(file, 'original');
  let registry: FileCheckpointRegistry | undefined;
  let query: ProviderQuery;
  const dispatcher = {
    fileCheckpointWiring: { set: (r: FileCheckpointRegistry | undefined) => { registry = r; } },
    execute: async () => {
      await registry!.snapshotFile(file);
      writeFileSync(file, 'mutated');
      await duringWrite?.(query);
      return { content: 'written', isError: false };
    },
  };
  let calls = 0;
  if (provider === 'anthropic') {
    query = new AnthropicDirectQuery({
      client: { messages: { create: () => stream(anthropicStream(calls++ === 0)) } } as unknown as Anthropic,
      authMode: 'api-key', sessionId: 'test-session', promptStream: input(userMessageId), toolDispatcher: dispatcher,
      model: 'claude-test', maxTokens: 1024, tools: [{ name: 'write_file', input_schema: { type: 'object' } }],
      userSystem: null, systemPrefix: null, enableFileCheckpointing: true, cwd: tmp,
    });
  } else {
    __setOpenAIClientFactory(() => ({ chat: { completions: { create: async () => stream(calls++ === 0 ? [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-write', type: 'function', function: { name: 'write_file', arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ] : [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]) } } }) as unknown as OpenAI);
    query = new OpenAICompatibleQuery({
      auth: { apiKey: 'test', source: 'config', last4: 'test' }, model: 'gpt-4o-mini', synthesizedSessionId: 'test-session',
      promptStream: input(userMessageId), config: { model: 'gpt-4o-mini', enableFileCheckpointing: true, cwd: tmp },
      toolDispatcher: dispatcher,
      tools: [{ name: 'write_file', input_schema: { type: 'object' } }],
    });
  }
  return { query, file };
}

for (const provider of ['anthropic', 'openai']) {
  describe(`${provider} public file rewind`, () => {
    it('restores a completed real turn using the caller supplied message ID', async () => {
      const { query, file } = makeQuery(provider, 'public-message-id');
      const events: ProviderEvent[] = [];
      for await (const event of query) events.push(event);
      expect(events.some(e => e.type === 'error')).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe('mutated');
      const result = await query.rewindFiles('public-message-id');
      expect(result.canRewind).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('original');
      query.close();
    });

    it('links the prompt to its checkpoint in listRewindTargets and logs turn + post entries (#4271)', async () => {
      const { query, file } = makeQuery(provider, 'linked-message-id');
      for await (const _event of query) { /* drain the turn */ }
      const [target] = query.listRewindTargets?.() ?? [];
      expect(target?.checkpointTurnId).toBe('linked-message-id');
      const log = readTurnLog('test-session');
      expect(log.filter((e) => e.kind === 'turn').map((e) => e.kind === 'turn' && e.turnId)).toEqual(['linked-message-id']);
      expect(log.find((e) => e.kind === 'post')).toMatchObject({ turnId: 'linked-message-id', paths: { [file]: expect.any(String) } });
      query.close();
    });

    it('exposes a generated rewind target usable immediately at the completion boundary', async () => {
      const { query, file } = makeQuery(provider);
      const iterator = query[Symbol.asyncIterator]();
      let target: string | undefined;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.type === 'turn.completed') { target = next.value.userMessageId; break; }
      }
      expect(target).toBeTruthy();
      expect((await query.rewindFiles('wrong-target')).canRewind).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe('mutated');
      expect((await query.rewindFiles(target!, { dryRun: true })).canRewind).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('mutated');
      expect((await query.rewindFiles(target!)).canRewind).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('original');
      await iterator.return?.();
      query.close();
    });

    it('rejects rewind during mutation instead of silently selecting the active checkpoint', async () => {
      let result: Awaited<ReturnType<ProviderQuery['rewindFiles']>> | undefined;
      const { query, file } = makeQuery(provider, 'active-message', async q => {
        result = await q.rewindFiles('different-message');
      });
      const events: ProviderEvent[] = [];
      for await (const event of query) events.push(event);
      expect(events.some(e => e.type === 'error')).toBe(false);
      expect(result?.canRewind).toBe(false);
      expect(result?.error).toMatch(/in flight/i);
      expect(readFileSync(file, 'utf8')).toBe('mutated');
      query.close();
    });
  });
}
