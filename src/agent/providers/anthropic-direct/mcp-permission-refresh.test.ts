/**
 * Regression test for the OAuth-MCP permission-staleness bug.
 *
 * The permission allowlist is snapshotted ONCE at provider construction. When
 * an OAuth-backed MCP server discovers its tools AFTER that snapshot, the tools
 * appear in the dispatcher's `schemas`/`handlers` (read live each query) but are
 * absent from the frozen allowlist — so the gate rejects every call with "not
 * in the configured allowlist" even though the model can see the tool.
 *
 * The fix (`withMcpToolsAllowed`, applied in `buildDispatcher`) re-unions the
 * live MCP wire-names into the allowlist at query time. This test drives a REAL
 * `McpManager` (stdio fixture) through the REAL provider + dispatcher with a
 * static allowlist that deliberately omits the MCP tool, and asserts:
 *   1. the MCP tool now executes (no permission rejection), and
 *   2. a non-MCP tool absent from the allowlist is STILL rejected (the union is
 *      scoped to MCP tools — not a blanket open).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import { McpManager } from '../../mcp/manager.js';

const __filename = fileURLToPath(import.meta.url);
const FIXTURE = resolve(dirname(__filename), '../../mcp/__fixtures__/test-server.mjs');

// --- Mock Anthropic Messages-API plumbing (mirrors read-only-memory.test.ts) --

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function makeToolUseStream(
  toolId: string,
  toolName: string,
  inputJson: string,
): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_t',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

async function drainQuery(query: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ev of query) {
    // drain
  }
}

/** Pull the tool_result block for `toolUseId` out of the follow-up request. */
function toolResultText(toolUseId: string): { isError: boolean; text: string } {
  const secondCall = messagesCreateMock.mock.calls[1]!;
  const messages = (secondCall[0] as {
    messages?: Array<{ role: string; content: ContentBlockParam[] | string }>;
  }).messages;
  const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === 'user');
  const blocks = Array.isArray(lastUser?.content) ? (lastUser!.content as ContentBlockParam[]) : [];
  const toolResult = blocks.find(
    (b) =>
      (b as { type?: string }).type === 'tool_result' &&
      (b as { tool_use_id?: string }).tool_use_id === toolUseId,
  ) as { is_error?: boolean; content?: unknown } | undefined;
  const content = toolResult?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
        : '';
  return { isError: toolResult?.is_error === true, text };
}

describe('AnthropicDirectProvider — MCP permission allowlist refresh', () => {
  let manager: McpManager | undefined;

  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
  });

  afterEach(async () => {
    if (manager) {
      await manager.disconnectAll();
      manager = undefined;
    }
    __setAnthropicClientFactory(null);
  });

  it(
    'allows an MCP tool absent from the static allowlist (OAuth late-discovery regression)',
    async () => {
      manager = await McpManager.fromConfig({
        srv: { type: 'stdio', command: process.execPath, args: [FIXTURE] },
      });

      // Static allowlist omits the MCP tool entirely — simulates the snapshot
      // taken before the OAuth handshake discovered the server's tools.
      const provider = new AnthropicDirectProvider({
        permissions: { allowedTools: ['read_file'] },
        mcpManager: manager,
      });

      let call = 0;
      messagesCreateMock.mockImplementation(() => {
        call++;
        return call === 1
          ? fromArray(makeToolUseStream('tu_echo', 'mcp__srv__echo', JSON.stringify({ text: 'hi via mcp' })))
          : fromArray(makeTextStream('done'));
      });

      await drainQuery(
        provider.query({
          prompt: singleInput('echo something'),
          config: { model: 'claude-sonnet-4-5-20250929', apiKey: 'sk-ant-oat01-test' },
        }),
      );

      expect(messagesCreateMock).toHaveBeenCalledTimes(2);
      const { isError, text } = toolResultText('tu_echo');
      expect(text).not.toContain('not in the configured allowlist');
      expect(isError).toBe(false);
      expect(text).toContain('hi via mcp');
    },
    { timeout: 15_000 },
  );

  it(
    'still rejects a non-MCP tool absent from the allowlist (union is scoped, not blanket)',
    async () => {
      manager = await McpManager.fromConfig({
        srv: { type: 'stdio', command: process.execPath, args: [FIXTURE] },
      });

      const provider = new AnthropicDirectProvider({
        permissions: { allowedTools: ['read_file'] },
        mcpManager: manager,
      });

      let call = 0;
      messagesCreateMock.mockImplementation(() => {
        call++;
        return call === 1
          ? fromArray(makeToolUseStream('tu_write', 'write_file', JSON.stringify({ file_path: '/tmp/x', content: 'y' })))
          : fromArray(makeTextStream('done'));
      });

      await drainQuery(
        provider.query({
          prompt: singleInput('write a file'),
          config: { model: 'claude-sonnet-4-5-20250929', apiKey: 'sk-ant-oat01-test' },
        }),
      );

      const { isError, text } = toolResultText('tu_write');
      expect(isError).toBe(true);
      expect(text).toContain('not in the configured allowlist');
    },
    { timeout: 15_000 },
  );
});
