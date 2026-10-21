/**
 * Provider-level gate tests for the "Available agent types" listing (#4220).
 *
 * Two concerns:
 *   1. `grantsToolStrict` — the fail-closed helper that replaced `?? true`.
 *      Tested directly with `grantsTool` undefined, returning false, and
 *      returning true.
 *   2. `assembleQueryPrompt` — end-to-end from gate decision to prompt content.
 *      Verifies the listing is emitted/suppressed based on `agentTypeListing`.
 *
 * @module agent/providers/anthropic-direct/agent-type-gate.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assembleQueryPrompt } from './query/prompt-assembly.js';
import { grantsToolStrict } from '../shared/tool-grant.js';
import type { PromptAssemblyArgs } from './query/prompt-assembly.js';

// ---- mocks -----------------------------------------------------------------

vi.mock('../../tools/system-prompt.js', () => ({
  resolveToolSystemPrompt: vi.fn(() => 'TOOL_BASE'),
  resolveMemorySystemPrompt: vi.fn(() => 'MEMORY'),
  resolveWorkspaceSystemPrompt: vi.fn(() => ''),
}));

vi.mock('../../tools/skill-bridge.js', () => ({
  buildSkillManifest: vi.fn(() => ''),
}));

vi.mock('../../awareness/index.js', () => ({
  formatEnvironmentFragment: vi.fn(() => '# Environment\n- Working directory: /test'),
}));

// ---- helpers ---------------------------------------------------------------

const LISTING = 'Available agent types:\n- research-agent: A read-only research agent.';

function makeBaseArgs(): PromptAssemblyArgs {
  return {
    config: { cwd: '/test' } as PromptAssemblyArgs['config'],
    cwd: '/test',
    surface: 'cli',
    readOnlyMemory: false,
    readOnlyState: false,
    workspaceEnabled: false,
    skillExecutor: undefined,
    runtimeStateSource: { getWorkspace: () => undefined } as unknown as PromptAssemblyArgs['runtimeStateSource'],
    userSystem: null,
  };
}

// ---- grantsToolStrict unit tests -------------------------------------------

describe('grantsToolStrict (#4220)', () => {
  it('returns false when grantsTool is undefined (fail-closed)', () => {
    expect(grantsToolStrict(undefined, 'agent')).toBe(false);
  });

  it('returns false when grantsTool returns false', () => {
    expect(grantsToolStrict(() => false, 'agent')).toBe(false);
  });

  it('returns true only when grantsTool explicitly returns true', () => {
    expect(grantsToolStrict(() => true, 'agent')).toBe(true);
  });

  it('forwards the tool name to the callback', () => {
    const spy = vi.fn(() => true);
    grantsToolStrict(spy, 'agent');
    expect(spy).toHaveBeenCalledWith('agent');
  });
});

// ---- assembleQueryPrompt integration tests ---------------------------------

describe('anthropic-direct agent-type listing gate (#4220)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits listing when agentTypeListing is absent (agent tool not in toolDefs)', () => {
    const { toolSystemAppend } = assembleQueryPrompt(makeBaseArgs());
    expect(toolSystemAppend).not.toContain('Available agent types');
  });

  it('omits listing when agentTypeListing is empty string (grantsTool returned false)', () => {
    const { toolSystemAppend } = assembleQueryPrompt({
      ...makeBaseArgs(),
      agentTypeListing: '',
    });
    expect(toolSystemAppend).not.toContain('Available agent types');
  });

  it('includes listing when agent tool is present and grantsTool returns true', () => {
    const { toolSystemAppend } = assembleQueryPrompt({
      ...makeBaseArgs(),
      agentTypeListing: LISTING,
    });
    expect(toolSystemAppend).toContain('Available agent types');
  });
});
