/**
 * Issue #3808: tool calls whose arguments were lost in transit (empty argument
 * stream for a tool with required params) or failed to JSON-parse must never
 * reach the tool dispatcher. They get a synthetic isError result instead, in
 * batch order, while clean calls in the same batch still dispatch.
 */

import { describe, it, expect, vi } from 'vitest';
import { dispatchAndAppendToolCalls } from './dispatch-append.js';
import { createStreamState } from '../translate.js';
import type { OpenAIMessage } from '../messages.js';
import type { ProviderEvent } from '../../../provider.js';
import type { TraceSink } from '../../../trace/index.js';
import type { AnthropicToolDef, ToolCall, ToolDispatcher, ToolResult } from '../../anthropic-direct/types.js';
import { SessionToolDispatcher } from '../../../tools/dispatcher.js';
import { createHookRegistry } from '../../../hooks.js';
import type { ToolHandler } from '../../../tools/types.js';

const TOOL_DEFS: AnthropicToolDef[] = [
  {
    name: 'read_thing',
    description: 'Read',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  { name: 'list_things', description: 'No-arg tool', input_schema: { type: 'object' } },
];

type RawCall = { id: string; name: string; args: string };

function stateWith(calls: readonly RawCall[]) {
  const state = createStreamState();
  calls.forEach((c, index) => {
    state.toolCallsByIndex.set(index, { index, id: c.id, name: c.name, argumentsRaw: c.args, startEmitted: true });
  });
  return state;
}

/** Fake dispatcher exposing `toolDefs` (read structurally by requiredArgToolsOf) and a batch spy. */
function fakeDispatcher() {
  const executeBatch = vi.fn(async (calls: ToolCall[]): Promise<ToolResult[]> =>
    calls.map((c) => ({ content: `ran ${c.id} ${JSON.stringify(c.input)}` })),
  );
  const execute = vi.fn(async (c: ToolCall): Promise<ToolResult> => ({ content: `ran ${c.id}` }));
  const dispatcher = { toolDefs: TOOL_DEFS, execute, executeBatch } as unknown as ToolDispatcher;
  return { dispatcher, executeBatch, execute };
}

function fakeTrace() {
  const rows: { kind: string; payload: Record<string, unknown> }[] = [];
  const sink = {
    write: (row: { kind: string; payload: Record<string, unknown> }) => {
      rows.push(row);
      return Promise.resolve();
    },
    getTracePath: () => 'in-memory://trace',
  } as unknown as TraceSink;
  return { rows, sink };
}

async function round(calls: readonly RawCall[], dispatcher: ToolDispatcher, traceWriter?: TraceSink) {
  const priorTurns: OpenAIMessage[] = [{ role: 'user', content: 'go' } as OpenAIMessage];
  const gen = dispatchAndAppendToolCalls({
    state: stateWith(calls),
    signal: new AbortController().signal,
    vision: false,
    toolDispatcher: dispatcher,
    traceWriter,
    priorTurns,
    sessionId: 'sess-3808',
  });
  const events: ProviderEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) break;
    events.push(next.value);
  }
  const outputs = events.filter((e): e is Extract<ProviderEvent, { type: 'tool.output' }> => e.type === 'tool.output');
  const toolMessages = priorTurns.filter((m) => m.role === 'tool') as unknown as { tool_call_id: string; content: string }[];
  return { events, outputs, toolMessages };
}

describe('dispatchAndAppendToolCalls — undispatched parse-error calls (#3808)', () => {
  it('does not dispatch a lost-argument call, dispatches the clean one, and preserves order', async () => {
    const { dispatcher, executeBatch } = fakeDispatcher();
    const { rows, sink } = fakeTrace();
    const { outputs, toolMessages } = await round(
      [
        { id: 'lost', name: 'read_thing', args: '' },
        { id: 'ok', name: 'read_thing', args: '{"path":"/a"}' },
      ],
      dispatcher,
      sink,
    );

    expect(executeBatch).toHaveBeenCalledTimes(1);
    expect(executeBatch.mock.calls[0]![0].map((c) => c.id)).toEqual(['ok']);

    expect(outputs.map((o) => o.toolUseId)).toEqual(['lost', 'ok']);
    expect(outputs[0]).toMatchObject({ isError: true });
    expect(outputs[0]!.content).toMatch(/No arguments received from the API for tool "read_thing"/);
    expect(outputs[0]!.content).toMatch(/lost in transit/);
    expect(outputs[0]!.content).toMatch(/Resend the same "read_thing" call/);
    expect(outputs[1]!.content).toBe('ran ok {"path":"/a"}');
    expect(outputs[1]!.isError).toBeUndefined();

    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['lost', 'ok']);

    // Witness pairing: one started + one completed per call, including the undispatched one.
    await Promise.resolve();
    const toolRows = rows.filter((r) => r.kind === 'tool_call');
    const lostPhases = toolRows
      .filter((r) => r.payload['toolUseId'] === 'lost')
      .map((r) => r.payload['phase']);
    expect(toolRows).toHaveLength(4);
    expect(lostPhases).toEqual(['started', 'completed']);
  });

  it('does not dispatch a call whose arguments fail to JSON-parse', async () => {
    const { dispatcher, executeBatch } = fakeDispatcher();
    const { outputs } = await round([{ id: 'bad', name: 'read_thing', args: '{not json' }], dispatcher);

    expect(executeBatch).not.toHaveBeenCalled();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ toolUseId: 'bad', isError: true });
    expect(outputs[0]!.content).toMatch(/Failed to parse tool arguments as JSON/);
    expect(outputs[0]!.content).toMatch(/valid JSON object/);
    expect(outputs[0]!.content).not.toMatch(/lost in transit/);
  });

  it('still dispatches a no-required-params tool that received empty arguments', async () => {
    const { dispatcher, executeBatch } = fakeDispatcher();
    const { outputs } = await round([{ id: 'noarg', name: 'list_things', args: '' }], dispatcher);

    expect(executeBatch).toHaveBeenCalledTimes(1);
    expect(executeBatch.mock.calls[0]![0]).toMatchObject([{ id: 'noarg', input: {} }]);
    expect(outputs[0]).toMatchObject({ toolUseId: 'noarg', content: 'ran noarg {}' });
    expect(outputs[0]!.isError).toBeUndefined();
  });

  it('skips the sequential fallback for parse-error calls too', async () => {
    const execute = vi.fn(async (c: ToolCall): Promise<ToolResult> => ({ content: `ran ${c.id}` }));
    const dispatcher = { toolDefs: TOOL_DEFS, execute } as unknown as ToolDispatcher;
    const { outputs } = await round(
      [
        { id: 'ok', name: 'read_thing', args: '{"path":"/a"}' },
        { id: 'lost', name: 'read_thing', args: '' },
      ],
      dispatcher,
    );
    expect(execute.mock.calls.map(([c]) => c.id)).toEqual(['ok']);
    expect(outputs.map((o) => [o.toolUseId, o.isError === true])).toEqual([
      ['ok', false],
      ['lost', true],
    ]);
  });

  it('repeated lost-argument batches never trip the repeat-failure guard', async () => {
    const seen: unknown[] = [];
    const preHook: string[] = [];
    const hookRegistry = createHookRegistry();
    hookRegistry.register('PreToolUse', async (ctx) => {
      if (ctx.event === 'PreToolUse') preHook.push(ctx.toolName);
      return {};
    });
    const dispatcher = new SessionToolDispatcher({
      handlers: new Map<string, ToolHandler>([
        ['read_thing', async (input) => {
          seen.push(input);
          // Mirrors a real handler's own validation, which a `{}` dispatch hits.
          if (typeof (input as { path?: unknown }).path !== 'string') {
            return { content: 'path must be a string', isError: true };
          }
          return { content: 'read ok' };
        }],
      ]),
      schemas: [TOOL_DEFS[0]!],
      hookRegistry,
    });

    for (let i = 0; i < 5; i++) {
      const { outputs } = await round([{ id: `lost${i}`, name: 'read_thing', args: '' }], dispatcher);
      expect(outputs[0]!.content).not.toMatch(/Repeat-failure guard/);
      expect(outputs[0]!.failureClass).toBeUndefined();
      expect(outputs[0]!.content).toMatch(/lost in transit/);
    }
    // Never executed, and (like an aborted call) no hooks fired for it.
    expect(seen).toEqual([]);
    expect(preHook).toEqual([]);

    // A genuine call afterwards dispatches normally.
    const { outputs } = await round([{ id: 'real', name: 'read_thing', args: '{"path":"/a"}' }], dispatcher);
    expect(outputs[0]).toMatchObject({ content: 'read ok' });
    expect(seen).toEqual([{ path: '/a' }]);
  });
});
