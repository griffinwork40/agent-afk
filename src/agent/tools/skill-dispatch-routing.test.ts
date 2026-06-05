/**
 * Tests for the skill-dispatch routing-prompt suppression.
 *
 * Verifies that:
 * 1. A regular (non-skill-dispatch) AnthropicDirectProvider session's
 *    assembled system prompt DOES contain the slash-command routing instruction
 *    ("When you see a `<command-name>` tag…").
 * 2. A skill-dispatch sub-agent (config.isSkillDispatch = true) assembled
 *    by AnthropicDirectProvider does NOT contain that instruction.
 * 3. The OpenAI-compatible provider uses config.systemPrompt as-is (no base
 *    injection) — confirming it never injects the routing instruction regardless
 *    of isSkillDispatch.
 *
 * Both providers covered.  Tests intercept at the messages.create boundary
 * (anthropic-direct) or buildMessages output (openai-compatible) — the closest
 * observable points to what the model actually sees.
 *
 * @see src/agent/tools/system-prompt.ts  — TOOL_SYSTEM_PROMPT_BASE, SLASH_COMMAND_ROUTING_PROMPT
 * @see src/agent/providers/anthropic-direct/index.ts  — conditional assembly
 * @see src/agent/tools/skill-executor.ts  — isSkillDispatch set on childConfig
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources';
import {
  AnthropicDirectProvider,
  __setAnthropicClientFactory,
} from '../providers/anthropic-direct/index.js';
import { buildMessages } from '../providers/openai-compatible/messages.js';
import { SLASH_COMMAND_ROUTING_PROMPT, TOOL_SYSTEM_PROMPT_BASE } from './system-prompt.js';

// --------------------------------------------------------------------------
// Anthropic mock plumbing (mirrors plan-mode-system-payload.test.ts)
// --------------------------------------------------------------------------

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

function installFactory(): void {
  __setAnthropicClientFactory(
    () => new MockAnthropic() as unknown as Anthropic,
  );
}

/** Minimal stream that emits one text chunk and a clean stop. */
function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-haiku-4-5',
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
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Flatten content-block array or plain string to a single string. */
function extractSystemText(systemArg: unknown): string {
  if (typeof systemArg === 'string') return systemArg;
  if (!Array.isArray(systemArg)) return '';
  const blocks = systemArg as ContentBlockParam[];
  return blocks
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

/** Collect the `name` of every tool definition passed to messages.create. */
function extractToolNames(toolsArg: unknown): string[] {
  if (!Array.isArray(toolsArg)) return [];
  return (toolsArg as Array<{ name?: unknown }>)
    .map((t) => (typeof t.name === 'string' ? t.name : ''))
    .filter((n): n is string => n.length > 0);
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function drainQuery(query: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ev of query) { /* drain */ }
}

// --------------------------------------------------------------------------
// AnthropicDirectProvider tests
// --------------------------------------------------------------------------

describe('AnthropicDirectProvider — skill-dispatch routing prompt suppression', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));
  });

  it('regular session: system prompt INCLUDES the slash-command routing instruction', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-haiku-4-5',
        apiKey: 'sk-ant-oat01-test',
        // isSkillDispatch is omitted → defaults to false → routing included
      },
    });

    await drainQuery(query);

    expect(messagesCreateMock).toHaveBeenCalled();
    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);

    // The routing instruction must be present for main-session Claude.
    expect(text).toContain('When you see a `<command-name>` tag');
    expect(text).toContain(SLASH_COMMAND_ROUTING_PROMPT);
    // Base conventions must also be present.
    expect(text).toContain('Use read_file before editing');
  });

  it('regular session (isSkillDispatch=false): routing instruction present', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-haiku-4-5',
        apiKey: 'sk-ant-oat01-test',
        isSkillDispatch: false,
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);

    expect(text).toContain('When you see a `<command-name>` tag');
    expect(text).toContain(SLASH_COMMAND_ROUTING_PROMPT);
  });

  it('skill-dispatch sub-agent (isSkillDispatch=true): routing instruction ABSENT', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('Run the skill.'),
      config: {
        model: 'claude-haiku-4-5',
        apiKey: 'sk-ant-oat01-test',
        // Simulates a skill sub-agent forked by SkillExecutor.
        isSkillDispatch: true,
        systemPrompt: 'You are a checkpoint skill. Save the session state.',
      },
    });

    await drainQuery(query);

    expect(messagesCreateMock).toHaveBeenCalled();
    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);

    // The routing instruction must NOT appear for skill sub-agents.
    expect(text).not.toContain('When you see a `<command-name>` tag');
    expect(text).not.toContain(SLASH_COMMAND_ROUTING_PROMPT);
    // Base tool conventions must still be present.
    expect(text).toContain('Use read_file before editing');
    expect(text).toContain(TOOL_SYSTEM_PROMPT_BASE);
    // The SKILL.md body must also be present.
    expect(text).toContain('You are a checkpoint skill');
  });

  it('skill-dispatch sub-agent: SKILL.md body appears AFTER base tool conventions', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('Run the skill.'),
      config: {
        model: 'claude-haiku-4-5',
        apiKey: 'sk-ant-oat01-test',
        isSkillDispatch: true,
        systemPrompt: 'SKILL_BODY_SENTINEL',
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);

    const baseIdx = text.indexOf('Use read_file before editing');
    const bodyIdx = text.indexOf('SKILL_BODY_SENTINEL');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    // SKILL.md body appears after the base conventions.
    expect(bodyIdx).toBeGreaterThan(baseIdx);
  });
});

// --------------------------------------------------------------------------
// AnthropicDirectProvider — ask_question stripped for skill-dispatch sub-agents
// --------------------------------------------------------------------------
// A skill-dispatch sub-agent was dispatched AS a specific skill, so it must
// never pause to ask the operator "which skill?". Removing the ask_question
// tool is the structural backstop (the SLASH_COMMAND_ROUTING_PROMPT omission
// is the prompt-level one). Verified safe: no bundled/registry skill calls
// ask_question.

describe('AnthropicDirectProvider — skill-dispatch ask_question suppression', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));
  });

  it('regular session: ask_question IS offered as a tool', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-haiku-4-5',
        apiKey: 'sk-ant-oat01-test',
        // isSkillDispatch omitted → defaults to false → ask_question retained
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const toolNames = extractToolNames((firstCall[0] as { tools?: unknown }).tools);
    expect(toolNames).toContain('ask_question');
    // Sanity: the rest of the builtin toolset is present too.
    expect(toolNames).toContain('read_file');
  });

  it('skill-dispatch sub-agent (isSkillDispatch=true): ask_question is STRIPPED', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput(
        'Run the harvest skill now, following the instructions in your system prompt.',
      ),
      config: {
        model: 'claude-haiku-4-5',
        apiKey: 'sk-ant-oat01-test',
        isSkillDispatch: true,
        systemPrompt: 'You are the harvest skill. Extract patterns.',
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const toolNames = extractToolNames((firstCall[0] as { tools?: unknown }).tools);
    // The escape-hatch tool must be gone for skill sub-agents…
    expect(toolNames).not.toContain('ask_question');
    // …but the rest of the toolset must remain intact.
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('bash');
  });
});

// --------------------------------------------------------------------------
// AnthropicDirectProvider — terminal_font_size stripped for skill-dispatch sub-agents
// --------------------------------------------------------------------------
// A bare numeric skill arg (e.g. /review 621) can lure a confused model into
// calling terminal_font_size(<n>) — the only numeric-input tool — instead of
// running the skill. Strip it for skill-dispatch sub-agents alongside ask_question.
// Verified safe: no bundled/registry/user skill calls terminal_font_size.

describe('AnthropicDirectProvider — skill-dispatch terminal_font_size suppression', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));
  });

  it('regular session: terminal_font_size IS offered as a tool', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-haiku-4-5',
        apiKey: 'sk-ant-oat01-test',
        // isSkillDispatch omitted → defaults to false → terminal_font_size retained
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const toolNames = extractToolNames((firstCall[0] as { tools?: unknown }).tools);
    expect(toolNames).toContain('terminal_font_size');
    // Sanity: rest of the builtin toolset is present.
    expect(toolNames).toContain('read_file');
  });

  it('skill-dispatch sub-agent (isSkillDispatch=true): terminal_font_size is STRIPPED', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput(
        'Run the review skill now, following the instructions in your system prompt.',
      ),
      config: {
        model: 'claude-haiku-4-5',
        apiKey: 'sk-ant-oat01-test',
        isSkillDispatch: true,
        systemPrompt: 'You are the review skill. Analyze the diff.',
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const toolNames = extractToolNames((firstCall[0] as { tools?: unknown }).tools);
    // The environment tool must be gone for skill sub-agents…
    expect(toolNames).not.toContain('terminal_font_size');
    // …but the rest of the toolset must remain intact (precise filtering, not blanket strip).
    expect(toolNames).toContain('read_file');
  });
});

// --------------------------------------------------------------------------
// OpenAI-compatible provider tests
// --------------------------------------------------------------------------
// The openai-compatible provider does NOT inject TOOL_SYSTEM_PROMPT itself;
// system content comes entirely from config.systemPrompt (via buildMessages).
// So the routing instruction is never present regardless of isSkillDispatch.
// These tests confirm that invariant is stable.

describe('openai-compatible messages.ts — routing instruction never injected', () => {
  it('regular session (no isSkillDispatch): no routing instruction in system message', () => {
    const messages = buildMessages({
      config: {
        model: 'gpt-4o-mini',
        systemPrompt: 'You are a helpful assistant.',
        // isSkillDispatch omitted
      },
      currentUserText: 'hello',
    });

    const sysMsg = messages.find((m) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect(typeof sysMsg!.content).toBe('string');
    // openai-compatible never injects the routing instruction.
    expect(sysMsg!.content).not.toContain('When you see a `<command-name>` tag');
    expect(sysMsg!.content).not.toContain(SLASH_COMMAND_ROUTING_PROMPT);
  });

  it('skill-dispatch sub-agent (isSkillDispatch=true): still no routing instruction', () => {
    const messages = buildMessages({
      config: {
        model: 'gpt-4o-mini',
        systemPrompt: 'SKILL_BODY_FOR_OPENAI',
        isSkillDispatch: true,
      },
      currentUserText: 'Run the skill.',
    });

    const sysMsg = messages.find((m) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).not.toContain('When you see a `<command-name>` tag');
    expect(sysMsg!.content).not.toContain(SLASH_COMMAND_ROUTING_PROMPT);
    // SKILL.md body is present.
    expect(sysMsg!.content).toContain('SKILL_BODY_FOR_OPENAI');
  });
});
