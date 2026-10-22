import { expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../agent/types.js';
const captured = vi.hoisted(() => ({ config: undefined as AgentConfig | undefined }));
vi.mock('../../../agent/session.js', () => ({ AgentSession: class { constructor(config: AgentConfig) { captured.config = config; } } }));
vi.mock('../../../agent/memory/index.js', () => ({ injectHotMemory: (c: unknown) => c, injectGoalPrompt: (c: unknown) => c, MemoryStore: class {} }));
vi.mock('../../../agent/companion/index.js', () => ({ injectCompanionPrimer: (c: unknown) => c }));
vi.mock('../../shared-helpers.js', () => ({ getApiKeyForModel: () => 'test', explicitProviderHints: () => ({}) }));
import { buildAgentSession } from './bootstrap-session-builder.js';
import { createHookRegistry } from '../../../agent/hook-registry.js';

it('REPL session builder opts into install consent at the actual session construction boundary', () => {
  buildAgentSession({
    model: 'sonnet', resumeConfig: {}, systemPrompt: undefined, systemPromptSource: undefined,
    thinking: undefined, effort: undefined, maxOutputTokens: undefined, maxToolUseIterations: undefined,
    maxBudgetUsd: undefined, providerFactory: vi.fn(), hookRegistry: createHookRegistry(),
    traceWriter: undefined, cwd: undefined, maxTurns: 10, autoResumeOnUsageLimit: undefined,
  });
  expect(captured.config).toMatchObject({ surface: 'cli', lspInstallAllowed: true });
});
