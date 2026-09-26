/**
 * Tests that `afk chat -f json` emits `sessionId`, `witnessLabel`, and
 * `tracePath` in its JSON output when a trace writer is available.
 *
 * These fields let headless runners (like the workspace A/B runner) locate the
 * witness trace without racing against concurrent sessions via `ls -t`.
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────

async function* makeStream(events: OutputEvent[]): AsyncIterable<OutputEvent> {
  for (const event of events) yield event;
}

vi.mock('../../agent/session.js', () => ({
  AgentSession: vi.fn().mockImplementation(() => ({
    close: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ content: 'reply', timestamp: new Date() }),
    sendMessageStream: vi.fn().mockReturnValue(makeStream([{ type: 'done' }])),
    getLastResponseMetadata: vi.fn().mockReturnValue(null),
    getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: vi.fn() }),
    sessionId: 'test-session-uuid',
    abortSignal: new AbortController().signal,
  })),
}));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ model: 'sonnet', maxTokens: 4096 })),
}));

vi.mock('../shared-helpers.js', () => ({
  parseThinking: vi.fn(() => undefined),
  parseEffort: vi.fn(() => undefined),
  parseBudget: vi.fn(() => undefined),
  parseMaxOutputTokens: vi.fn(() => undefined),
  parseProvider: vi.fn(() => undefined),
  getApiKey: vi.fn(() => 'test-key'),
  getApiKeyForModel: vi.fn(() => 'test-key'),
  getModel: vi.fn(() => 'sonnet'),
  getThinking: vi.fn(() => undefined),
  getEffort: vi.fn(() => undefined),
  getMaxBudgetUsd: vi.fn(() => undefined),
  getTaskBudget: vi.fn(() => undefined),
  getMaxOutputTokens: vi.fn(() => undefined),
  getMaxToolUseIterations: vi.fn(() => undefined),
  getDefaultSubagentModel: vi.fn(() => 'sonnet'),
  explicitProviderHints: vi.fn(() => undefined),
  loadSystemPrompt: vi.fn(() => undefined),
  loadConfigSystemPrompt: vi.fn(() => undefined),
  resolveBaseSystemPrompt: vi.fn(() => ({ prompt: undefined, source: 'none' })),
  activateDumpPrompt: vi.fn(),
}));

vi.mock('../../agent/routing-directive.js', () => ({
  assembleSystemPrompt: vi.fn(() => undefined),
}));

vi.mock('../../agent/default-hook-registry.js', () => ({
  createDefaultHookRegistry: vi.fn(() => ({ registry: {} })),
}));

vi.mock('../../agent/memory/index.js', () => ({
  MemoryStore: vi.fn(() => ({ close: vi.fn() })),
  injectHotMemory: (c: unknown) => c,
  injectGoalPrompt: (config: unknown) => config,
  MEMORY_TOOL_NAMES: [],
}));

vi.mock('../../agent/subagent.js', () => {
  class StubManager {
    setOnSubagentSucceeded = vi.fn();
  }
  return { SubagentManager: StubManager };
});

vi.mock('../../agent/tools/subagent-executor.js', () => ({
  SubagentExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../agent/tools/skill-executor.js', () => ({
  SkillExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../agent/tools/compose-executor.js', () => {
  class StubCompose {
    setOnSubagentSucceeded = vi.fn();
  }
  return { ComposeExecutor: StubCompose };
});

vi.mock('../../agent/tools/nesting.js', () => ({
  createChildProviderFactory: vi.fn(() => ({})),
  createChildSkillExecutorFactory: vi.fn(() => ({})),
  resolveMaxNestingDepth: vi.fn(() => 3),
}));

vi.mock('../../agent/providers/anthropic-direct/index.js', () => ({
  AnthropicDirectProvider: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../agent/tools/schemas.js', () => ({
  BUILTIN_TOOL_NAMES: [],
  builtinToolSchemas: [],
  agentTool: { name: 'agent', input_schema: { type: 'object' as const } },
  skillTool: { name: 'skill', input_schema: { type: 'object' as const } },
  composeTool: { name: 'compose', input_schema: { type: 'object' as const } },
}));

vi.mock('./interactive/progress-banner.js', () => ({
  formatSubagentCompletion: vi.fn(() => ''),
}));

vi.mock('./interactive/worktree.js', () => ({
  setupWorktree: vi.fn(),
}));

vi.mock('../errors/index.js', () => ({
  handleCommandError: vi.fn((err: unknown): never => {
    throw err instanceof Error ? err : new Error(String(err));
  }),
}));

vi.mock('../resume-session.js', () => ({
  resolveResumeTarget: vi.fn(() => undefined),
  resumeConfigFor: vi.fn(() => ({})),
}));

vi.mock('../session-store.js', () => ({
  saveSession: vi.fn(() => '/tmp/mock.json'),
  findSession: vi.fn(() => undefined),
}));

vi.mock('../slash/session-stats.js', () => ({
  createSessionStats: vi.fn(() => ({
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
    sessionId: 'test-session-uuid',
  })),
  recordTurn: vi.fn(() => ({ user: '', assistant: '', timestamp: Date.now() })),
}));

vi.mock('../../agent/tools/skill-bridge.js', () => ({
  ensurePluginEntrypointsLoaded: vi.fn(async () => {}),
  discoverPluginAgents: vi.fn(() => []),
}));

vi.mock('../../config/import-sources.js', () => ({
  loadImportFromConfig: vi.fn(() => ({})),
  resolveImportedRoots: vi.fn(() => ({ mcpConfigs: [] })),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { registerChatCommand } from './chat.js';
import * as traceFactory from '../../agent/trace/factory.js';
// chat.json-output is a pure module — no mock needed.

// ─── Helpers ────────────────────────────────────────────────────────────────

async function runChat(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerChatCommand(program);
  await program.parseAsync(['node', 'afk', 'chat', ...args]);
}

async function captureJsonOutput(fn: () => Promise<void>): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  const raw = chunks.join('');
  return JSON.parse(raw) as Record<string, unknown>;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('afk chat -f json — trace identity fields', () => {
  it('omits witnessLabel and tracePath when createDefaultTraceWriter returns null', async () => {
    // The vi.mock factory above already mocks createDefaultTraceWriter as
    // vi.fn(() => null).  Override for this test to ensure null branch.
    vi.spyOn(traceFactory, 'createDefaultTraceWriter').mockReturnValueOnce(null);
    const output = await captureJsonOutput(() => runChat('hello', '--format', 'json'));
    expect(output['success']).toBe(true);
    // witnessLabel and tracePath are only populated from the trace writer.
    expect(output['witnessLabel']).toBeUndefined();
    expect(output['tracePath']).toBeUndefined();
    // sessionId is still present (from the session itself, not the trace).
    expect(typeof output['sessionId']).toBe('string');
  });

  it('includes sessionId, witnessLabel, and tracePath when trace writer is non-null', async () => {
    vi.spyOn(traceFactory, 'createDefaultTraceWriter').mockReturnValueOnce({
      writer: { write: vi.fn(), seal: vi.fn() } as unknown as import('../../agent/trace/writer.js').TraceWriter,
      tracePath: '/home/.afk/state/witness/test-label/trace.jsonl',
      sessionLabel: 'test-label',
    });
    const output = await captureJsonOutput(() => runChat('hello', '--format', 'json'));
    expect(output['success']).toBe(true);
    // tracePath comes from the trace stub
    expect(output['tracePath']).toBe('/home/.afk/state/witness/test-label/trace.jsonl');
    expect(output['witnessLabel']).toBe('test-label');
    // sessionId comes from AgentSession.sessionId mock ('test-session-uuid')
    expect(output['sessionId']).toBe('test-session-uuid');
  });
});
