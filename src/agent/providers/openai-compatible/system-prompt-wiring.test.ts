/**
 * Unit tests for `buildSystemPromptWiring` — specifically the preset-append
 * clear/preserve semantics fixed in #3305.
 *
 * The real `normalizeSystemPromptOverlay` from `../shared/system-prompt` is
 * used intentionally so changes to that normalizer surface here too.
 * Everything else is mocked to keep the tests fast and dependency-free.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPromptWiring } from './system-prompt-wiring.js';
import type { SystemPromptWiringArgs } from './system-prompt-wiring.js';

// ---- mocks ----------------------------------------------------------------

vi.mock('../../tools/system-prompt.js', () => ({
  resolveToolSystemPrompt: vi.fn(() => 'TOOL_BASE'),
  resolveMemorySystemPrompt: vi.fn(() => 'MEMORY'),
  resolveWorkspaceSystemPrompt: vi.fn(() => ''),
}));

vi.mock('../../tools/skill-bridge.js', () => ({
  buildSkillManifest: vi.fn(() => ''),
}));

vi.mock('../../awareness/index.js', () => ({
  formatEnvironmentFragment: vi.fn(() => 'ENV_FRAG'),
}));

// ---- helpers ---------------------------------------------------------------

const APPEND = 'CUSTOM_APPEND_TEXT';

function makeArgs(
  overrides: Partial<SystemPromptWiringArgs> = {},
): SystemPromptWiringArgs {
  return {
    config: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: APPEND },
    },
    hasSkillExecutor: false,
    hasWorkspaceStore: false,
    readOnlyMemory: false,
    readOnlyState: false,
    resolvedSessionId: undefined,
    surface: 'cli',
    getCurrentCwd: () => '/test',
    runtimeStateSource: { getWorkspace: () => undefined },
    ...overrides,
  };
}

// ---- tests -----------------------------------------------------------------

describe('buildSystemPromptWiring — preset append semantics (#3305)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preset append text is present in initial prompt', () => {
    const { initialSystemPrompt } = buildSystemPromptWiring(makeArgs());
    expect(initialSystemPrompt).toContain(APPEND);
  });

  it('systemPromptRebuildFactory(undefined) clears the preset append', () => {
    const { systemPromptRebuildFactory } = buildSystemPromptWiring(makeArgs());
    const result = systemPromptRebuildFactory(undefined);
    expect(result).not.toContain(APPEND);
  });

  it('rebuildAfterCwdChange preserves preset append when base was never overridden', () => {
    const { rebuildAfterCwdChange } = buildSystemPromptWiring(makeArgs());
    // systemPromptRebuildFactory is deliberately NOT called first.
    const result = rebuildAfterCwdChange();
    expect(result).toContain(APPEND);
  });

  it('rebuildAfterCwdChange uses replacement base after setSystemPrompt', () => {
    const { systemPromptRebuildFactory, rebuildAfterCwdChange } =
      buildSystemPromptWiring(makeArgs());
    systemPromptRebuildFactory('NEW_BASE');
    const result = rebuildAfterCwdChange();
    expect(result).toContain('NEW_BASE');
    expect(result).not.toContain(APPEND);
  });

  it('rebuildAfterCwdChange clears base after systemPromptRebuildFactory(undefined)', () => {
    const { systemPromptRebuildFactory, rebuildAfterCwdChange } =
      buildSystemPromptWiring(makeArgs());
    systemPromptRebuildFactory(undefined);
    const result = rebuildAfterCwdChange();
    expect(result).not.toContain(APPEND);
  });
});
