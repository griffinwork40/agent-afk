/**
 * Tests for `assembleQueryPrompt` manifest scoping (#3442).
 *
 * Verifies that the model-facing skill manifest respects the scope returned by
 * `SkillExecutor.getManifestScope()`:
 *  - `pluginConfigs` as the sole plugin source
 *  - `skillAllowlist` to restrict which skills appear
 *  - No scope (undefined executor) => unchanged output
 *
 * All heavy deps are mocked so these tests are fast and dependency-free.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assembleQueryPrompt } from './prompt-assembly.js';
import type { PromptAssemblyArgs } from './prompt-assembly.js';
import type { SdkPluginConfig } from '../../../types/sdk-types.js';

// --- mocks ------------------------------------------------------------------

vi.mock('../../../tools/system-prompt.js', () => ({
  resolveToolSystemPrompt: vi.fn(() => 'TOOL_BASE'),
  resolveMemorySystemPrompt: vi.fn(() => 'MEMORY'),
  resolveWorkspaceSystemPrompt: vi.fn(() => ''),
}));

const mockBuildSkillManifest = vi.fn((_pluginConfigs?: unknown, opts?: Record<string, unknown>) => {
  const allowlist = opts?.skillAllowlist as readonly string[] | undefined;
  if (allowlist !== undefined) {
    return allowlist.includes('allowed') ? 'MANIFEST_FILTERED' : '';
  }
  return 'MANIFEST_FULL';
});

vi.mock('../../../tools/skill-bridge.js', () => ({
  buildSkillManifest: (...args: Parameters<typeof mockBuildSkillManifest>) =>
    mockBuildSkillManifest(...args),
}));

vi.mock('./system-prompt.js', () => ({
  buildStableSystemPrefix: vi.fn((parts: unknown) => parts),
  assembleSystemPrompt: vi.fn((_stable: unknown, _cwd: string, _id: unknown) => 'ASSEMBLED'),
}));

// --- helpers ----------------------------------------------------------------

function makeSkillExecutor(scope: {
  pluginConfigs?: SdkPluginConfig[];
  skillAllowlist?: readonly string[];
}) {
  return { getManifestScope: () => scope };
}

function makeArgs(
  overrides: Partial<PromptAssemblyArgs> = {},
): PromptAssemblyArgs {
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

describe('assembleQueryPrompt — manifest scoping (#3442)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no skillExecutor => buildSkillManifest not called', () => {
    assembleQueryPrompt(makeArgs({ skillExecutor: undefined }));
    expect(mockBuildSkillManifest).not.toHaveBeenCalled();
  });

  it('skillExecutor with no scope => buildSkillManifest called without pluginConfigs/allowlist', () => {
    const executor = makeSkillExecutor({});
    assembleQueryPrompt(makeArgs({ skillExecutor: executor as never }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
    const opts = mockBuildSkillManifest.mock.calls[0]?.[1];
    expect(opts?.pluginConfigs).toBeUndefined();
    expect(opts?.skillAllowlist).toBeUndefined();
  });

  it('skillAllowlist is forwarded to buildSkillManifest', () => {
    const executor = makeSkillExecutor({ skillAllowlist: ['allowed', 'other'] });
    assembleQueryPrompt(makeArgs({ skillExecutor: executor as never }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
    const opts = mockBuildSkillManifest.mock.calls[0]?.[1];
    expect(opts?.skillAllowlist).toEqual(['allowed', 'other']);
  });

  it('pluginConfigs [] is forwarded to buildSkillManifest', () => {
    const executor = makeSkillExecutor({ pluginConfigs: [] });
    assembleQueryPrompt(makeArgs({ skillExecutor: executor as never }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
    const opts = mockBuildSkillManifest.mock.calls[0]?.[1];
    expect(opts?.pluginConfigs).toEqual([]);
  });

  it('both scope fields forwarded together', () => {
    const executor = makeSkillExecutor({ pluginConfigs: [], skillAllowlist: ['x'] });
    assembleQueryPrompt(makeArgs({ skillExecutor: executor as never }));
    const opts = mockBuildSkillManifest.mock.calls[0]?.[1];
    expect(opts?.pluginConfigs).toEqual([]);
    expect(opts?.skillAllowlist).toEqual(['x']);
  });
});
