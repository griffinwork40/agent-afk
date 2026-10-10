/**
 * Hermetic unit tests for the audit-fit skill handler.
 *
 * Mocks out SubagentManager, runWave, loadSkillPrompts, and the discovery
 * helpers so these tests are fully isolated from real ~/.afk and from live
 * subagent dispatch. Filesystem writes (briefs, telemetry) land in a temp-dir
 * fixture routed through the AFK_HOME override that redirect-paths-env.ts
 * installs for the whole suite.
 *
 * Coverage targets:
 *   - src/skills/audit-fit/index.ts        (re-exports + registration)
 *   - src/skills/audit-fit/handler.ts      (discovery, inspector dispatch,
 *                                            verdict validation, brief writing,
 *                                            telemetry, error paths)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// vi.mock declarations — must be before any imports from the mocked modules.
// ---------------------------------------------------------------------------

// Mock SubagentManager: all forkSubagent calls return a minimal handle;
// we override the per-test mock behaviour via `mockForkImpl`.
const mockForkImpl = vi.hoisted(() =>
  vi.fn(async (_opts: unknown) => ({
    id: 'mock-handle',
    status: 'idle',
    session: {},
    run: vi.fn(),
    runToResult: vi.fn(async () => ({ id: 'mock-handle', status: 'succeeded' })),
    runInBackground: vi.fn(),
    cancel: vi.fn(),
    teardown: vi.fn(async () => undefined),
  })),
);

vi.mock('../../agent/subagent.js', () => ({
  SubagentManager: vi.fn(function () {
    return {
      forkSubagent: mockForkImpl,
      teardownAll: vi.fn(async () => undefined),
    };
  }),
}));

// Mock runWave: returns one result per config; shape controlled per test.
const mockRunWaveImpl = vi.hoisted(() =>
  vi.fn(async (tasks: Array<{ handle: unknown; prompt: string }>) =>
    tasks.map(() => ({
      id: 'mock-run',
      status: 'succeeded' as const,
      output: [] as unknown[],
    })),
  ),
);
vi.mock('../../agent/subagent/wave.js', () => ({
  runWave: mockRunWaveImpl,
}));

// Mock resolveChildModel so tests don't need real session config.
vi.mock('../../agent/subagent/resolve-child-model.js', () => ({
  resolveChildModel: vi.fn(() => 'claude-test-model'),
}));

// Mock discover helpers so we control what artifacts are returned.
const mockDiscoverUserScope = vi.hoisted(() => vi.fn(() => []));
const mockDiscoverPluginScope = vi.hoisted(() => vi.fn(() => []));
const mockDiscoverHooks = vi.hoisted(() => vi.fn(() => []));

vi.mock('./discover.js', () => ({
  discoverUserScope: mockDiscoverUserScope,
  discoverPluginScope: mockDiscoverPluginScope,
  discoverHooks: mockDiscoverHooks,
}));

// Mock vendoredToolAllowlist to return a predictable set.
vi.mock('../_agents/to-definition.js', () => ({
  vendoredToolAllowlist: vi.fn(() => new Set(['read_file', 'grep', 'glob'])),
}));

// Mock loadSkillPrompts so tests control which prompts are returned.
// No default implementation here — the beforeEach block sets the default via
// mockReturnValue so there is no duplication between the hoisted init and reset.
const mockLoadSkillPromptsImpl = vi.hoisted(() => vi.fn());
vi.mock('../_lib/prompt-loader.js', () => ({
  loadSkillPrompts: mockLoadSkillPromptsImpl,
}));

// ---------------------------------------------------------------------------
// NOW import the modules under test (post-mock).
// ---------------------------------------------------------------------------
import { handler } from './handler.js';
import {
  auditFitSkill,
  planAuditScope,
  aggregateVerdicts,
  shouldWriteBriefForMisfit,
  renderHookList,
  classifyInspectorResult,
  ALL_TYPES,
} from './index.js';
import type { Verdict } from './index.js';
import type { IAgentSession } from '../../agent/types.js';

// ---------------------------------------------------------------------------
// Test fixtures / helpers
// ---------------------------------------------------------------------------

function makeSession(sessionId = 'test-session-id'): IAgentSession {
  return {
    sessionId,
    getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
    abortSignal: new AbortController().signal,
  } as unknown as IAgentSession;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: 'test-api-key',
    defaultModel: 'claude-test',
    defaultSubagentModel: 'claude-test-small',
    callId: 'skill-call-1',
    ...overrides,
  };
}

// Build a minimal discovered artifact.
function makeSkillArtifact(
  path: string,
  source: 'user' | 'plugin' = 'user',
  plugin_key?: string,
) {
  return { path, type: 'skill' as const, source, ...(plugin_key ? { plugin_key } : {}) };
}

function makeCommandArtifact(
  path: string,
  source: 'user' | 'plugin' = 'user',
  plugin_key?: string,
) {
  return { path, type: 'command' as const, source, ...(plugin_key ? { plugin_key } : {}) };
}

// Build a Verdict matching a discovered artifact.
function makeVerdict(
  path: string,
  source: 'user' | 'plugin',
  plugin_key?: string,
  overrides: Partial<Verdict> = {},
): Verdict {
  return {
    path,
    type: 'skill',
    source,
    ...(plugin_key ? { plugin_key } : {}),
    verdict: 'correct',
    recommended_type: 'skill',
    rationale: 'Matches the skill pattern',
    confidence: 'high',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit-fit index.ts re-exports', () => {
  it('exports auditFitSkill with expected shape', () => {
    expect(auditFitSkill.name).toBe('audit-fit');
    expect(auditFitSkill.audience).toBe('internal');
    expect(auditFitSkill.flags).toContain('--write-briefs');
    expect(typeof auditFitSkill.handler).toBe('function');
  });

  it('exports ALL_TYPES with the four artifact types', () => {
    expect(ALL_TYPES).toEqual(['skill', 'command', 'agent', 'hook']);
  });

  it('exports planAuditScope (pure function)', () => {
    expect(planAuditScope('all')).toEqual({
      runUserDiscovery: true,
      runPluginDiscovery: true,
      runHookInspector: true,
    });
  });

  it('exports aggregateVerdicts (pure function)', () => {
    const { inventory, misfits } = aggregateVerdicts([]);
    expect(misfits).toHaveLength(0);
    expect(inventory.user.skill).toEqual({ correct: 0, misfit: 0, outlier: 0 });
  });

  it('exports shouldWriteBriefForMisfit (pure function)', () => {
    const m: Verdict = {
      path: '/a/SKILL.md',
      type: 'skill',
      source: 'user',
      verdict: 'misfit',
      recommended_type: 'command',
      rationale: 'r',
      confidence: 'high',
    };
    expect(shouldWriteBriefForMisfit(m)).toBe(true);
  });

  it('exports renderHookList (pure function)', () => {
    const out = renderHookList('/abs/settings.json', []);
    expect(out).toContain('Discovered hooks');
  });

  it('exports classifyInspectorResult (pure function)', () => {
    const out = classifyInspectorResult('skill', undefined);
    expect(out.kind).toBe('failure');
  });
});

// ---------------------------------------------------------------------------
// handler.ts integration tests
// ---------------------------------------------------------------------------

describe('audit-fit handler', () => {
  let tmpHome: string;
  let savedAFKHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create a fresh temp dir for AFK_HOME so file writes are hermetic.
    tmpHome = mkdtempSync(join(tmpdir(), 'audit-fit-handler-'));
    savedAFKHome = process.env['AFK_HOME']; // audit-env-access: allow — test-only env override
    process.env['AFK_HOME'] = tmpHome; // audit-env-access: allow — test-only env override

    // Default discovery: empty.
    mockDiscoverUserScope.mockReturnValue([]);
    mockDiscoverPluginScope.mockReturnValue([]);
    mockDiscoverHooks.mockReturnValue([]);

    // Default runWave: return succeeded result with empty output.
    mockRunWaveImpl.mockImplementation(async (tasks) =>
      tasks.map(() => ({ id: 'mock-run', status: 'succeeded' as const, output: [] })),
    );

    // Default loadSkillPrompts: return all four required prompts.
    mockLoadSkillPromptsImpl.mockReturnValue({
      '01-skill-inspector.md': 'skill prompt',
      '02-command-inspector.md': 'command prompt',
      '03-agent-inspector.md': 'agent prompt',
      '04-hook-inspector.md': 'hook prompt',
    });
  });

  afterEach(() => {
    if (savedAFKHome !== undefined) {
      process.env['AFK_HOME'] = savedAFKHome; // audit-env-access: allow — restore
    } else {
      delete process.env['AFK_HOME']; // audit-env-access: allow — restore
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  it('throws when parentSession is missing', async () => {
    await expect(
      handler({}, undefined, makeCtx()),
    ).rejects.toThrow('audit-fit requires a parent session with sessionId');
  });

  it('throws when parentSession has no sessionId', async () => {
    await expect(
      handler({}, { sessionId: '' } as IAgentSession, makeCtx()),
    ).rejects.toThrow('audit-fit requires a parent session with sessionId');
  });

  it('throws when a required inspector prompt is missing (stub prompt loader)', async () => {
    // Return a prompts map that is missing the hook prompt — handler must throw.
    mockLoadSkillPromptsImpl.mockReturnValueOnce({
      '01-skill-inspector.md': 'skill prompt',
      '02-command-inspector.md': 'command prompt',
      '03-agent-inspector.md': 'agent prompt',
      // '04-hook-inspector.md' intentionally absent
    });
    await expect(handler({}, makeSession(), makeCtx())).rejects.toThrow(
      'audit-fit skill missing inspector prompt for hook',
    );
  });

  // -------------------------------------------------------------------------
  // Scope: 'all' — zero artifacts, zero inspectors dispatched
  // -------------------------------------------------------------------------

  it('returns empty inventory when no artifacts are discovered', async () => {
    const result = await handler({}, makeSession(), makeCtx());
    expect(result.total_artifacts).toBe(0);
    expect(result.misfits).toHaveLength(0);
    expect(result.inventory.user.skill).toEqual({ correct: 0, misfit: 0, outlier: 0 });
    expect(result.inventory.plugin.skill).toEqual({ correct: 0, misfit: 0, outlier: 0 });
  });

  it('writes telemetry file even when no artifacts are found', async () => {
    await handler({}, makeSession(), makeCtx());
    const telemetryPath = join(tmpHome, 'agent-framework', 'audit-fit-telemetry.jsonl');
    expect(existsSync(telemetryPath)).toBe(true);
  });

  it('dispatches only the hook inspector when no file artifacts are present (scope=all)', async () => {
    // When scope=all and no file artifacts discovered, the hook inspector
    // still runs (it always runs for scope=all/user regardless of hook count).
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);
    await handler({}, makeSession(), makeCtx());
    // Hook inspector is always dispatched for scope=all; 1 forkSubagent call.
    expect(mockForkImpl).toHaveBeenCalledTimes(1);
    expect(mockRunWaveImpl).toHaveBeenCalledTimes(1);
  });

  it('dispatches no inspectors at all when scope=plugin and no plugin artifacts', async () => {
    // scope=plugin: no user discovery, no hook inspector, no plugin artifacts → nothing dispatched.
    await handler({ scope: 'plugin' }, makeSession(), makeCtx());
    expect(mockForkImpl).not.toHaveBeenCalled();
    expect(mockRunWaveImpl).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scope filter
  // -------------------------------------------------------------------------

  it('scope=plugin skips user discovery', async () => {
    await handler({ scope: 'plugin' }, makeSession(), makeCtx());
    expect(mockDiscoverUserScope).not.toHaveBeenCalled();
    expect(mockDiscoverPluginScope).toHaveBeenCalled();
    // Hook inspector is skipped for plugin scope.
    expect(mockDiscoverHooks).not.toHaveBeenCalled();
  });

  it('scope=user skips plugin discovery', async () => {
    await handler({ scope: 'user' }, makeSession(), makeCtx());
    expect(mockDiscoverPluginScope).not.toHaveBeenCalled();
    expect(mockDiscoverUserScope).toHaveBeenCalled();
  });

  it('scope=all runs both user and plugin discovery', async () => {
    await handler({ scope: 'all' }, makeSession(), makeCtx());
    expect(mockDiscoverUserScope).toHaveBeenCalled();
    expect(mockDiscoverPluginScope).toHaveBeenCalled();
  });

  it('scope=user runs hook inspector', async () => {
    mockDiscoverHooks.mockReturnValue([]);
    await handler({ scope: 'user' }, makeSession(), makeCtx());
    // discoverHooks is called once to build the hook list embedded in the prompt.
    expect(mockDiscoverHooks).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Inspector dispatch with user-scope skill artifacts
  // -------------------------------------------------------------------------

  it('dispatches skill inspector plus hook inspector (scope=all with one skill)', async () => {
    const skillPath = '/fake/afk/skills/my-skill/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(skillPath)]);

    // Two inspectors: skill + hook (hook always runs for scope=all).
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    // skill inspector + hook inspector = 2 forkSubagent calls.
    expect(mockForkImpl).toHaveBeenCalledTimes(2);
    const idPrefixes = mockForkImpl.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).idPrefix,
    );
    expect(idPrefixes).toContain('inspector-skill');
    expect(idPrefixes).toContain('inspector-hook');
    expect(result.total_artifacts).toBe(0); // empty verdict arrays
  });

  it('collects verdicts returned by the inspector wave', async () => {
    const skillPath = '/fake/skills/foo/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(skillPath)]);

    const verdict = makeVerdict(skillPath, 'user');
    // skill inspector result + hook inspector result (hook always runs for scope=all)
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [verdict] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    expect(result.total_artifacts).toBe(1);
    expect(result.inventory.user.skill).toEqual({ correct: 1, misfit: 0, outlier: 0 });
  });

  it('counts misfits separately from total artifacts', async () => {
    const skillPath = '/fake/skills/misfit/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(skillPath)]);

    const misfit = makeVerdict(skillPath, 'user', undefined, {
      verdict: 'misfit',
      recommended_type: 'command',
      confidence: 'high',
    });
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [misfit] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    expect(result.total_artifacts).toBe(1);
    expect(result.misfits).toHaveLength(1);
    expect(result.misfits[0]?.verdict).toBe('misfit');
  });

  // -------------------------------------------------------------------------
  // Plugin-scope artifacts (flat layout and marketplace-cache layout)
  // -------------------------------------------------------------------------

  it('handles flat plugin layout: includes plugin_key from discovery', async () => {
    const pluginPath = '/fake/plugins/data/skills/foo/SKILL.md';
    mockDiscoverPluginScope.mockReturnValue([
      makeSkillArtifact(pluginPath, 'plugin', 'data'),
    ]);

    const verdict = makeVerdict(pluginPath, 'plugin', 'data');
    // skill inspector + hook inspector (scope=all)
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [verdict] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    expect(result.total_artifacts).toBe(1);
    expect(result.inventory.plugin.skill).toEqual({ correct: 1, misfit: 0, outlier: 0 });
  });

  it('handles marketplace-cache layout: plugin_key as marketplace:plugin', async () => {
    const cachePath = '/fake/plugins/cache/mp/p/skills/bar/SKILL.md';
    mockDiscoverPluginScope.mockReturnValue([
      makeSkillArtifact(cachePath, 'plugin', 'mp:p'),
    ]);

    const verdict = makeVerdict(cachePath, 'plugin', 'mp:p');
    // skill inspector + hook inspector (scope=all)
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [verdict] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    expect(result.inventory.plugin.skill).toEqual({ correct: 1, misfit: 0, outlier: 0 });
  });

  // -------------------------------------------------------------------------
  // Verdict source-mismatch guard
  // -------------------------------------------------------------------------

  it('throws on verdict for a path not in the discovered list', async () => {
    const skillPath = '/fake/skills/known/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(skillPath)]);

    // Inspector returns a verdict for an unknown path.
    const rogue = makeVerdict('/fake/skills/unknown/SKILL.md', 'user');
    // skill result (bad) + hook result (empty): both processed, but skill fails first
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [rogue] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    await expect(handler({}, makeSession(), makeCtx())).rejects.toThrow(
      /verdict for unknown path/,
    );
  });

  it('throws on verdict with wrong source annotation', async () => {
    const skillPath = '/fake/skills/known/SKILL.md';
    // Discovered as user, but inspector says plugin.
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(skillPath, 'user')]);

    const wrongSource = makeVerdict(skillPath, 'plugin', 'bad-plugin');
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [wrongSource] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    await expect(handler({}, makeSession(), makeCtx())).rejects.toThrow(
      /verdict source mismatch/,
    );
  });

  // -------------------------------------------------------------------------
  // Hook inspector
  // -------------------------------------------------------------------------

  it('dispatches hook inspector when hooks are present (scope=all)', async () => {
    mockDiscoverHooks.mockReturnValue([
      { event: 'SubagentStop', index: 0, raw: { hooks: [] } },
    ]);

    // runWave returns two results: skills (none) and hook inspector.
    // Since no skill/command/agent artifacts, only hook inspector fires.
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    await handler({}, makeSession(), makeCtx());
    expect(mockForkImpl).toHaveBeenCalledTimes(1);
    const forkCall = mockForkImpl.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(forkCall.idPrefix).toBe('inspector-hook');
  });

  it('hook verdicts are accepted when source=user (no path match needed)', async () => {
    const settingsPath = join(tmpHome, 'settings.json');
    mockDiscoverHooks.mockReturnValue([
      { event: 'SubagentStop', index: 0, raw: { hooks: [] } },
    ]);

    const hookVerdict = makeVerdict(settingsPath, 'user', undefined, {
      type: 'hook',
      verdict: 'correct',
    });
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-hook', status: 'succeeded', output: [hookVerdict] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    expect(result.total_artifacts).toBe(1);
  });

  it('throws when hook verdict has source=plugin', async () => {
    mockDiscoverHooks.mockReturnValue([
      { event: 'SessionStart', index: 0, raw: {} },
    ]);

    const badHookVerdict: Verdict = {
      path: '/settings.json',
      type: 'hook',
      source: 'plugin',
      plugin_key: 'some-plugin',
      verdict: 'correct',
      recommended_type: 'hook',
      rationale: 'test',
      confidence: 'high',
    };
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-hook', status: 'succeeded', output: [badHookVerdict] },
    ]);

    await expect(handler({}, makeSession(), makeCtx())).rejects.toThrow(
      /hook verdict has source=plugin/,
    );
  });

  // -------------------------------------------------------------------------
  // Inspector failure propagation
  // -------------------------------------------------------------------------

  it('throws when inspector wave returns a failed result (scope=plugin, no hook inspector)', async () => {
    const skillPath = '/fake/plugins/data/skills/foo/SKILL.md';
    mockDiscoverPluginScope.mockReturnValue([makeSkillArtifact(skillPath, 'plugin', 'data')]);

    // scope=plugin: no hook inspector. Only skill inspector runs and fails.
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'failed', error: new Error('boom') },
    ]);

    await expect(
      handler({ scope: 'plugin' }, makeSession(), makeCtx()),
    ).rejects.toThrow(/inspector failure/);
  });

  it('throws when inspector wave returns a schema error', async () => {
    const cmdPath = '/fake/commands/foo.md';
    // Use scope=plugin so only the command inspector fires (no hook inspector).
    mockDiscoverPluginScope.mockReturnValue([makeCommandArtifact(cmdPath, 'plugin', 'data')]);

    // Simulate a schemaError result (buildResultFromMessage sets this).
    const { z } = await import('zod');
    const { VerdictSchema } = await import('./schemas.js');
    const zodResult = z.array(VerdictSchema).safeParse('not an array');
    const schemaError = !zodResult.success ? zodResult.error : undefined;

    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-command', status: 'failed', schemaError },
    ]);

    await expect(
      handler({ scope: 'plugin' }, makeSession(), makeCtx()),
    ).rejects.toThrow(/inspector failure/);
  });

  it('throws when inspector returns no result (undefined)', async () => {
    const skillPath = '/fake/plugins/data/skills/foo/SKILL.md';
    // Use scope=plugin so no hook inspector is dispatched.
    mockDiscoverPluginScope.mockReturnValue([makeSkillArtifact(skillPath, 'plugin', 'data')]);

    // runWave returns undefined for the one task.
    mockRunWaveImpl.mockResolvedValue([undefined]);

    await expect(
      handler({ scope: 'plugin' }, makeSession(), makeCtx()),
    ).rejects.toThrow(/inspector failure/);
  });

  // -------------------------------------------------------------------------
  // --write-briefs behaviour
  // -------------------------------------------------------------------------

  it('writes a brief file for high-confidence user misfit when writeBriefs=true (default)', async () => {
    const skillPath = '/fake/skills/misfit/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(skillPath)]);

    const misfit = makeVerdict(skillPath, 'user', undefined, {
      verdict: 'misfit',
      recommended_type: 'command',
      confidence: 'high',
      rationale: 'Should be a command, not a skill',
    });
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [misfit] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    expect(result.briefs_written).toBe(1);

    const briefsDir = join(tmpHome, 'agent-framework', 'briefs');
    expect(existsSync(briefsDir)).toBe(true);
    const briefs = readdirSync(briefsDir);
    expect(briefs.length).toBe(1);
    expect(briefs[0]).toMatch(/^audit-fit-/);
  });

  it('skips brief writing when writeBriefs=false', async () => {
    const skillPath = '/fake/skills/misfit/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(skillPath)]);

    const misfit = makeVerdict(skillPath, 'user', undefined, {
      verdict: 'misfit',
      recommended_type: 'command',
      confidence: 'high',
    });
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [misfit] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({ writeBriefs: false }, makeSession(), makeCtx());
    expect(result.briefs_written).toBe(0);

    const briefsDir = join(tmpHome, 'agent-framework', 'briefs');
    // Briefs dir should not exist (or be empty) when writing is disabled.
    if (existsSync(briefsDir)) {
      expect(readdirSync(briefsDir)).toHaveLength(0);
    }
  });

  it('does not write briefs for low-confidence user misfits', async () => {
    const skillPath = '/fake/skills/lowconf/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(skillPath)]);

    const lowConfMisfit = makeVerdict(skillPath, 'user', undefined, {
      verdict: 'misfit',
      confidence: 'low',
    });
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [lowConfMisfit] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    expect(result.briefs_written).toBe(0);
  });

  it('does not write briefs for plugin-scope misfits (scope=plugin, no hook)', async () => {
    const pluginPath = '/fake/plugins/p/skills/foo/SKILL.md';
    mockDiscoverPluginScope.mockReturnValue([makeSkillArtifact(pluginPath, 'plugin', 'p')]);

    const pluginMisfit = makeVerdict(pluginPath, 'plugin', 'p', {
      verdict: 'misfit',
      confidence: 'high',
    });
    // scope=plugin: no hook inspector
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [pluginMisfit] },
    ]);

    const result = await handler({ scope: 'plugin' }, makeSession(), makeCtx());
    expect(result.briefs_written).toBe(0);
  });

  it('writes multiple briefs for multiple high-confidence user misfits', async () => {
    const pathA = '/fake/skills/misfit-a/SKILL.md';
    const pathB = '/fake/skills/misfit-b/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([
      makeSkillArtifact(pathA),
      makeSkillArtifact(pathB),
    ]);

    const misfitA = makeVerdict(pathA, 'user', undefined, {
      verdict: 'misfit',
      confidence: 'high',
      recommended_type: 'command',
    });
    const misfitB = makeVerdict(pathB, 'user', undefined, {
      verdict: 'misfit',
      confidence: 'high',
      recommended_type: 'agent',
    });
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [misfitA, misfitB] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    expect(result.briefs_written).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Telemetry output
  // -------------------------------------------------------------------------

  it('appends to audit-fit-telemetry.jsonl with correct fields', async () => {
    const { readFileSync } = await import('fs');
    await handler({}, makeSession(), makeCtx());
    const telPath = join(tmpHome, 'agent-framework', 'audit-fit-telemetry.jsonl');
    const content = readFileSync(telPath, 'utf8').trim();
    const entry = JSON.parse(content) as Record<string, unknown>;
    expect(entry.surface).toBe('afk');
    expect(entry.scope).toBe('all');
    expect(entry.total_artifacts).toBe(0);
    expect(typeof entry.timestamp).toBe('string');
  });

  it('telemetry records correct by_source and by_type counts', async () => {
    const { readFileSync } = await import('fs');
    const skillPath = '/fake/skills/foo/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(skillPath)]);

    const verdict = makeVerdict(skillPath, 'user');
    mockRunWaveImpl.mockResolvedValue([
      { id: 'inspector-skill', status: 'succeeded', output: [verdict] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    await handler({}, makeSession(), makeCtx());
    const telPath = join(tmpHome, 'agent-framework', 'audit-fit-telemetry.jsonl');
    const entry = JSON.parse(readFileSync(telPath, 'utf8').trim()) as Record<string, unknown>;
    const bySource = entry.by_source as Record<string, number>;
    expect(bySource.user).toBe(1);
    expect(bySource.plugin).toBe(0);
    const byType = entry.by_type as Record<string, number>;
    expect(byType.skill).toBe(1);
    expect(byType.command).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Mixed user + plugin artifacts
  // -------------------------------------------------------------------------

  it('aggregates user and plugin artifacts into separate inventory slots', async () => {
    const userPath = '/fake/skills/user-skill/SKILL.md';
    const pluginPath = '/fake/plugins/data/skills/plug-skill/SKILL.md';
    mockDiscoverUserScope.mockReturnValue([makeSkillArtifact(userPath, 'user')]);
    mockDiscoverPluginScope.mockReturnValue([
      makeSkillArtifact(pluginPath, 'plugin', 'data'),
    ]);

    const userVerdict = makeVerdict(userPath, 'user');
    const pluginVerdict = makeVerdict(pluginPath, 'plugin', 'data');
    // scope=all: skill inspector (for both user+plugin) + hook inspector
    mockRunWaveImpl.mockResolvedValue([
      {
        id: 'inspector-skill',
        status: 'succeeded',
        output: [userVerdict, pluginVerdict],
      },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    expect(result.total_artifacts).toBe(2);
    expect(result.inventory.user.skill).toEqual({ correct: 1, misfit: 0, outlier: 0 });
    expect(result.inventory.plugin.skill).toEqual({ correct: 1, misfit: 0, outlier: 0 });
  });

  // -------------------------------------------------------------------------
  // ctx variants
  // -------------------------------------------------------------------------

  it('works with minimal ctx (no apiKey)', async () => {
    const result = await handler({}, makeSession(), makeCtx({ apiKey: undefined }));
    expect(result.total_artifacts).toBe(0);
  });

  it('works with ctx=undefined (no traceWriter/workspaceStore)', async () => {
    // handler should not crash when ctx is absent.
    const result = await handler({}, makeSession(), undefined);
    expect(result.total_artifacts).toBe(0);
  });

  it('accepts non-object input gracefully (treated as {})', async () => {
    // The handler coerces non-object input to {} before parsing.
    const result = await handler('not-an-object', makeSession(), makeCtx());
    expect(result.total_artifacts).toBe(0);
  });

  it('accepts null input gracefully', async () => {
    const result = await handler(null, makeSession(), makeCtx());
    expect(result.total_artifacts).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Multiple artifact types dispatched in one wave
  // -------------------------------------------------------------------------

  it('dispatches separate inspectors for skill, command, and hook types (scope=all)', async () => {
    const skillPath = '/fake/skills/foo/SKILL.md';
    const cmdPath = '/fake/commands/bar.md';
    mockDiscoverUserScope.mockReturnValue([
      makeSkillArtifact(skillPath),
      makeCommandArtifact(cmdPath),
    ]);

    const skillVerdict = makeVerdict(skillPath, 'user');
    const cmdVerdict: Verdict = {
      path: cmdPath,
      type: 'command',
      source: 'user',
      verdict: 'correct',
      recommended_type: 'command',
      rationale: 'ok',
      confidence: 'high',
    };
    // skill inspector + command inspector + hook inspector = 3 forks in one wave.
    mockRunWaveImpl.mockResolvedValueOnce([
      { id: 'inspector-skill', status: 'succeeded', output: [skillVerdict] },
      { id: 'inspector-command', status: 'succeeded', output: [cmdVerdict] },
      { id: 'inspector-hook', status: 'succeeded', output: [] },
    ]);

    const result = await handler({}, makeSession(), makeCtx());
    // Three inspectors: skill, command, hook (all dispatched in one wave call).
    expect(mockForkImpl).toHaveBeenCalledTimes(3);
    expect(result.total_artifacts).toBe(2);
    expect(result.inventory.user.skill.correct).toBe(1);
    expect(result.inventory.user.command.correct).toBe(1);
  });
});
