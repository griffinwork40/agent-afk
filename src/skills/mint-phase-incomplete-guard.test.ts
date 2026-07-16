/**
 * Guard tests: mint phase dispatchers must HARD-FAIL on an incomplete subagent
 * result rather than forwarding a truncated placeholder as the phase output.
 *
 * Bug class: the subagent runtime returns a `SubagentResult` with
 * `status: 'succeeded'` even when the run was incomplete — the tool-use cap
 * fired (`stopReason === 'tool_use_loop_capped'`) or the stream closed without a
 * terminal message (`stopReason === 'stream_incomplete'`). `isIncompleteStopReason`
 * (src/agent/subagent/result.ts) flags both. A consumer that reads
 * `result.message.content` gated ONLY on `status === 'succeeded'` silently treats
 * the partial as real output — and in mint that partial then feeds the NEXT phase.
 *
 * Same class as the forge STREAM_INCOMPLETE guard, but in mint's phase pipeline,
 * which has no qualify gate to catch a degraded phase. The fix extends each
 * phase's existing status guard with an `isIncompleteStopReason(stopReason)`
 * check that fires BEFORE `.message.content` is read.
 *
 * These tests cover the five "throw on failure" phases (spec/research/plan/ship/
 * heal). The sixth site (parallelize-dispatch) returns a discriminated union and
 * is covered in mint-parallelize-dispatch.test.ts.
 *
 * NB: `heal` wraps its dispatch in a try/catch that converts a throw into a
 * non-healed iteration (`healed: false`, iterations incremented) — so its guard
 * is asserted via the RETURNED value and the fact that the re-verify phase is
 * never reached, not via a rethrown error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TOOL_USE_LOOP_CAPPED } from '../agent/providers/shared/tool-loop-cap.js';
import { STREAM_INCOMPLETE } from '../agent/subagent/result.js';
import type { AgentModelInput, IAgentSession } from '../agent/types.js';

// ---- Mocks ---------------------------------------------------------------

// Mutable runToResult behavior, swapped per test. Defaults to a clean
// completion (no incomplete stopReason) so the "does NOT trip on a clean
// result" control cases pass.
let runToResultBehavior: () => Promise<{
  id: string;
  status: string;
  message: { content: string } | undefined;
  stopReason?: string;
  error?: { message: string };
}> = async () => ({
  id: 'mint-phase',
  status: 'succeeded',
  message: { content: 'clean phase output' },
});

vi.mock('../agent/subagent.js', () => ({
  SubagentManager: vi.fn(() => ({
    forkSubagent: vi.fn(async () => ({
      id: 'mint-phase',
      runToResult: vi.fn(async () => runToResultBehavior()),
    })),
    teardownAll: vi.fn(async () => undefined),
  })),
}));

// Every phase loads its prompt via loadSkillPrompts('mint'); return a stub map
// with all keys the phases read so the "missing prompt" guard never trips.
vi.mock('./_lib/prompt-loader.js', () => ({
  loadSkillPrompts: () => ({
    'spec.md': 'SPEC_PROMPT_STUB',
    'research.md': 'RESEARCH_PROMPT_STUB',
    'plan.md': 'PLAN_PROMPT_STUB',
    'ship.md': 'SHIP_PROMPT_STUB',
    'heal.md': 'HEAL_PROMPT_STUB',
  }),
}));

const resolveCredentialForModel = vi.hoisted(() =>
  vi.fn((m: string | undefined) => `resolved-key::${m}`),
);
vi.mock('../agent/auth/credential-resolver.js', () => ({
  resolveCredentialForModel,
}));

// heal re-runs the verify phase only when it trusts a fix landed. Mock it so we
// can assert the incomplete guard short-circuits BEFORE any re-verify happens.
const runVerifyPhaseSpy = vi.hoisted(() =>
  vi.fn(async () => ({
    testsPassed: true,
    lintPassed: true,
    designReviewPassed: true,
    issues: [] as string[],
  })),
);
vi.mock('./mint/_phases/verify.js', () => ({
  runVerifyPhase: runVerifyPhaseSpy,
}));

// Import phases after mocks are wired.
import { runSpecPhase } from './mint/_phases/spec.js';
import { runResearchPhase } from './mint/_phases/research.js';
import { runPlanPhase } from './mint/_phases/plan.js';
import { runShipPhase } from './mint/_phases/ship.js';
import { runHealPhase } from './mint/_phases/heal.js';
import type { MintState } from './mint/index.js';
import type { BuildResult } from './mint/_phases/build.js';
import type { VerifyResult } from './mint/_phases/verify.js';

const MODEL: AgentModelInput = 'sonnet';

function incomplete(stopReason: string, content = 'truncated placeholder') {
  return async () => ({
    id: 'mint-phase',
    status: 'succeeded' as const,
    message: { content },
    stopReason,
  });
}

function shipState(): MintState {
  return {
    currentPhase: 'ship',
    idea: 'Test feature',
    spec: 'spec',
    research: 'research',
    plan: 'plan',
    buildResults: { filesChanged: ['src/index.ts'], testsPassed: true, notes: 'built' },
    verifyResults: { testsPassed: true, lintPassed: true, designReviewPassed: true },
    healIterations: 0,
    history: [],
  };
}

function healSession(): IAgentSession {
  return {
    sessionId: 'sess-heal-guard',
    sendMessage: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    getInputStreamRef: vi.fn(),
    abortSignal: new AbortController().signal,
  };
}

const FAILING_VERIFY: VerifyResult = {
  testsPassed: false,
  lintPassed: false,
  designReviewPassed: false,
  issues: ['mocked failure'],
};
const BUILD: BuildResult = { filesChanged: ['src/index.ts'], testsPassed: true, notes: 'built' };

describe('mint phase incomplete-result guards (isIncompleteStopReason)', () => {
  beforeEach(() => {
    // Reset to a clean completion before each test.
    runToResultBehavior = async () => ({
      id: 'mint-phase',
      status: 'succeeded',
      message: { content: 'clean phase output' },
    });
    runVerifyPhaseSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---- spec ----------------------------------------------------------------

  it('spec: throws when the result is a tool_use_loop_capped partial', async () => {
    runToResultBehavior = incomplete(TOOL_USE_LOOP_CAPPED);
    await expect(runSpecPhase('idea', 'sess', undefined, undefined, MODEL)).rejects.toThrow(
      /spec phase returned an incomplete result \(stopReason=tool_use_loop_capped\)/,
    );
  });

  it('spec: throws when the result is a stream_incomplete partial', async () => {
    runToResultBehavior = incomplete(STREAM_INCOMPLETE);
    await expect(runSpecPhase('idea', 'sess', undefined, undefined, MODEL)).rejects.toThrow(
      /spec phase returned an incomplete result \(stopReason=stream_incomplete\)/,
    );
  });

  it('spec: returns content on a clean completion (guard does not over-trip)', async () => {
    // Default behavior is a clean succeeded result with no stopReason.
    await expect(runSpecPhase('idea', 'sess', undefined, undefined, MODEL)).resolves.toBe(
      'clean phase output',
    );
  });

  // ---- research ------------------------------------------------------------

  it('research: throws when the result is a tool_use_loop_capped partial', async () => {
    runToResultBehavior = incomplete(TOOL_USE_LOOP_CAPPED);
    await expect(
      runResearchPhase('spec', 'sess', undefined, undefined, MODEL),
    ).rejects.toThrow(/research phase returned an incomplete result \(stopReason=tool_use_loop_capped\)/);
  });

  it('research: returns content on a clean completion', async () => {
    await expect(
      runResearchPhase('spec', 'sess', undefined, undefined, MODEL),
    ).resolves.toBe('clean phase output');
  });

  // ---- plan ----------------------------------------------------------------

  it('plan: throws when the result is a stream_incomplete partial', async () => {
    runToResultBehavior = incomplete(STREAM_INCOMPLETE);
    await expect(
      runPlanPhase('spec', 'research', 'sess', undefined, undefined, MODEL),
    ).rejects.toThrow(/plan phase returned an incomplete result \(stopReason=stream_incomplete\)/);
  });

  it('plan: returns content on a clean completion', async () => {
    await expect(
      runPlanPhase('spec', 'research', 'sess', undefined, undefined, MODEL),
    ).resolves.toBe('clean phase output');
  });

  // ---- ship ----------------------------------------------------------------

  it('ship: throws when the result is a tool_use_loop_capped partial', async () => {
    runToResultBehavior = incomplete(TOOL_USE_LOOP_CAPPED);
    await expect(
      runShipPhase(shipState(), 'sess', undefined, undefined, MODEL),
    ).rejects.toThrow(/ship phase returned an incomplete result \(stopReason=tool_use_loop_capped\)/);
  });

  it('ship: returns content on a clean completion', async () => {
    await expect(
      runShipPhase(shipState(), 'sess', undefined, undefined, MODEL),
    ).resolves.toBe('clean phase output');
  });

  // ---- heal ----------------------------------------------------------------
  //
  // heal's throw is caught by its own try/catch and converted to a non-healed
  // iteration. The bug being fixed: an incomplete partial whose placeholder text
  // happens to carry `FIX_APPLIED: true` would previously be trusted and trigger
  // a re-verify. With the guard, the incomplete result short-circuits to
  // `healed: false` and the re-verify phase is NEVER reached.

  it('heal: an incomplete partial (with FIX_APPLIED: true text) does NOT trigger re-verify', async () => {
    runToResultBehavior = incomplete(TOOL_USE_LOOP_CAPPED, 'FIX_APPLIED: true\n\ntruncated');
    const result = await runHealPhase(
      'plan',
      BUILD,
      FAILING_VERIFY,
      0, // healIterations
      healSession(),
      undefined, // skillCallId
      MODEL,
    );
    expect(result.healed).toBe(false);
    // The guard fired before the FIX_APPLIED marker was read → no re-verify.
    expect(runVerifyPhaseSpy).not.toHaveBeenCalled();
    // The catch path increments the iteration counter.
    expect(result.newHealIterations).toBe(1);
    // Verify results are passed through unchanged.
    expect(result.newVerifyResults).toEqual(FAILING_VERIFY);
  });

  it('heal: a stream_incomplete partial also short-circuits without re-verify', async () => {
    runToResultBehavior = incomplete(STREAM_INCOMPLETE, 'FIX_APPLIED: true\n\ntruncated');
    const result = await runHealPhase(
      'plan',
      BUILD,
      FAILING_VERIFY,
      1,
      healSession(),
      undefined,
      MODEL,
    );
    expect(result.healed).toBe(false);
    expect(runVerifyPhaseSpy).not.toHaveBeenCalled();
    expect(result.newHealIterations).toBe(2);
  });

  it('heal: a CLEAN result with FIX_APPLIED: true DOES reach re-verify (guard does not over-trip)', async () => {
    // Control: clean completion (no incomplete stopReason) with a fix marker
    // must flow through to the re-verify phase, proving the guard is specific
    // to incomplete results and not a blanket block.
    runToResultBehavior = async () => ({
      id: 'mint-phase',
      status: 'succeeded',
      message: { content: 'FIX_APPLIED: true\n\napplied the fix' },
    });
    const result = await runHealPhase(
      'plan',
      BUILD,
      FAILING_VERIFY,
      0,
      healSession(),
      undefined,
      MODEL,
    );
    expect(runVerifyPhaseSpy).toHaveBeenCalledTimes(1);
    // Mocked re-verify returns all-pass → healed true.
    expect(result.healed).toBe(true);
    expect(result.newHealIterations).toBe(1);
  });
});
