import { afterEach, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { __setOpenAIClientFactory, OpenAICompatibleQuery } from '../query.js';
import type { OpenAIMessage } from '../messages.js';
import type { OpenAIChunk } from '../translate.js';
import { SessionToolDispatcher } from '../../../tools/dispatcher.js';
import { createHookRegistry } from '../../../hooks.js';
import type { AgentConfig } from '../../../types/config-types.js';
import type { JournalMessage, MessageJournal } from '../../../journal/index.js';
import { CONTEXT_PRESSURE_NOTE } from '../../shared/context-pressure.js';

class MemoryJournal implements MessageJournal {
  messages: JournalMessage[] = [];
  get length(): number { return this.messages.length; }
  append(index: number, message: JournalMessage): void { this.messages[index] = structuredClone(message); }
  truncate(length: number): void { this.messages.length = length; }
  mark(): void {}
  forSubagent(): MessageJournal { return new MemoryJournal(); }
  flush(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}

afterEach(() => { __setOpenAIClientFactory(null); vi.unstubAllEnvs(); });

it('sends JSON-bounded synthesis context without changing live conversation or journal', async () => {
  vi.stubEnv('AFK_CONTEXT_GUARD_PCT', '95');
  vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
  vi.stubEnv('AFK_VITALS', '0');
  const original = JSON.stringify({ content: '😀'.repeat(150_000) });
  const usage = { prompt_tokens: 100_000, completion_tokens: 1, total_tokens: 100_001 };
  const scripts: OpenAIChunk[][] = [[
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'write', type: 'function', function: { name: 'write_file', arguments: original } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage },
  ], [
    { choices: [{ delta: { content: 'Saved the file.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
  ]];
  const requests: Array<{ messages: OpenAIMessage[] }> = [];
  __setOpenAIClientFactory(() => ({ chat: { completions: {
    create: async (request: { messages: OpenAIMessage[] }) => {
      // Simulate endpoints that reject malformed historical argument JSON.
      for (const message of request.messages) for (const call of message.tool_calls ?? []) JSON.parse(call.function.arguments);
      requests.push(structuredClone(request));
      const chunks = scripts.shift();
      if (!chunks) throw new Error('unexpected extra synthesis round');
      return (async function* () { yield* chunks; })();
    },
  } } }) as unknown as OpenAI);
  const handler = vi.fn(async (input: unknown) => {
    expect((input as { content: string }).content === '😀'.repeat(150_000)).toBe(true);
    return { content: 'written' };
  });
  const journal = new MemoryJournal();
  const query = new OpenAICompatibleQuery({
    auth: { apiKey: 'sk', source: 'config' }, model: 'gpt-4o-mini', synthesizedSessionId: 'pressure-test',
    promptStream: (async function* () { yield { content: 'write a file' }; })(),
    config: { model: 'gpt-4o-mini', apiKey: 'sk', messageJournal: journal } as AgentConfig,
    toolDispatcher: new SessionToolDispatcher({
      handlers: new Map([['write_file', handler]]), hookRegistry: createHookRegistry(),
      schemas: [{ name: 'write_file', description: 'Write', input_schema: { type: 'object', properties: { content: { type: 'string' } } } }],
    }),
  });
  const events = [];
  for await (const event of query) events.push(event);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.messages.at(-1)!.content).toBe(CONTEXT_PRESSURE_NOTE);
  const call = requests[1]!.messages.find(m => m.tool_calls?.length)!.tool_calls![0]!;
  expect(JSON.parse(call.function.arguments)._truncated).toContain(`${Buffer.byteLength(original)} UTF-8 bytes`);
  expect(call.id).toBe('write');
  expect(handler).toHaveBeenCalledTimes(1);
  expect(events.some(e => e.type === 'assistant.message' && e.text === 'Saved the file.')).toBe(true);
  expect(query.priorTurns.find(m => m.tool_calls?.length)!.tool_calls![0]!.function.arguments).toBe(original);
  const snapshot = JSON.stringify(query.journalSnapshot());
  expect(snapshot).toContain('😀'.repeat(150_000));
  expect(JSON.stringify(journal.messages)).toContain('😀'.repeat(150_000));
  expect(snapshot).not.toContain('arguments truncated for final synthesis');
  expect(JSON.stringify(journal.messages)).not.toContain('arguments truncated for final synthesis');
});
