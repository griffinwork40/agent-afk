/**
 * Unit tests for `buildSystemPromptWiring` — specifically the preset-append
 * clear/preserve semantics fixed in #3305, and the toolBase empty-guard for
 * unnamed workers fixed in #3359.
 *
 * The real `normalizeSystemPromptOverlay` from `../shared/system-prompt` is
 * used intentionally so changes to that normalizer surface here too.
 * Everything else is mocked to keep the tests fast and dependency-free.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPromptWiring } from './system-prompt-wiring.js';
import type { SystemPromptWiringArgs } from './system-prompt-wiring.js';
import * as systemPromptMod from '../../tools/system-prompt.js';

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
      model: 'sonnet',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: APPEND },
    } as SystemPromptWiringArgs['config'],
    skillExecutor: undefined,
    workspacePromptEnabled: false,
    readOnlyMemory: false,
    readOnlyState: false,
    resolvedSessionId: undefined,
    surface: 'cli',
    getCurrentCwd: () => '/test',
    runtimeStateSource: { getWorkspace: () => undefined } as unknown as SystemPromptWiringArgs['runtimeStateSource'],
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

describe('buildSystemPromptWiring — agentTypeListing injection (#4217)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects agentTypeListing into the initial prompt when provided', () => {
    const { initialSystemPrompt } = buildSystemPromptWiring(
      makeArgs({ agentTypeListing: 'AGENT_LISTING' }),
    );
    expect(initialSystemPrompt).toContain('AGENT_LISTING');
  });

  it('does not inject listing when agentTypeListing is absent (agent tool not in schema)', () => {
    const { initialSystemPrompt } = buildSystemPromptWiring(makeArgs());
    expect(initialSystemPrompt).not.toContain('Available agent types');
  });

  it('does not inject listing when agentTypeListing is empty string', () => {
    const { initialSystemPrompt } = buildSystemPromptWiring(
      makeArgs({ agentTypeListing: '' }),
    );
    expect(initialSystemPrompt).not.toContain('Available agent types');
  });
});

describe('buildSystemPromptWiring — agent-type gate: grantsTool=false (#4220)', () => {
  /**
   * The gate in openai-compatible/index.ts:
   *   `this.schemas.some(s => s.name === 'agent') && this.grantsTool('agent')`
   * passes '' to buildSystemPromptWiring when either condition is false.
   * These tests verify that buildSystemPromptWiring correctly suppresses the
   * listing in both cases — the "grantsTool=false" path (#4220 item 2 & 3).
   */
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits listing when agent schema present but grantsTool returns false (empty string passed)', () => {
    // Simulates: this.schemas.some(s => s.name === 'agent') === true
    // but this.grantsTool('agent') === false → caller passes agentTypeListing: ''
    const { initialSystemPrompt } = buildSystemPromptWiring(
      makeArgs({ agentTypeListing: '' }),
    );
    expect(initialSystemPrompt).not.toContain('Available agent types');
  });

  it('omits listing when agent schema absent (no executor wired) and grantsTool is irrelevant', () => {
    // Simulates: this.schemas.some(s => s.name === 'agent') === false →
    // gate short-circuits, caller passes agentTypeListing: undefined
    const { initialSystemPrompt } = buildSystemPromptWiring(makeArgs());
    expect(initialSystemPrompt).not.toContain('Available agent types');
  });

  it('includes listing only when both schema present and grantsTool returns true', () => {
    // Simulates: schemas includes agent AND grantsTool('agent') === true →
    // caller passes the real listing string.
    const LISTING = 'Available agent types:\n- research-agent: Read-only research.';
    const { initialSystemPrompt } = buildSystemPromptWiring(
      makeArgs({ agentTypeListing: LISTING }),
    );
    expect(initialSystemPrompt).toContain('Available agent types');
  });
});

describe('buildSystemPromptWiring — unnamed-worker toolBase dedupe guard (#3359)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // For unnamed workers, resolveToolSystemPrompt returns '' — the base
    // conventions are already embedded in UNNAMED_SUBAGENT_WORKER_PROMPT
    // (which becomes config.systemPrompt). Returning '' exercises the
    // `toolBase.length > 0 ? [toolBase] : []` guard in `assemble`.
    vi.mocked(systemPromptMod.resolveToolSystemPrompt).mockReturnValueOnce('');
  });

  it('unnamed worker: resolveToolSystemPrompt called with (undefined, true) and result not prepended', () => {
    const { initialSystemPrompt } = buildSystemPromptWiring(
      makeArgs({ config: { model: 'sonnet', isUnnamedWorker: true } as SystemPromptWiringArgs['config'] }),
    );
    // Verify the call site passes isSkillDispatch=undefined and isUnnamedWorker=true.
    expect(systemPromptMod.resolveToolSystemPrompt).toHaveBeenCalledWith(undefined, true);
    // The assembled prompt must not start with a blank line (which would happen
    // if '' were pushed into parts[] before the join('\n\n')).
    expect(initialSystemPrompt).not.toMatch(/^\n/);
  });
});
