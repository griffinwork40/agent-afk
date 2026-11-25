import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockProvider } from '../../agent/__fixtures__/mock-provider.js';
import type { ChatSessionSetupParams } from './chat.session-setup.js';

const mocks = vi.hoisted(() => ({
  drain: vi.fn<(...args: unknown[]) => Promise<void>>(),
  dispose: vi.fn<() => void>(),
}));

vi.mock('../../agent/session/wire-executors.js', () => ({
  wireExecutors: () => ({
    rootManager: {
      abortAllAndDrain: mocks.drain,
      getPendingChildTerminalWrites: () => [],
      getPendingChildBillingStreams: () => [],
    },
    subagentExecutor: {}, skillExecutor: {},
    composeExecutor: { getPendingChildBillingStreams: () => [] },
    continuationRegistry: { dispose: mocks.dispose },
  }),
}));
vi.mock('../../agent/tools/skill-bridge.js', () => ({ ensurePluginEntrypointsLoaded: async () => {} }));
vi.mock('../../agent/default-hook-registry.js', () => ({ createDefaultHookRegistry: () => ({ registry: undefined }) }));
vi.mock('../../agent/hooks/config-loader.js', () => ({ loadHooksConfig: () => ({}) }));
vi.mock('../../agent/memory/index.js', () => ({
  MemoryStore: class { close(): void {} },
  MEMORY_TOOL_NAMES: [],
  injectHotMemory: (config: unknown) => config,
  injectEpisodeRecall: (config: unknown) => config,
  injectGoalPrompt: (config: unknown) => config,
}));
vi.mock('../../agent/state/state-store.js', () => ({ StateStore: class { close(): void {} } }));
vi.mock('../../agent/workspace/workspace-store.js', () => ({ WorkspaceStore: class { close(): void {} } }));
vi.mock('../../agent/companion/index.js', () => ({ injectCompanionPrimer: (config: unknown) => config }));
vi.mock('../shared-helpers.js', () => ({
  parseProvider: () => createMockProvider(),
  getApiKeyForModel: () => 'test-key', getModel: () => 'sonnet', getDefaultSubagentModel: () => 'sonnet',
}));
vi.mock('../../agent/auth/credential-source.js', () => ({ tryCredentialSourceForModel: () => undefined }));
// Partial mock: `afk acp` now selects its provider through the real
// parseProvider, which needs this module's other exports (selectCliProvider).
vi.mock('../provider-selection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../provider-selection.js')>()),
  cliProviderFamily: () => 'anthropic',
}));
vi.mock('../../agent/providers/anthropic-direct/index.js', () => ({
  AnthropicDirectProvider: class { query = createMockProvider().query; name = 'mock'; },
}));
vi.mock('../../agent/providers/openai-compatible/index.js', () => ({ OpenAICompatibleProvider: class {} }));
vi.mock('../../agent/providers/xai/index.js', () => ({ XaiProvider: class {} }));
vi.mock('./chat.browser-teardown.js', () => ({ closeLazyBrowser: async () => {} }));

import { buildChatSession } from './chat.session-setup.js';
import { buildAcpSession, closeAcpSession } from './acp.session.js';
import { runSessionTeardown } from './chat.action-body.js';
import { createSessionStats } from '../slash/session-stats.js';

function chatParams(): ChatSessionSetupParams {
  return {
    model: 'sonnet', sessionModel: 'sonnet', apiKey: 'test-key', maxTurns: 1,
    systemPrompt: undefined, systemPromptSource: undefined, basePrompt: undefined,
    providerHints: undefined, providerRaw: undefined, thinking: undefined, effort: undefined,
    maxBudgetUsd: undefined, taskBudget: undefined, maxOutputTokens: undefined,
    maxToolUseIterations: undefined, worktreeCwd: undefined, traceWriter: undefined,
    mcpManager: undefined, resumeConfig: {}, permissionMode: undefined,
    temperature: undefined, baseUrl: undefined,
    openaiBaseUrl: undefined, autoResumeOnUsageLimit: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.drain.mockResolvedValue(undefined);
});

describe('surface session-end continuation cleanup', () => {
  for (const rejects of [false, true]) {
    it(`chat teardown disposes after drain (rejects=${rejects})`, async () => {
      const built = await buildChatSession(chatParams());
      await built.session.waitForInitialization();
      if (rejects) mocks.drain.mockRejectedValue(new Error('drain failed'));
      expect(mocks.dispose).not.toHaveBeenCalled();
      await runSessionTeardown({
        shouldPersist: false, stats: createSessionStats('sonnet'), persistId: undefined,
        encounteredError: rejects, session: built.session, receiptTracePath: undefined,
        mcpManagerRef: undefined, teardownStores: built, worktreeHandle: undefined,
      });
      expect(mocks.drain).toHaveBeenCalledOnce();
      expect(mocks.dispose).toHaveBeenCalledOnce();
      expect(mocks.dispose.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.drain.mock.invocationCallOrder[0] ?? Infinity);
    });

    it(`ACP close disposes after drain (rejects=${rejects})`, async () => {
      const handle = await buildAcpSession({ model: 'sonnet', maxTurns: 1 });
      await handle.session.waitForInitialization();
      if (rejects) mocks.drain.mockRejectedValue(new Error('drain failed'));
      expect(mocks.dispose).not.toHaveBeenCalled();
      await closeAcpSession(handle);
      expect(mocks.drain).toHaveBeenCalledOnce();
      expect(mocks.dispose).toHaveBeenCalledOnce();
      expect(mocks.dispose.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.drain.mock.invocationCallOrder[0] ?? Infinity);
    });
  }
});
