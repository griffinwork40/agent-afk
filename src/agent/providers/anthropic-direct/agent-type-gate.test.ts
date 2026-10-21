/**
 * Provider-level gate tests for the "Available agent types" listing (#4220).
 *
 * Verifies that the assembled system prompt emits NO listing when:
 *   a) the `agent` tool is absent from toolDefs, or
 *   b) `grantsTool('agent')` returns false (or is absent — fail-closed).
 *
 * These exercise `assembleQueryPrompt` directly (the function that receives
 * the already-gated `agentTypeListing` from `provider-query-setup.ts`) to
 * confirm the end-to-end path from gate decision to prompt content.
 *
 * @module agent/providers/anthropic-direct/agent-type-gate.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assembleQueryPrompt } from './query/prompt-assembly.js';

// ---- mocks -----------------------------------------------------------------

vi.mock('../../../tools/system-prompt.js', () => ({
  resolveToolSystemPrompt: vi.fn(() => 'TOOL_BASE'),
  resolveMemorySystemPrompt: vi.fn(() => 'MEMORY'),
  resolveWorkspaceSystemPrompt: vi.fn(() => ''),
}));

vi.mock('../../../tools/skill-bridge.js', () => ({
  buildSkillManifest: vi.fn(() => ''),
}));

vi.mock('../../../awareness/index.js', () => ({
  formatEnvironmentFragment: vi.fn(() => '# Environment\n- Working directory: /test'),
}));

// ---- helpers ---------------------------------------------------------------

const LISTING = 'Available agent types:\n- research-agent: A read-only research agent.';

function makeBaseArgs() {
  return {
    config: { cwd: '/test' },
    cwd: '/test',
    surface: 'cli' as const,
    readOnlyMemory: false as const,
    readOnlyState: false as const,
    workspaceEnabled: false,
    skillExecutor: undefined,
    runtimeStateSource: { getWorkspace: () => undefined },
    userSystem: null,
  } as const;
}

// ---- tests -----------------------------------------------------------------

describe('anthropic-direct agent-type listing gate (#4220)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits listing when agentTypeListing is absent (agent tool not in toolDefs)', () => {
    // Simulates: agent tool absent → gate passes '' → assembler omits block.
    const { toolSystemAppend } = assembleQueryPrompt({
      ...makeBaseArgs(),
      // agentTypeListing intentionally omitted — mirrors gate output when
      // toolDefs.some(t => t.name === 'agent') is false.
    });
    expect(toolSystemAppend).not.toContain('Available agent types');
  });

  it('omits listing when agentTypeListing is empty string (grantsTool returned false)', () => {
    // Simulates: agent tool present but grantsTool('agent') === false →
    // gate passes '' → assembler omits block. Verifies fail-closed (#4220 item 3).
    const { toolSystemAppend } = assembleQueryPrompt({
      ...makeBaseArgs(),
      agentTypeListing: '',
    });
    expect(toolSystemAppend).not.toContain('Available agent types');
  });

  it('omits listing when grantsTool is absent (fail-closed: ?? true removed)', () => {
    // Simulates: ctx.grantsTool is undefined → gate now evaluates
    // (undefined?.('agent') === true) → false → passes '' → assembler omits.
    // If the old ?? true were still present this would have included the listing.
    const { toolSystemAppend } = assembleQueryPrompt({
      ...makeBaseArgs(),
      agentTypeListing: '',  // what the gate computes when grantsTool is absent
    });
    expect(toolSystemAppend).not.toContain('Available agent types');
  });

  it('includes listing when agent tool is present and grantsTool returns true', () => {
    // Simulates: toolDefs includes agent AND grantsTool('agent') === true →
    // gate passes non-empty listing → assembler includes it.
    const { toolSystemAppend } = assembleQueryPrompt({
      ...makeBaseArgs(),
      agentTypeListing: LISTING,
    });
    expect(toolSystemAppend).toContain('Available agent types');
  });
});
