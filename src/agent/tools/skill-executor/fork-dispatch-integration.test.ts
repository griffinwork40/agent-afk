/**
 * Integration test: fork identity design — real producer path coverage.
 *
 * Gap addressed: existing tests (fork-dispatch-identity.test.ts,
 * tool-lane-skill-identity.test.ts) exercise `withSkillIdentity` in
 * isolation and `ToolLane.setSkillIdentity` with no fork path.
 * Neither test drives the REAL producer:
 *   registry/plugin metadata → buildSkillForkManager
 *     → withSkillIdentity(getCurrentSink(), callId, identity)
 *       → renderer receives enriched SubagentProgressMeta
 *
 * How this works:
 *   `buildSkillForkManager` calls `getCurrentSink()` INSIDE the fork,
 *   wraps the ambient sink via `withSkillIdentity(ambientSink, callId, identity)`,
 *   and stores the result as `this.progressSink` on the SubagentManager.
 *   Our spy captures `this.progressSink` from inside `forkSubagent`.
 *   Then SubagentManager.forkSubagent itself calls
 *   `const sink = this.progressSink ?? getCurrentSink()` and invokes it on each
 *   subagent event — meaning our captured progressSink IS the wrapped sink.
 *   In tests we invoke it directly (simulating forkSubagent's event dispatch)
 *   with (event, {subagentId, parentId}) and observe what the OUTER sink receives.
 *
 * The ambient sink provided to `runWithSink(capturingSink, ...)` is what
 * `withSkillIdentity` closes over — so the capturing happens via that outer
 * sink, and we assert on what it received.
 *
 * What this file adds:
 *   1. Registry-fork path: `executeForkedRegistrySkill` reads `skill.name` +
 *      `skill.description` from real registerSkill() metadata and threads them
 *      into the `SkillIdentity` passed to `withSkillIdentity`.
 *   2. Plugin-fork path: `executePluginSkill` receives the caller-resolved
 *      `description` and skill `name`; threads them through the same bridge.
 *   3. Concurrent same-name distinct IDs: two calls with different `call.id`s
 *      route enriched identities independently — call-A meta never appears
 *      on call-B child events.
 *   4. Nested child failure: a grandchild event whose `parentId !== callId`
 *      is NOT enriched — `skillIdentity` stays undefined.
 *   5. Load-mode registry skill: no fork occurs, no identity is emitted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SubagentProgressSink, OutputEvent, SubagentProgressMeta } from '../../types/session-types.js';

// ── Mocks must precede real imports ─────────────────────────────────────────

vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'test-credential' as string | undefined),
  loadAnthropicCredential: vi.fn(() => 'test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

import { SkillExecutor } from '../skill-executor.js';
import { registerSkill, _resetRegistry } from '../../../skills/skill-registry.js';
import { executePluginSkill } from './fork-dispatch.js';
import { SubagentManager } from '../../subagent.js';
import * as promptLoader from '../../../skills/_lib/prompt-loader.js';
import { runWithSink } from '../../_lib/skill-sink-channel.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const abortSignal = new AbortController().signal;

/**
 * Spy SubagentManager.prototype.forkSubagent to capture `this.progressSink`
 * (the `withSkillIdentity`-wrapped ambient sink that fork-dispatch wired),
 * then return a minimal succeeding handle.
 *
 * KEY INSIGHT: `this.progressSink` is captured at forkSubagent call time
 * (which is INSIDE the `runWithSink` wrapper in the test), so it IS the
 * `withSkillIdentity(ambientSink, callId, identity)` result where `ambientSink`
 * is whatever was passed to `runWithSink`.
 *
 * After execution, callers retrieve the captured sinks and drive them:
 *   sink(event, {subagentId, parentId: callId})  → enriched (parentId matches)
 *   sink(event, {subagentId, parentId: 'other'}) → passthrough (no identity)
 * In both cases the outer ambient sink (provided to runWithSink) receives the call.
 */
function armForkSpy(): { getCapturedSinks: () => Array<SubagentProgressSink | undefined> } {
  const sinks: Array<SubagentProgressSink | undefined> = [];
  vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
    async function (this: SubagentManager) {
      const ps = (this as unknown as { progressSink?: SubagentProgressSink }).progressSink;
      sinks.push(ps);
      return {
        id: `child-${sinks.length}`,
        session: undefined,
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'done' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
        getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
      } as unknown as Awaited<ReturnType<SubagentManager['forkSubagent']>>;
    },
  );
  vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
  return { getCapturedSinks: () => sinks };
}

function makeExecutor(): SkillExecutor {
  return new SkillExecutor({
    parentSession: {
      sessionId: 'parent-sess',
      getInputStreamRef: () => ({ pushUserMessage: () => {} }),
      abortSignal,
    },
    defaultModel: 'sonnet',
  });
}

function makeCall(id: string, input: unknown) {
  return { id, name: 'skill', input, signal: abortSignal };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('fork-dispatch identity integration — real producer path', () => {
  beforeEach(() => {
    _resetRegistry();
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
      'system.md': 'You are a test skill.',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Registry-fork path: identity fields from real registerSkill metadata

  it('registry fork wires skillIdentity.name+purpose+arguments from registerSkill metadata', async () => {
    registerSkill({
      name: 'review',
      description: 'Check changes carefully',
      context: 'fork',
      handler: vi.fn(),
    });
    const { getCapturedSinks } = armForkSpy();
    const executor = makeExecutor();

    // The ambient sink captures every event that passes through withSkillIdentity.
    const received: SubagentProgressMeta[] = [];
    const ambientSink: SubagentProgressSink = (_ev, meta) => received.push(meta);

    // Execute inside runWithSink so getCurrentSink() returns ambientSink.
    // buildSkillForkManager calls getCurrentSink() synchronously at fork time.
    await runWithSink(ambientSink, () =>
      executor.execute(makeCall('call-r1', { name: 'review', arguments: 'src/foo.ts' })),
    );

    const sinks = getCapturedSinks();
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toBeDefined();

    // Drive a direct-child event: parentId === callId → should be enriched.
    // The captured `progressSink` = withSkillIdentity(ambientSink, 'call-r1', identity).
    // Calling it routes to `ambientSink` (above), populating `received`.
    sinks[0]!({ type: 'done' } as OutputEvent, { subagentId: 'child-1', parentId: 'call-r1' });

    expect(received).toHaveLength(1);
    expect(received[0]!.skillIdentity).toMatchObject({
      name: 'review',
      purpose: 'Check changes carefully',
      arguments: 'src/foo.ts',
    });
  });

  it('registry fork emits undefined purpose when skill has no description', async () => {
    registerSkill({
      name: 'nodesc',
      context: 'fork',
      handler: vi.fn(),
    });
    const { getCapturedSinks } = armForkSpy();
    const executor = makeExecutor();

    const received: SubagentProgressMeta[] = [];
    await runWithSink((_ev, meta) => received.push(meta), () =>
      executor.execute(makeCall('call-nd', { name: 'nodesc' })),
    );

    getCapturedSinks()[0]!({ type: 'done' } as OutputEvent, { subagentId: 'child-nd', parentId: 'call-nd' });

    expect(received).toHaveLength(1);
    expect(received[0]!.skillIdentity?.name).toBe('nodesc');
    expect(received[0]!.skillIdentity?.purpose).toBeUndefined();
  });

  it('registry fork omits arguments from identity when no args passed', async () => {
    registerSkill({
      name: 'ground-state',
      description: 'Survey workspace',
      context: 'fork',
      handler: vi.fn(),
    });
    const { getCapturedSinks } = armForkSpy();
    const executor = makeExecutor();

    const received: SubagentProgressMeta[] = [];
    await runWithSink((_ev, meta) => received.push(meta), () =>
      executor.execute(makeCall('call-gs', { name: 'ground-state' })),
    );

    getCapturedSinks()[0]!({ type: 'done' } as OutputEvent, { subagentId: 'child-gs', parentId: 'call-gs' });

    expect(received[0]!.skillIdentity?.name).toBe('ground-state');
    expect(received[0]!.skillIdentity?.arguments).toBeUndefined();
  });

  // ── 2. Plugin-fork path ───────────────────────────────────────────────────

  it('plugin fork wires skillIdentity from caller-resolved description and args', async () => {
    const { getCapturedSinks } = armForkSpy();

    // Build minimal internals matching SkillExecutorInternals shape
    const internals = {
      ctx: {
        parentSession: {
          sessionId: 'parent-sess',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
      },
      currentCwd: undefined,
    };

    const received: SubagentProgressMeta[] = [];
    await runWithSink((_ev, meta) => received.push(meta), () =>
      executePluginSkill(
        internals as any,
        /* skillName */ 'diagnose',
        /* body */ '# SKILL.md body\nDo diagnosis work.',
        /* pluginPath */ '/fake/plugin/path',
        /* args */ '--target src/',
        /* call */ makeCall('call-p1', {}) as any,
        /* readOnly */ false,
        /* allowedTools */ undefined,
        /* model */ undefined,
        /* description */ 'Root cause analysis',
      ),
    );

    const sinks = getCapturedSinks();
    expect(sinks).toHaveLength(1);

    sinks[0]!({ type: 'done' } as OutputEvent, { subagentId: 'child-p1', parentId: 'call-p1' });

    expect(received).toHaveLength(1);
    expect(received[0]!.skillIdentity).toMatchObject({
      name: 'diagnose',
      purpose: 'Root cause analysis',
      arguments: '--target src/',
    });
  });

  it('plugin fork without description sets undefined purpose in identity', async () => {
    const { getCapturedSinks } = armForkSpy();
    const internals = {
      ctx: {
        parentSession: {
          sessionId: 'parent-sess',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
      },
      currentCwd: undefined,
    };

    const received: SubagentProgressMeta[] = [];
    await runWithSink((_ev, meta) => received.push(meta), () =>
      executePluginSkill(
        internals as any,
        'nopurpose',
        '# body',
        '/fake/path',
        undefined,
        makeCall('call-np', {}) as any,
        false,
        undefined,
        undefined,
        undefined, // no description
      ),
    );

    getCapturedSinks()[0]!({ type: 'done' } as OutputEvent, { subagentId: 'child-np', parentId: 'call-np' });

    expect(received[0]!.skillIdentity?.name).toBe('nopurpose');
    expect(received[0]!.skillIdentity?.purpose).toBeUndefined();
    expect(received[0]!.skillIdentity?.arguments).toBeUndefined();
  });

  // ── 3. Concurrent same-name distinct call IDs ─────────────────────────────

  it('concurrent same-name calls route identity by call ID, not by name', async () => {
    registerSkill({
      name: 'review',
      description: 'Parallel review',
      context: 'fork',
      handler: vi.fn(),
    });
    const { getCapturedSinks } = armForkSpy();
    const executor = makeExecutor();

    // The ambient sink is the source of truth: withSkillIdentity wraps it
    // at construction time (inside the runWithSink below). After construction,
    // calling captured sinks always routes to THIS ambient sink, regardless
    // of any outer runWithSink context at call time.
    const allReceived: SubagentProgressMeta[] = [];
    const ambientSink: SubagentProgressSink = (_ev, meta) => allReceived.push(meta);

    await runWithSink(ambientSink, () =>
      Promise.all([
        executor.execute(makeCall('call-A', { name: 'review', arguments: 'one' })),
        executor.execute(makeCall('call-B', { name: 'review', arguments: 'two' })),
      ]),
    );

    const sinks = getCapturedSinks();
    expect(sinks).toHaveLength(2);

    // Drive each sink with events keyed to BOTH call IDs.
    // Each withSkillIdentity closure only enriches events whose parentId === ITS callId.
    // Drive outside any runWithSink — the wrapped sink already has ambientSink captured.
    sinks[0]!({ type: 'done' } as OutputEvent, { subagentId: 'child-A', parentId: 'call-A' });
    sinks[0]!({ type: 'done' } as OutputEvent, { subagentId: 'child-A2', parentId: 'call-B' });
    sinks[1]!({ type: 'done' } as OutputEvent, { subagentId: 'child-B', parentId: 'call-B' });
    sinks[1]!({ type: 'done' } as OutputEvent, { subagentId: 'child-B2', parentId: 'call-A' });

    // Exactly 2 of the 4 events should be enriched (one per sink × matching parentId).
    const enriched = allReceived.filter((m) => m.skillIdentity !== undefined);
    expect(enriched).toHaveLength(2);

    // The two enriched events carry the distinct argument values.
    const enrichedArgs = enriched.map((m) => m.skillIdentity?.arguments).sort();
    expect(enrichedArgs).toEqual(['one', 'two'].sort());

    // Zero cross-contamination: events where parentId doesn't match the sink's callId.
    const notEnriched = allReceived.filter((m) => m.skillIdentity === undefined);
    expect(notEnriched).toHaveLength(2);
  });

  // ── 4. Nested child / grandchild: wrong parentId → no identity ───────────

  it('grandchild event (parentId !== callId) receives no skillIdentity', async () => {
    registerSkill({
      name: 'mint',
      description: 'Build feature',
      context: 'fork',
      handler: vi.fn(),
    });
    const { getCapturedSinks } = armForkSpy();
    const executor = makeExecutor();

    const received: SubagentProgressMeta[] = [];
    await runWithSink((_ev, meta) => received.push(meta), () =>
      executor.execute(makeCall('call-M', { name: 'mint', arguments: 'widget' })),
    );

    const sinks = getCapturedSinks();
    expect(sinks).toHaveLength(1);

    // Drive a grandchild event: parentId is a nested-call, NOT the original callId.
    sinks[0]!({ type: 'done' } as OutputEvent, { subagentId: 'grandchild-1', parentId: 'nested-call-xyz' });

    expect(received).toHaveLength(1);
    // withSkillIdentity must NOT enrich events whose parentId !== callId
    expect(received[0]!.skillIdentity).toBeUndefined();
    expect(received[0]!.subagentId).toBe('grandchild-1');
  });

  it('direct child gets identity; nested grandchild in same sink does not', async () => {
    registerSkill({
      name: 'spec',
      description: 'Write spec',
      context: 'fork',
      handler: vi.fn(),
    });
    const { getCapturedSinks } = armForkSpy();
    const executor = makeExecutor();

    const received: SubagentProgressMeta[] = [];
    await runWithSink((_ev, meta) => received.push(meta), () =>
      executor.execute(makeCall('call-S', { name: 'spec', arguments: 'auth-flow' })),
    );

    const sink = getCapturedSinks()[0]!;
    // Direct child (parentId === callId) → enriched
    sink({ type: 'done' } as OutputEvent, { subagentId: 'direct', parentId: 'call-S' });
    // Grandchild (parentId !== callId) → passthrough
    sink({ type: 'done' } as OutputEvent, { subagentId: 'nested', parentId: 'some-nested-id' });

    expect(received).toHaveLength(2);
    expect(received[0]!.skillIdentity?.name).toBe('spec');
    expect(received[0]!.skillIdentity?.arguments).toBe('auth-flow');
    expect(received[1]!.skillIdentity).toBeUndefined();
  });

  // ── 5. Load-mode registry skill: no fork, no sink enrichment ─────────────

  it('load-mode registry skill does not invoke forkSubagent (no identity emitted)', async () => {
    registerSkill({
      name: 'load-skill',
      description: 'Should not fork',
      context: 'load',
      loadBody: 'Run this inline.',
      handler: vi.fn(),
    });
    const forkSpy = vi.spyOn(SubagentManager.prototype, 'forkSubagent');
    vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

    const executor = makeExecutor();
    const enriched: SubagentProgressMeta[] = [];
    await runWithSink(
      (_ev, meta) => { if (meta.skillIdentity) enriched.push(meta); },
      () => executor.execute(makeCall('call-L', { name: 'load-skill' })),
    );

    expect(forkSpy).not.toHaveBeenCalled();
    expect(enriched).toHaveLength(0);
  });

  // ── 6. No ambient sink: withSkillIdentity returns undefined, no crash ──────

  it('registry fork with no ambient sink does not crash (graceful no-op)', async () => {
    registerSkill({
      name: 'spec',
      description: 'Spec feature',
      context: 'fork',
      handler: vi.fn(),
    });
    armForkSpy();
    const executor = makeExecutor();

    // No runWithSink wrapper → getCurrentSink() returns undefined
    // → withSkillIdentity returns undefined → progressSink on manager is undefined
    // → no sink is called, no crash
    await expect(
      executor.execute(makeCall('call-NS', { name: 'spec', arguments: 'auth' })),
    ).resolves.not.toThrow();
  });
});
