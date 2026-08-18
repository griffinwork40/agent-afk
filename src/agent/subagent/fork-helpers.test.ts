/**
 * Unit tests for the fork helper functions extracted in #919:
 *   - validatePhaseRole      (fork-validation.ts)
 *   - assembleChildConfig    (fork-child-config.ts)
 *   - emitForkStarted        (fork-lifecycle.ts)
 *   - appendForkTelemetry    (fork-lifecycle.ts)
 *
 * Each helper is exercised in isolation via vi.mock so no real FS / network
 * / trace-writer I/O occurs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks (must precede the imports under test) ───────────────────────────────

vi.mock('../trace/emit.js', () => ({
  emitSubagentLifecycle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn().mockResolvedValue(undefined),
}));

// assembleChildConfig pulls in several deep imports; stub the ones that would
// touch the filesystem or the Anthropic SDK at import time.
vi.mock('../providers/index.js', () => ({
  providerForModel: vi.fn().mockReturnValue('anthropic'),
}));

vi.mock('../tools/nesting.js', () => ({
  buildPhaseRestrictedProvider: vi.fn().mockReturnValue({ __stub: 'read-only-provider' }),
}));

vi.mock('../tools/child-credential.js', () => ({
  applyManagerApiKeyFallback: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./budget-preamble.js', () => ({
  // Pass the config through unchanged so assembleChildConfig tests can inspect
  // the assembled fields without the preamble wrapping obscuring them.
  injectToolBudgetPreamble: vi.fn((cfg: object) => cfg),
}));

vi.mock('../providers/shared/soft-deadline.js', () => ({
  resolveSoftDeadlineMs: vi.fn().mockReturnValue(0),
}));

// ── subject imports ───────────────────────────────────────────────────────────

import { validatePhaseRole } from './fork-validation.js';
import { assembleChildConfig, type AssembleChildConfigArgs } from './fork-child-config.js';
import { emitForkStarted, appendForkTelemetry } from './fork-lifecycle.js';
import { emitSubagentLifecycle } from '../trace/emit.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { MODEL_CAP_BYTES } from '../tools/handlers/_output-cap.js';
import { SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS } from './constants.js';
import { DENY_ELICITATION } from './constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// validatePhaseRole
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePhaseRole', () => {
  it('does not throw for the happy path: no phaseRole, no provider', () => {
    expect(() => validatePhaseRole({ phaseRole: undefined, config: {} })).not.toThrow();
  });

  it('does not throw when phaseRole is read-write (default): provider is allowed', () => {
    expect(() =>
      validatePhaseRole({
        phaseRole: 'read-write',
        config: { provider: { __stub: 'some-provider' } as never },
      }),
    ).not.toThrow();
  });

  it('does not throw when phaseRole is read-only and provider is absent', () => {
    expect(() =>
      validatePhaseRole({ phaseRole: 'read-only', config: {} }),
    ).not.toThrow();
  });

  it('throws when read-only phaseRole is combined with an explicit provider', () => {
    expect(() =>
      validatePhaseRole({
        phaseRole: 'read-only',
        config: { provider: { __stub: 'custom' } as never },
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('error message names the conflicting phaseRole value', () => {
    expect(() =>
      validatePhaseRole({
        phaseRole: 'read-only',
        config: { provider: {} as never },
      }),
    ).toThrow(/"read-only"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// emitForkStarted
// ─────────────────────────────────────────────────────────────────────────────

describe('emitForkStarted', () => {
  beforeEach(() => {
    vi.mocked(emitSubagentLifecycle).mockClear();
  });

  it('calls emitSubagentLifecycle with transition="started" and the child id', () => {
    emitForkStarted({
      effectiveTraceWriter: undefined,
      id: 'child-abc',
      parentSessionId: 'parent-123',
      rootId: 'root-999',
      effectiveChildModel: 'claude-sonnet-5',
      childConfig: {},
      promptHead: undefined,
      effectiveAgentType: undefined,
      effectiveResolvedAgentType: undefined,
    });

    expect(emitSubagentLifecycle).toHaveBeenCalledOnce();
    const payload = vi.mocked(emitSubagentLifecycle).mock.calls[0]?.[1];
    expect(payload).toMatchObject({ transition: 'started', subagentId: 'child-abc' });
  });

  it('uses parentSessionId as parentId when present', () => {
    emitForkStarted({
      effectiveTraceWriter: undefined,
      id: 'child-abc',
      parentSessionId: 'parent-123',
      rootId: 'root-999',
      effectiveChildModel: 'claude-sonnet-5',
      childConfig: {},
      promptHead: undefined,
      effectiveAgentType: undefined,
      effectiveResolvedAgentType: undefined,
    });

    const payload = vi.mocked(emitSubagentLifecycle).mock.calls[0]?.[1];
    expect(payload?.parentId).toBe('parent-123');
  });

  it('falls back to rootId as parentId when parentSessionId is undefined', () => {
    emitForkStarted({
      effectiveTraceWriter: undefined,
      id: 'child-abc',
      parentSessionId: undefined,
      rootId: 'root-999',
      effectiveChildModel: 'claude-sonnet-5',
      childConfig: {},
      promptHead: undefined,
      effectiveAgentType: undefined,
      effectiveResolvedAgentType: undefined,
    });

    const payload = vi.mocked(emitSubagentLifecycle).mock.calls[0]?.[1];
    expect(payload?.parentId).toBe('root-999');
  });

  it('stringifies an object model via JSON.stringify', () => {
    const modelObj = { id: 'some-model', provider: 'openai' };
    const result = emitForkStarted({
      effectiveTraceWriter: undefined,
      id: 'child-abc',
      parentSessionId: 'p',
      rootId: 'r',
      effectiveChildModel: modelObj as never,
      childConfig: {},
      promptHead: undefined,
      effectiveAgentType: undefined,
      effectiveResolvedAgentType: undefined,
    });

    expect(result).toBe(JSON.stringify(modelObj));
  });

  it('returns the string model unchanged when it is already a string', () => {
    const result = emitForkStarted({
      effectiveTraceWriter: undefined,
      id: 'child-abc',
      parentSessionId: 'p',
      rootId: 'r',
      effectiveChildModel: 'haiku',
      childConfig: {},
      promptHead: undefined,
      effectiveAgentType: undefined,
      effectiveResolvedAgentType: undefined,
    });

    expect(result).toBe('haiku');
  });

  it('clamps promptHead to 80 chars and includes it in the payload', () => {
    const long = 'a'.repeat(100);
    emitForkStarted({
      effectiveTraceWriter: undefined,
      id: 'c',
      parentSessionId: 'p',
      rootId: 'r',
      effectiveChildModel: 'sonnet',
      childConfig: {},
      promptHead: long,
      effectiveAgentType: undefined,
      effectiveResolvedAgentType: undefined,
    });

    const payload = vi.mocked(emitSubagentLifecycle).mock.calls[0]?.[1];
    expect(payload?.promptHead).toHaveLength(80);
  });

  it('omits promptHead from payload when blank', () => {
    emitForkStarted({
      effectiveTraceWriter: undefined,
      id: 'c',
      parentSessionId: 'p',
      rootId: 'r',
      effectiveChildModel: 'sonnet',
      childConfig: {},
      promptHead: '   ',
      effectiveAgentType: undefined,
      effectiveResolvedAgentType: undefined,
    });

    const payload = vi.mocked(emitSubagentLifecycle).mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty('promptHead');
  });

  it('includes agentType and resolvedAgentType when provided', () => {
    emitForkStarted({
      effectiveTraceWriter: undefined,
      id: 'c',
      parentSessionId: 'p',
      rootId: 'r',
      effectiveChildModel: 'sonnet',
      childConfig: {},
      promptHead: undefined,
      effectiveAgentType: 'researcher',
      effectiveResolvedAgentType: 'research-agent',
    });

    const payload = vi.mocked(emitSubagentLifecycle).mock.calls[0]?.[1];
    expect(payload?.agentType).toBe('researcher');
    expect(payload?.resolvedAgentType).toBe('research-agent');
  });

  it('includes allowedTools from childConfig.tools when set', () => {
    emitForkStarted({
      effectiveTraceWriter: undefined,
      id: 'c',
      parentSessionId: 'p',
      rootId: 'r',
      effectiveChildModel: 'sonnet',
      childConfig: { tools: { allowedTools: ['bash', 'read_file'] } },
      promptHead: undefined,
      effectiveAgentType: undefined,
      effectiveResolvedAgentType: undefined,
    });

    const payload = vi.mocked(emitSubagentLifecycle).mock.calls[0]?.[1];
    expect(payload?.allowedTools).toEqual(['bash', 'read_file']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appendForkTelemetry
// ─────────────────────────────────────────────────────────────────────────────

describe('appendForkTelemetry', () => {
  beforeEach(() => {
    vi.mocked(appendRoutingDecision).mockClear();
  });

  it('calls appendRoutingDecision with event="subagent.dispatched"', async () => {
    await appendForkTelemetry({
      modelString: 'claude-sonnet-5',
      id: 'child-xyz',
      idPrefix: 'research',
      parentSessionId: 'parent-123',
      effectiveResolvedAgentType: 'research-agent',
    });

    expect(appendRoutingDecision).toHaveBeenCalledOnce();
    const row = vi.mocked(appendRoutingDecision).mock.calls[0]?.[0];
    expect(row?.event).toBe('subagent.dispatched');
  });

  it('threads all fields into the routing decision row', async () => {
    await appendForkTelemetry({
      modelString: 'haiku',
      id: 'c-1',
      idPrefix: 'search',
      parentSessionId: 'p-42',
      effectiveResolvedAgentType: 'search-agent',
    });

    const row = vi.mocked(appendRoutingDecision).mock.calls[0]?.[0];
    expect(row).toMatchObject({
      subagent_id: 'c-1',
      id_prefix: 'search',
      model: 'haiku',
      parent_session_id: 'p-42',
      resolved_agent_type: 'search-agent',
    });
  });

  it('passes undefined idPrefix and resolvedAgentType through (dropped at write time)', async () => {
    await appendForkTelemetry({
      modelString: 'sonnet',
      id: 'c-2',
      idPrefix: undefined,
      parentSessionId: undefined,
      effectiveResolvedAgentType: undefined,
    });

    const row = vi.mocked(appendRoutingDecision).mock.calls[0]?.[0];
    expect(row?.id_prefix).toBeUndefined();
    expect(row?.resolved_agent_type).toBeUndefined();
    expect(row?.parent_session_id).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assembleChildConfig — spot-checks on key fields
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal valid args for assembleChildConfig. Override per test. */
function makeArgs(
  overrides: Partial<AssembleChildConfigArgs<unknown>> = {},
): AssembleChildConfigArgs<unknown> {
  return {
    options: {
      parent: { sessionId: 'parent-sess' },
      config: {},
      agentType: 'test-agent',
    },
    id: 'child-id',
    resume: undefined,
    registry: undefined,
    effectiveChildModel: 'claude-sonnet-5',
    effectiveTimeoutMs: 30_000,
    inheritedReadRoots: undefined,
    composedWriteRoots: undefined,
    childController: new AbortController(),
    parentCwd: undefined,
    parentApiKey: undefined,
    parentBaseUrl: undefined,
    parentProvider: undefined,
    parentTraceWriter: undefined,
    parentSurface: undefined,
    parentCanUseTool: undefined,
    ...overrides,
  };
}

describe('assembleChildConfig', () => {
  it('stamps isSubagentFork: true unconditionally', () => {
    const cfg = assembleChildConfig(makeArgs());
    expect(cfg.isSubagentFork).toBe(true);
  });

  it('stamps the manager-assigned id as subagentId', () => {
    const cfg = assembleChildConfig(makeArgs({ id: 'my-fork-id' }));
    expect(cfg.subagentId).toBe('my-fork-id');
  });

  it('sets subagentToolOutputCapBytes to MODEL_CAP_BYTES', () => {
    const cfg = assembleChildConfig(makeArgs());
    expect(cfg.subagentToolOutputCapBytes).toBe(MODEL_CAP_BYTES);
  });

  it('defaults isNonInteractive to true when options.config omits it', () => {
    const cfg = assembleChildConfig(makeArgs());
    expect(cfg.isNonInteractive).toBe(true);
  });

  it('honours caller override: isNonInteractive: false', () => {
    const cfg = assembleChildConfig(
      makeArgs({ options: { parent: { sessionId: 'p' }, config: { isNonInteractive: false }, agentType: 't' } }),
    );
    expect(cfg.isNonInteractive).toBe(false);
  });

  it('defaults maxToolUseIterations to SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS', () => {
    const cfg = assembleChildConfig(makeArgs());
    expect(cfg.maxToolUseIterations).toBe(SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS);
  });

  it('honours caller override for maxToolUseIterations', () => {
    const cfg = assembleChildConfig(
      makeArgs({ options: { parent: { sessionId: 'p' }, config: { maxToolUseIterations: 10 }, agentType: 't' } }),
    );
    expect(cfg.maxToolUseIterations).toBe(10);
  });

  it('defaults autoResumeOnUsageLimit to false', () => {
    const cfg = assembleChildConfig(makeArgs());
    expect(cfg.autoResumeOnUsageLimit).toBe(false);
  });

  it('installs DENY_ELICITATION when denyElicitations is not false', () => {
    const cfg = assembleChildConfig(makeArgs());
    expect(cfg.onElicitation).toBe(DENY_ELICITATION);
  });

  it('does NOT install DENY_ELICITATION when denyElicitations is false', () => {
    const args = makeArgs();
    args.options = { ...args.options, denyElicitations: false };
    const cfg = assembleChildConfig(args);
    expect(cfg.onElicitation).toBeUndefined();
  });

  it('wires the childController signal as abortSignal', () => {
    const ctrl = new AbortController();
    const cfg = assembleChildConfig(makeArgs({ childController: ctrl }));
    expect(cfg.abortSignal).toBe(ctrl.signal);
  });

  it('inherits parentSessionId onto childConfig when options.config omits it', () => {
    const cfg = assembleChildConfig(
      makeArgs({ options: { parent: { sessionId: 'parent-sess' }, config: {}, agentType: 't' } }),
    );
    expect(cfg.parentSessionId).toBe('parent-sess');
  });

  it('does not overwrite caller-supplied parentSessionId', () => {
    const cfg = assembleChildConfig(
      makeArgs({
        options: {
          parent: { sessionId: 'parent-sess' },
          config: { parentSessionId: 'caller-override' },
          agentType: 't',
        },
      }),
    );
    expect(cfg.parentSessionId).toBe('caller-override');
  });

  it('inherits parentCwd when options.config.cwd is absent', () => {
    const cfg = assembleChildConfig(makeArgs({ parentCwd: '/repo/worktree' }));
    expect(cfg.cwd).toBe('/repo/worktree');
  });

  it('honours caller cwd over parentCwd', () => {
    const cfg = assembleChildConfig(
      makeArgs({
        parentCwd: '/repo/worktree',
        options: { parent: { sessionId: 'p' }, config: { cwd: '/custom' }, agentType: 't' },
      }),
    );
    expect(cfg.cwd).toBe('/custom');
  });

  it('sets inheritedReadRoots when provided', () => {
    const roots = ['/a', '/b'];
    const cfg = assembleChildConfig(makeArgs({ inheritedReadRoots: roots }));
    expect(cfg.readRoots).toEqual(roots);
  });

  it('sets composedWriteRoots when provided', () => {
    const roots = ['/w'];
    const cfg = assembleChildConfig(makeArgs({ composedWriteRoots: roots }));
    expect(cfg.writeRoots).toEqual(roots);
  });

  it('inherits parentTraceWriter when options.config.traceWriter is absent', () => {
    const sink = { write: vi.fn(), seal: vi.fn() } as never;
    const cfg = assembleChildConfig(makeArgs({ parentTraceWriter: sink }));
    expect(cfg.traceWriter).toBe(sink);
  });

  it('inherits parentSurface when options.config.surface is absent', () => {
    const cfg = assembleChildConfig(makeArgs({ parentSurface: 'cli' }));
    expect(cfg.surface).toBe('cli');
  });
});
