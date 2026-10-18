/**
 * #4060: the `# Shared Workspace` system-prompt section tells the model to call
 * `workspace_publish` / `workspace_query`, so it must appear only when the
 * provider both holds a workspace store AND grants both tools. Captures the
 * real request `system` payload (no network) to pin the end-to-end gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import { WorkspaceStore } from '../../workspace/workspace-store.js';

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages = { create: messagesCreateMock };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function* oneTurn(): AsyncIterable<{ content: string }> {
  yield { content: 'hello' };
}

const TEXT_STREAM = [
  {
    type: 'message_start',
    message: {
      id: 'msg_test', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5',
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

async function systemTextFor(allowedTools: string[]): Promise<string> {
  const provider = new AnthropicDirectProvider({
    permissions: { allowedTools },
    workspaceStore: new WorkspaceStore(),
  });
  const query = provider.query({
    prompt: oneTurn(),
    config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
  });
  for await (const _ev of query) void _ev;
  const system = (messagesCreateMock.mock.calls[0]?.[0] as { system?: unknown } | undefined)?.system;
  return JSON.stringify(system ?? '');
}

describe('AnthropicDirectProvider # Shared Workspace section follows the tool grant (#4060)', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    messagesCreateMock.mockImplementation(() => fromArray(TEXT_STREAM));
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
  });

  afterEach(() => __setAnthropicClientFactory(null));

  it('omits the section for a store-holding provider whose allowlist excludes the workspace tools', async () => {
    const system = await systemTextFor(['Read', 'Grep', 'Glob']);
    expect(system).toContain('# Environment');
    expect(system).not.toContain('# Shared Workspace');
  });

  it('includes the section when the store is present and both tools are allowlisted', async () => {
    const system = await systemTextFor(['Read', 'workspace_publish', 'workspace_query']);
    expect(system).toContain('# Shared Workspace');
  });
});
