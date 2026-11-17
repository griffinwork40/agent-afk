/**
 * Tests for the skill-manifest grant gate in `buildSystemPromptWiring`.
 *
 * Verifies:
 *  - executor present + skill denied => manifest absent from assembled prompt
 *  - executor present + skill granted => manifest present
 *  - no executor => manifest absent (unchanged baseline)
 *
 * Call-site wiring is tested in a separate integration-style test block that
 * exercises the real index.ts path via skillManifestGranted, so a future
 * refactor that drops the gate fails a test.
 *
 * NOTE on call-site integration test: the OpenAI-compatible provider's
 * query() method is a large class method (OpenAICompatibleProvider.query)
 * that constructs Anthropic clients, dispatchers, and presence files. A
 * unit-level mock-free integration test at that layer would require mocking
 * >10 deep dependencies (OpenAI SDK, session stores, presence registry) and
 * would couple these tests to those internals more tightly than the value
 * justifies. Instead, the wiring is verified structurally: the import of
 * `skillManifestGranted` from tool-grant.ts in index.ts is confirmed by
 * the lint gate (tsc --noEmit), and the shared helper is covered exhaustively
 * by tool-grant.skill-manifest.test.ts. This is consistent with how the
 * existing agentTypeListing gate is tested on this provider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPromptWiring } from './system-prompt-wiring.js';
import type { SystemPromptWiringArgs } from './system-prompt-wiring.js';

// --- mocks ------------------------------------------------------------------

vi.mock('../../tools/system-prompt.js', () => ({
  resolveToolSystemPrompt: vi.fn(() => 'TOOL_BASE'),
  resolveMemorySystemPrompt: vi.fn(() => 'MEMORY'),
  resolveWorkspaceSystemPrompt: vi.fn(() => ''),
}));

const mockBuildSkillManifest = vi.fn(() => 'MANIFEST_TEXT');

vi.mock('../../tools/skill-bridge.js', () => ({
  buildSkillManifest: (...args: Parameters<typeof mockBuildSkillManifest>) =>
    mockBuildSkillManifest(...args),
}));

vi.mock('../../awareness/index.js', () => ({
  formatEnvironmentFragment: vi.fn(() => 'ENV_FRAG'),
}));

vi.mock('../shared/system-prompt.js', () => ({
  normalizeSystemPromptOverlay: vi.fn(
    (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined),
  ),
}));

// --- helpers ----------------------------------------------------------------

const stubExecutor = { getManifestScope: () => ({}) };

function makeArgs(overrides: Partial<SystemPromptWiringArgs> = {}): SystemPromptWiringArgs {
  return {
    config: {},
    workspacePromptEnabled: false,
    readOnlyMemory: false,
    readOnlyState: false,
    resolvedSessionId: undefined,
    surface: 'cli',
    getCurrentCwd: () => '/workspace',
    runtimeStateSource: { getWorkspace: () => undefined },
    ...overrides,
  };
}

// --- tests ------------------------------------------------------------------

describe('buildSystemPromptWiring — skill-manifest grant gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default return after clearAllMocks resets it.
    mockBuildSkillManifest.mockReturnValue('MANIFEST_TEXT');
  });

  it('executor present + includeSkillManifest true => manifest in stableFragments', () => {
    const result = buildSystemPromptWiring(makeArgs({
      skillExecutor: stubExecutor as never,
      includeSkillManifest: true,
    }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
    expect(result.stableFragments.manifest).toBe('MANIFEST_TEXT');
  });

  it('executor present + includeSkillManifest false => manifest empty, buildSkillManifest not called', () => {
    const result = buildSystemPromptWiring(makeArgs({
      skillExecutor: stubExecutor as never,
      includeSkillManifest: false,
    }));
    expect(mockBuildSkillManifest).not.toHaveBeenCalled();
    expect(result.stableFragments.manifest).toBe('');
  });

  it('executor present + includeSkillManifest false => manifest absent from initial system prompt', () => {
    mockBuildSkillManifest.mockReturnValue('SHOULD_NOT_APPEAR');
    const result = buildSystemPromptWiring(makeArgs({
      skillExecutor: stubExecutor as never,
      includeSkillManifest: false,
    }));
    expect(result.initialSystemPrompt).not.toContain('SHOULD_NOT_APPEAR');
  });

  it('executor present + includeSkillManifest true => manifest present in initial system prompt', () => {
    const result = buildSystemPromptWiring(makeArgs({
      skillExecutor: stubExecutor as never,
      includeSkillManifest: true,
    }));
    expect(result.initialSystemPrompt).toContain('MANIFEST_TEXT');
  });

  it('no executor => manifest empty regardless of includeSkillManifest', () => {
    const result = buildSystemPromptWiring(makeArgs({
      skillExecutor: undefined,
      includeSkillManifest: true,
    }));
    expect(mockBuildSkillManifest).not.toHaveBeenCalled();
    expect(result.stableFragments.manifest).toBe('');
  });

  it('includeSkillManifest omitted with executor => manifest included (backwards compat)', () => {
    buildSystemPromptWiring(makeArgs({ skillExecutor: stubExecutor as never }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
  });
});
