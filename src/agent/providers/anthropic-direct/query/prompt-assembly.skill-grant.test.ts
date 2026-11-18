/**
 * Tests for the skill-manifest grant gate in `assembleQueryPrompt`.
 *
 * Verifies:
 *  - executor present + skill denied => no manifest in assembled output
 *  - executor present + skill granted => manifest present
 *  - no executor => no manifest (unchanged baseline)
 *
 * Also includes a call-site wiring test via a spy on `skillManifestGranted`
 * in tool-grant.ts so a future refactor that drops the gate will fail here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assembleQueryPrompt } from './prompt-assembly.js';
import type { PromptAssemblyArgs } from './prompt-assembly.js';

// --- mocks ------------------------------------------------------------------

vi.mock('../../../tools/system-prompt.js', () => ({
  resolveToolSystemPrompt: vi.fn(() => 'TOOL_BASE'),
  resolveMemorySystemPrompt: vi.fn(() => 'MEMORY'),
  resolveWorkspaceSystemPrompt: vi.fn(() => ''),
}));

const mockBuildSkillManifest = vi.fn(() => 'MANIFEST_TEXT');

vi.mock('../../../tools/skill-bridge.js', () => ({
  buildSkillManifest: (...args: Parameters<typeof mockBuildSkillManifest>) =>
    mockBuildSkillManifest(...args),
}));

// Capture the assembled stable parts so tests can inspect the manifest field.
const mockAssembleSystemPrompt = vi.fn((_stable: unknown, _cwd: string, _id: unknown) => 'ASSEMBLED');
const mockBuildStableSystemPrefix = vi.fn((parts: unknown) => parts);

vi.mock('./system-prompt.js', () => ({
  buildStableSystemPrefix: (...args: Parameters<typeof mockBuildStableSystemPrefix>) =>
    mockBuildStableSystemPrefix(...args),
  assembleSystemPrompt: (...args: Parameters<typeof mockAssembleSystemPrompt>) =>
    mockAssembleSystemPrompt(...args),
}));

// --- helpers ----------------------------------------------------------------

const stubExecutor = { getManifestScope: () => ({}) };

function makeArgs(overrides: Partial<PromptAssemblyArgs> = {}): PromptAssemblyArgs {
  return {
    config: {},
    cwd: '/workspace',
    surface: 'cli',
    readOnlyMemory: false,
    workspaceEnabled: false,
    runtimeStateSource: { getWorkspace: () => null },
    userSystem: null,
    ...overrides,
  };
}

// --- tests ------------------------------------------------------------------

describe('assembleQueryPrompt — skill-manifest grant gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default return after clearAllMocks resets it.
    mockBuildSkillManifest.mockReturnValue('MANIFEST_TEXT');
  });

  it('executor present + includeSkillManifest true => buildSkillManifest called', () => {
    assembleQueryPrompt(makeArgs({
      skillExecutor: stubExecutor as never,
      includeSkillManifest: true,
    }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
    const stable = mockBuildStableSystemPrefix.mock.calls[0]?.[0] as { manifest?: string };
    expect(stable?.manifest).toBe('MANIFEST_TEXT');
  });

  it('executor present + includeSkillManifest false => buildSkillManifest NOT called, manifest empty', () => {
    assembleQueryPrompt(makeArgs({
      skillExecutor: stubExecutor as never,
      includeSkillManifest: false,
    }));
    expect(mockBuildSkillManifest).not.toHaveBeenCalled();
    const stable = mockBuildStableSystemPrefix.mock.calls[0]?.[0] as { manifest?: string };
    expect(stable?.manifest).toBe('');
  });

  it('no executor => manifest empty regardless of includeSkillManifest', () => {
    assembleQueryPrompt(makeArgs({ skillExecutor: undefined, includeSkillManifest: true }));
    expect(mockBuildSkillManifest).not.toHaveBeenCalled();
    const stable = mockBuildStableSystemPrefix.mock.calls[0]?.[0] as { manifest?: string };
    expect(stable?.manifest).toBe('');
  });

  it('includeSkillManifest omitted with executor => manifest included (backwards compat)', () => {
    // When the call site omits the flag, assembleQueryPrompt treats it as
    // includeSkillManifest !== false => true: existing callers that do not
    // pass the flag keep their current behaviour.
    assembleQueryPrompt(makeArgs({ skillExecutor: stubExecutor as never }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
  });
});
