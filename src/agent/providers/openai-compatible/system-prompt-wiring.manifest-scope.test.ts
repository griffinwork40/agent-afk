/**
 * Tests for `buildSystemPromptWiring` manifest scoping (#3442).
 *
 * Verifies that the model-facing skill manifest respects the scope returned by
 * `SkillExecutor.getManifestScope()`:
 *  - `pluginConfigs` as the sole plugin source
 *  - `skillAllowlist` to restrict which skills appear
 *  - No executor => buildSkillManifest not called (unchanged output)
 *
 * Heavy deps are mocked for speed and isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPromptWiring } from './system-prompt-wiring.js';
import type { SystemPromptWiringArgs } from './system-prompt-wiring.js';
import type { SdkPluginConfig } from '../../types/sdk-types.js';

// --- mocks ------------------------------------------------------------------

vi.mock('../../tools/system-prompt.js', () => ({
  resolveToolSystemPrompt: vi.fn(() => 'TOOL_BASE'),
  resolveMemorySystemPrompt: vi.fn(() => 'MEMORY'),
  resolveWorkspaceSystemPrompt: vi.fn(() => ''),
}));

const mockBuildSkillManifest = vi.fn(() => '');

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

function makeSkillExecutor(scope: {
  pluginConfigs?: SdkPluginConfig[];
  skillAllowlist?: readonly string[];
}) {
  return { getManifestScope: () => scope };
}

function makeArgs(overrides: Partial<SystemPromptWiringArgs> = {}): SystemPromptWiringArgs {
  return {
    config: {},
    hasWorkspaceStore: false,
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

describe('buildSystemPromptWiring — manifest scoping (#3442)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no skillExecutor => buildSkillManifest not called', () => {
    buildSystemPromptWiring(makeArgs({ skillExecutor: undefined }));
    expect(mockBuildSkillManifest).not.toHaveBeenCalled();
  });

  it('skillExecutor with no scope => buildSkillManifest called without allowlist or pluginConfigs', () => {
    const executor = makeSkillExecutor({});
    buildSystemPromptWiring(makeArgs({ skillExecutor: executor as never }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
    const opts = mockBuildSkillManifest.mock.calls[0]?.[1];
    expect(opts?.skillAllowlist).toBeUndefined();
    expect(opts?.pluginConfigs).toBeUndefined();
  });

  it('skillAllowlist is forwarded to buildSkillManifest', () => {
    const executor = makeSkillExecutor({ skillAllowlist: ['mint', 'review'] });
    buildSystemPromptWiring(makeArgs({ skillExecutor: executor as never }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
    const opts = mockBuildSkillManifest.mock.calls[0]?.[1];
    expect(opts?.skillAllowlist).toEqual(['mint', 'review']);
  });

  it('pluginConfigs [] is forwarded to buildSkillManifest', () => {
    const executor = makeSkillExecutor({ pluginConfigs: [] });
    buildSystemPromptWiring(makeArgs({ skillExecutor: executor as never }));
    expect(mockBuildSkillManifest).toHaveBeenCalledOnce();
    const opts = mockBuildSkillManifest.mock.calls[0]?.[1];
    expect(opts?.pluginConfigs).toEqual([]);
  });

  it('both scope fields forwarded together', () => {
    const executor = makeSkillExecutor({ pluginConfigs: [], skillAllowlist: ['mint'] });
    buildSystemPromptWiring(makeArgs({ skillExecutor: executor as never }));
    const opts = mockBuildSkillManifest.mock.calls[0]?.[1];
    expect(opts?.pluginConfigs).toEqual([]);
    expect(opts?.skillAllowlist).toEqual(['mint']);
  });
});
