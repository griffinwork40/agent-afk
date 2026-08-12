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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources';
import type OpenAI from 'openai';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnthropicDirectProvider,
  __setAnthropicClientFactory,
} from '../providers/anthropic-direct/index.js';
import {
  OpenAICompatibleProvider,
  __setOpenAIClientFactory,
} from '../providers/openai-compatible/index.js';
import { buildMessages } from '../providers/openai-compatible/messages.js';
import type { OpenAIChunk } from '../providers/openai-compatible/translate.js';
import { SLASH_COMMAND_ROUTING_PROMPT, TOOL_SYSTEM_PROMPT_BASE } from './system-prompt.js';
import { registerSkill, _resetRegistry } from '../../skills/index.js';
import { SkillExecutor } from './skill-executor.js';
import { buildChildConfig } from './subagent/child-config.js';

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

describe('AnthropicDirectProvider — skill-dispatch self-entry suppression', () => {
  // Wiring guard for the composition point: config.skillDispatchName must reach
  // buildSkillManifest as excludeName. Without it a skill fork reads its OWN
  // catalogue entry — under a "Prefer a skill" preamble — and re-dispatches
  // itself instead of executing its SKILL.md body.
  //
  // Uses a uniquely-named registry skill so the assertion cannot be perturbed by
  // whatever real skills/plugins exist on the host running the suite.
  const probeName = 'self-suppress-probe';

  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));
    registerSkill({
      name: probeName,
      description: 'Probe skill for self-suppression',
      handler: vi.fn(),
    });
  });

  afterEach(() => {
    _resetRegistry();
    __setAnthropicClientFactory(null);
  });

  async function systemTextFor(config: Record<string, unknown>): Promise<string> {
    const provider = new AnthropicDirectProvider({
      // Any truthy executor turns manifest injection on; the manifest content
      // itself comes from the registry, so a bare stub is sufficient.
      skillExecutor: { execute: vi.fn() } as unknown as ConstructorParameters<
        typeof AnthropicDirectProvider
      >[0]['skillExecutor'],
    });
    await drainQuery(
      provider.query({
        prompt: singleInput('hello'),
        config: { model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test', ...config },
      } as Parameters<typeof provider.query>[0]),
    );
    const firstCall = messagesCreateMock.mock.calls[0]!;
    return extractSystemText((firstCall[0] as { system?: unknown }).system);
  }

  it('main session: the manifest lists the skill', async () => {
    const text = await systemTextFor({});
    expect(text).toContain(probeName);
  });

  it('skill-dispatch fork: its OWN entry is absent from the manifest', async () => {
    const text = await systemTextFor({
      isSkillDispatch: true,
      skillDispatchName: probeName,
    });
    expect(text).not.toContain(probeName);
  });

  it('skill-dispatch fork of a DIFFERENT skill: the entry remains', async () => {
    const text = await systemTextFor({
      isSkillDispatch: true,
      skillDispatchName: 'some-other-skill',
    });
    expect(text).toContain(probeName);
  });
});

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
// AnthropicDirectProvider — ask_question stripped on non-interactive surfaces
// --------------------------------------------------------------------------
// Daemon, scheduler/cron, and one-shot `afk chat` install no elicitation
// handler, so ask_question can only auto-decline. Stripping it pre-emptively
// stops the model burning a turn on an unanswerable prompt. Narrower than the
// skill-dispatch strip: terminal_font_size is RETAINED here.

describe('AnthropicDirectProvider — non-interactive surface ask_question suppression', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));
  });

  it('non-interactive session (isNonInteractive=true): ask_question is STRIPPED', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('Summarize the open PRs and proceed.'),
      config: {
        model: 'claude-haiku-4-5',
        apiKey: 'sk-ant-oat01-test',
        isNonInteractive: true,
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const toolNames = extractToolNames((firstCall[0] as { tools?: unknown }).tools);
    // No human can answer on a headless surface, so the escape hatch is gone…
    expect(toolNames).not.toContain('ask_question');
    // …but this strip is NARROWER than skill-dispatch: terminal_font_size stays,
    // and the rest of the toolset is intact (precise filtering, not blanket).
    expect(toolNames).toContain('terminal_font_size');
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

// --------------------------------------------------------------------------
// OpenAI-compatible mock plumbing (mirrors query.test.ts pattern)
// --------------------------------------------------------------------------

let openaiCreateCalls: Array<{ args: unknown }> = [];

function installOpenAIMockClient(): void {
  const factory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean }) => {
            openaiCreateCalls.push({ args });
            if (!args.stream) throw new Error('mock only supports streaming');
            const chunks: OpenAIChunk[] = [
              {
                choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
            ];
            return (async function* () {
              for (const c of chunks) yield c;
            })();
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

function extractOpenAISystemText(args: unknown): string {
  const messages = (args as { messages?: Array<{ role: string; content: string }> }).messages;
  if (!messages) return '';
  const sysMsg = messages.find((m) => m.role === 'system');
  return typeof sysMsg?.content === 'string' ? sysMsg.content : '';
}

// --------------------------------------------------------------------------
// OpenAICompatibleProvider — skill-dispatch self-entry suppression
// --------------------------------------------------------------------------
// Mirrors the AnthropicDirectProvider block above. PR #737 added excludeName
// forwarding from config.skillDispatchName to buildSkillManifest on the
// OpenAI-compatible side; these tests verify the fix holds.

describe('OpenAICompatibleProvider — skill-dispatch self-entry suppression', () => {
  const probeName = 'openai-manifest-probe';

  beforeEach(() => {
    openaiCreateCalls = [];
    __setOpenAIClientFactory(null);
    installOpenAIMockClient();
    registerSkill({
      name: probeName,
      description: 'Probe skill for OpenAI self-suppression',
      handler: vi.fn(),
    });
  });

  afterEach(() => {
    _resetRegistry();
    __setOpenAIClientFactory(null);
  });

  async function systemTextFor(config: Record<string, unknown>): Promise<string> {
    const provider = new OpenAICompatibleProvider({
      skillExecutor: { execute: vi.fn() } as unknown as ConstructorParameters<
        typeof OpenAICompatibleProvider
      >[0]['skillExecutor'],
    });
    await drainQuery(
      provider.query({
        prompt: singleInput('hello'),
        config: { model: 'gpt-4o-mini', apiKey: 'sk-test-key', ...config },
      } as Parameters<typeof provider.query>[0]),
    );
    const firstCall = openaiCreateCalls[0]!;
    return extractOpenAISystemText(firstCall.args);
  }

  it('main session: the manifest lists the skill', async () => {
    const text = await systemTextFor({});
    expect(text).toContain(probeName);
  });

  it('skill-dispatch fork: its OWN entry is absent from the manifest', async () => {
    const text = await systemTextFor({
      isSkillDispatch: true,
      skillDispatchName: probeName,
    });
    expect(text).not.toContain(probeName);
  });

  it('skill-dispatch fork of a DIFFERENT skill: the entry remains', async () => {
    const text = await systemTextFor({
      isSkillDispatch: true,
      skillDispatchName: 'some-other-skill',
    });
    expect(text).toContain(probeName);
  });
});

// --------------------------------------------------------------------------
// OpenAICompatibleProvider — cwd forwarding for project skills
// --------------------------------------------------------------------------
// PR #737 also added cwd forwarding to buildSkillManifest on the OpenAI side.
// Without it, <cwd>/.afk/skills/ resolves against the host process dir instead
// of the session's dir, so project skills vanish on long-lived hosts.

describe('OpenAICompatibleProvider — cwd forwarding for project skills', () => {
  const projectSkillName = 'openai-cwd-probe';
  let tmpCwd: string;

  beforeEach(() => {
    openaiCreateCalls = [];
    __setOpenAIClientFactory(null);
    installOpenAIMockClient();
    tmpCwd = mkdtempSync(join(tmpdir(), 'openai-cwd-fwd-test-'));
    const skillDir = join(tmpCwd, '.afk', 'skills', projectSkillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${projectSkillName}\ndescription: Project skill for cwd forwarding test\n---\n# Body\n`,
    );
  });

  afterEach(() => {
    __setOpenAIClientFactory(null);
    try { rmSync(tmpCwd, { recursive: true }); } catch { /* non-fatal */ }
  });

  it('project skill under config.cwd reaches the manifest', async () => {
    const provider = new OpenAICompatibleProvider({
      skillExecutor: { execute: vi.fn() } as unknown as ConstructorParameters<
        typeof OpenAICompatibleProvider
      >[0]['skillExecutor'],
    });
    await drainQuery(
      provider.query({
        prompt: singleInput('hello'),
        config: {
          model: 'gpt-4o-mini',
          apiKey: 'sk-test-key',
          cwd: tmpCwd,
        },
      } as Parameters<typeof provider.query>[0]),
    );
    const firstCall = openaiCreateCalls[0]!;
    const text = extractOpenAISystemText(firstCall.args);
    expect(text).toContain(projectSkillName);
  });
});

// --------------------------------------------------------------------------
// Fix A: SkillExecutor execution-level self-recursion guard (#skill-recursion)
// --------------------------------------------------------------------------
// A skill fork's own SkillExecutor must reject any `skill(name)` call where
// name === ctx.skillDispatchName. This is an execution-time block — the
// manifest exclusion is only cosmetic (the model can still call the skill by
// name from its system-prompt instructions). The guard must fire BEFORE
// dispatching a new subagent fork, so a self-recursive call never escapes.

describe('SkillExecutor — self-recursion execution guard (Fix A)', () => {
  const selfName = 'guard-probe-skill';

  beforeEach(() => {
    registerSkill({
      name: selfName,
      description: 'Probe skill for self-recursion guard test',
      handler: vi.fn(),
    });
  });

  afterEach(() => {
    _resetRegistry();
  });

  it('rejects a skill call matching skillDispatchName with a clear error', async () => {
    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test-session',
        getInputStreamRef: () => undefined as never,
        abortSignal: new AbortController().signal,
      },
      // Simulate: this executor is running inside a skill fork for selfName.
      skillDispatchName: selfName,
    });

    const signal = new AbortController().signal;
    const result = await executor.execute({
      id: 'call-1',
      name: 'skill',
      input: { name: selfName },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(selfName);
    expect(result.content).toContain('cannot re-dispatch itself');
    expect(result.content).toContain('Return findings via your system prompt contract');
  });

  it('allows a DIFFERENT skill to be called from within the same executor', async () => {
    const otherName = 'other-probe-skill';
    registerSkill({
      name: otherName,
      description: 'Different skill — should not be blocked',
      handler: vi.fn().mockResolvedValue('ok'),
    });

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test-session-2',
        getInputStreamRef: () => undefined as never,
        abortSignal: new AbortController().signal,
      },
      skillDispatchName: selfName,
    });

    const signal = new AbortController().signal;
    const result = await executor.execute({
      id: 'call-2',
      name: 'skill',
      input: { name: otherName },
      signal,
    });

    // Should NOT be blocked — only selfName is guarded.
    expect(result.isError).not.toBe(true);
  });

  it('allows any skill when skillDispatchName is not set (no-op guard)', async () => {
    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test-session-3',
        getInputStreamRef: () => undefined as never,
        abortSignal: new AbortController().signal,
      },
      // No skillDispatchName → guard inactive.
    });

    const signal = new AbortController().signal;
    // selfName is registered; even if called without skillDispatchName, it
    // should NOT be rejected by the guard (guard is a no-op when unset).
    const result = await executor.execute({
      id: 'call-3',
      name: 'skill',
      input: { name: selfName },
      signal,
    });

    // Not rejected by the guard (may fail for other reasons — here the inline
    // handler returns undefined, which resolves to 'Skill completed successfully.').
    expect(result.content).not.toContain('cannot re-dispatch itself');
  });
});

// --------------------------------------------------------------------------
// Fix B: skillDispatchName propagation through buildChildConfig (#skill-recursion)
// --------------------------------------------------------------------------
// When a skill fork dispatches an `agent` child (unnamed), that child's config
// must carry skillDispatchName so the originating skill stays excluded from its
// manifest AND the execution guard fires when the child calls `skill` tool.
// Named agents must NOT inherit it (they own their own system-prompt identity).

describe('buildChildConfig — skillDispatchName propagation (Fix B)', () => {
  const fakeSignal = new AbortController().signal;

  // Minimal stub for createChildExecutor injection (circular-import seam).
  const stubCreateChildExecutor = vi.fn().mockReturnValue({});

  const baseDefaultConfig = {
    apiKey: 'sk-test',
    systemPrompt: 'You are a helpful assistant.',
    baseUrl: undefined as string | undefined,
    openaiBaseUrl: undefined as string | undefined,
    skillDispatchName: 'ground-state',
  };

  const baseParsed = {
    model: 'claude-haiku-4-5' as const,
    cwd: undefined as string | undefined,
    writeRoots: undefined as string[] | undefined,
    readRoots: undefined as string[] | undefined,
    max_turns: 0,
    max_turns_explicit: false,
    max_tool_use_iterations: 0,
    max_tool_use_iterations_explicit: false,
  };

  it('unnamed agent dispatch inherits skillDispatchName from defaultConfig', () => {
    const result = buildChildConfig({
      parsed: baseParsed as Parameters<typeof buildChildConfig>[0]['parsed'],
      namedAgent: undefined,
      depth: 1,
      maxDepth: 3,
      currentCwd: undefined,
      signal: fakeSignal,
      defaultConfig: baseDefaultConfig,
      createChildExecutor: stubCreateChildExecutor,
    });

    expect(result.childConfig.skillDispatchName).toBe('ground-state');
  });

  it('named agent dispatch does NOT inherit skillDispatchName', () => {
    const namedAgent = {
      name: 'research-agent',
      definition: {
        prompt: 'You are a research agent.',
        model: 'sonnet' as const,
        maxTurns: undefined,
        maxToolUseIterations: undefined,
        allowedTools: undefined,
        bashReadOnly: undefined,
        nestedAgentTypes: undefined,
      },
    };

    const result = buildChildConfig({
      parsed: baseParsed as Parameters<typeof buildChildConfig>[0]['parsed'],
      namedAgent: namedAgent as Parameters<typeof buildChildConfig>[0]['namedAgent'],
      depth: 1,
      maxDepth: 3,
      currentCwd: undefined,
      signal: fakeSignal,
      defaultConfig: baseDefaultConfig,
      createChildExecutor: stubCreateChildExecutor,
    });

    // Named agents own their identity — must NOT inherit the originating skill name.
    expect(result.childConfig.skillDispatchName).toBeUndefined();
  });

  it('unnamed agent dispatch with no skillDispatchName in defaultConfig propagates nothing', () => {
    const result = buildChildConfig({
      parsed: baseParsed as Parameters<typeof buildChildConfig>[0]['parsed'],
      namedAgent: undefined,
      depth: 1,
      maxDepth: 3,
      currentCwd: undefined,
      signal: fakeSignal,
      defaultConfig: {
        ...baseDefaultConfig,
        skillDispatchName: undefined,
      },
      createChildExecutor: stubCreateChildExecutor,
    });

    expect(result.childConfig.skillDispatchName).toBeUndefined();
  });
});
