/**
 * Deterministic validation contracts for `afk improve eval-run`.
 *
 * Each contract is the **smallest deterministic check** that a guardrail
 * associated with one {@link FailurePattern} is present and behaving. A
 * contract runs entirely in-process: no LLM, no network, no patch/apply, and
 * no I/O side effects (the circuit-breaker probe builds a throwaway dispatcher
 * with no trace writer / hooks; the others read constants and pure helpers).
 *
 * ## Guardrail-presence vs. fixture-replay
 *
 * The contracts here are the guardrail-PRESENCE layer: each proves a guardrail
 * EXISTS and behaves against a synthetic stimulus. A complementary
 * fixture-REPLAY layer ({@link ./replay}) re-drives a card's actual recorded
 * failure through the live guardrail for patterns that have a handler
 * (currently `repeated-tool-use` and `closure-anomaly`); the runner runs both.
 * A contract validates the *fix* — the guardrail the pattern maps to:
 *
 *   - `repeated-tool-use`    → the repeat-loop circuit breaker (PR #80).
 *   - `subagent-block`       → the skill max-depth recovery hint (PR #80).
 *   - `tool-failure-density` → that detector being enabled by default (PR #80).
 *   - `closure-anomaly`      → the abort-closure recovery hint
 *                              (`session/closure-guidance.ts`; abort subtype).
 *
 * Patterns with no registered contract resolve to `undefined`; the runner
 * records an `unsupported` result rather than failing.
 *
 * ## Adding a contract
 *
 *   1. Implement `async function run(): Promise<ContractProbeResult>`.
 *   2. Append an {@link EvalContract} entry keyed on its `patternId`.
 *   3. Exercise the REAL guardrail (import the production symbol) so a
 *      regression in the guardrail is caught here — never re-implement it.
 *
 * @module improve/eval-run/contracts
 */

import {
  REPEAT_CIRCUIT_BREAKER_THRESHOLD,
  SessionToolDispatcher,
} from '../../agent/tools/dispatcher.js';
import type { ToolCall, ToolHandler, ToolResult } from '../../agent/tools/types.js';
import {
  SKILL_MAX_DEPTH_RECOVERY_HINT,
  buildSkillMaxDepthRefusal,
} from '../../agent/tools/skill-depth-message.js';
import {
  CLOSURE_ABORT_RECOVERY_HINT,
  buildClosureGuidance,
} from '../../agent/session/closure-guidance.js';
import {
  defaultEnabledDetectorNames,
  disabledByDefaultDetectorNames,
} from '../scan/detectors/index.js';
import { detectToolFailureDensity } from '../scan/detectors/tool-failure-density.js';
import { parseTraceContent, type SessionRead } from '../scan/reader.js';
import type { ToolFailureClass } from '../../agent/trace/types.js';
import type { EvalCheck, EvalCheckStatus, EvalRunEvidenceRef, FailurePattern } from '../schemas.js';

// ---------------------------------------------------------------------------
// Contract surface
// ---------------------------------------------------------------------------

export interface ContractProbeResult {
  checks: EvalCheck[];
  evidence: EvalRunEvidenceRef[];
}

export interface EvalContract {
  /** Stable id, written to the eval-run's `contract` field. */
  id: string;
  /** The pattern whose guardrail this contract validates. */
  patternId: FailurePattern;
  /** One-line human description. */
  title: string;
  /** Run the deterministic probe. Pure modulo throwaway in-memory objects. */
  run: () => Promise<ContractProbeResult>;
}

/** Cap on `expected`/`actual`/`detail` snapshots so artifacts stay readable. */
const SNAPSHOT_MAX = 400;

/** Trim a value for an artifact snapshot — single line, bounded length. */
export function snapshot(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value);
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > SNAPSHOT_MAX ? oneLine.slice(0, SNAPSHOT_MAX - 1) + '…' : oneLine;
}

/** Build a check record. `pass` is the boolean the assertion evaluated to. */
export function makeCheck(args: {
  name: string;
  description: string;
  pass: boolean;
  expected: string;
  actual: string;
  /** Force a non-pass/fail status (e.g. `'skipped'`). Overrides `pass`. */
  status?: EvalCheckStatus;
}): EvalCheck {
  return {
    name: args.name,
    description: args.description,
    status: args.status ?? (args.pass ? 'pass' : 'fail'),
    expected: snapshot(args.expected),
    actual: snapshot(args.actual),
  };
}

// ---------------------------------------------------------------------------
// Contract: repeated-tool-use → repeat-loop circuit breaker (PR #80)
// ---------------------------------------------------------------------------

const PROBE_TOOL = 'eval_run_probe_tool';

/**
 * Exercise the real {@link SessionToolDispatcher} repeat-loop circuit breaker.
 *
 * Builds a throwaway dispatcher (no hooks, no permissions allowlist beyond the
 * probe tool, no trace writer → zero side effects), fires the same call with
 * byte-identical input, and asserts the documented threshold behavior:
 *   - the first THRESHOLD-1 identical calls execute,
 *   - call #THRESHOLD is short-circuited with `circuitBreaker: true`,
 *   - the breaker counts CONSECUTIVE calls (a different input resets it).
 */
async function runRepeatLoopCircuitBreaker(): Promise<ContractProbeResult> {
  const threshold = REPEAT_CIRCUIT_BREAKER_THRESHOLD;
  let handlerCalls = 0;
  const handler: ToolHandler = async () => {
    handlerCalls += 1;
    return { content: 'probe-ok' };
  };
  const dispatcher = new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([[PROBE_TOOL, handler]]),
    schemas: [],
    // Deliberately hook-less probe dispatcher — declared explicitly now that
    // hookRegistry is a required key on the dispatcher options.
    hookRegistry: undefined,
    permissions: { allowedTools: [PROBE_TOOL] },
  });

  const signal = new AbortController().signal;
  const makeCall = (input: unknown): ToolCall => ({
    id: 'eval-run-probe',
    name: PROBE_TOOL,
    input,
    signal,
  });
  const identical = { probe: 'byte-identical-input' };

  const below: ToolResult[] = [];
  for (let i = 0; i < threshold - 1; i++) {
    below.push(await dispatcher.execute(makeCall(identical)));
  }
  const handlerAfterBelow = handlerCalls;
  const tripped = await dispatcher.execute(makeCall(identical));
  const handlerAfterTrip = handlerCalls;
  const afterReset = await dispatcher.execute(makeCall({ probe: 'a-different-input' }));

  const belowAllClean = below.every((r) => r.isError !== true && r.circuitBreaker !== true);

  const checks: EvalCheck[] = [
    makeCheck({
      name: 'executes-below-threshold',
      description: `First ${threshold - 1} byte-identical calls execute without tripping`,
      pass: belowAllClean && handlerAfterBelow === threshold - 1,
      expected: `${threshold - 1} clean executions; handler runs ${threshold - 1}×`,
      actual: `${below.filter((r) => r.isError !== true).length} clean; handler ran ${handlerAfterBelow}×`,
    }),
    makeCheck({
      name: 'trips-at-threshold',
      description: `Call #${threshold} is short-circuited with isError + circuitBreaker, handler skipped`,
      pass:
        tripped.isError === true &&
        tripped.circuitBreaker === true &&
        handlerAfterTrip === handlerAfterBelow,
      expected: 'isError=true, circuitBreaker=true, handler not re-run',
      actual: `isError=${tripped.isError ?? false}, circuitBreaker=${tripped.circuitBreaker ?? false}, handler ran ${handlerAfterTrip}×`,
    }),
    makeCheck({
      name: 'breaker-message-is-actionable',
      description: 'The synthetic block names the looping tool and reads as a stop nudge',
      pass: /circuit breaker/i.test(tripped.content) && tripped.content.includes(PROBE_TOOL),
      expected: `mentions "circuit breaker" and the tool name "${PROBE_TOOL}"`,
      actual: tripped.content,
    }),
    makeCheck({
      name: 'resets-on-different-input',
      description: 'A different-input call after a trip resets the consecutive counter and executes',
      pass: afterReset.isError !== true && afterReset.circuitBreaker !== true && handlerCalls === handlerAfterTrip + 1,
      expected: 'executes (no breaker), handler runs once more',
      actual: `isError=${afterReset.isError ?? false}, circuitBreaker=${afterReset.circuitBreaker ?? false}, handler ran ${handlerCalls}×`,
    }),
  ];

  const evidence: EvalRunEvidenceRef[] = [
    {
      kind: 'config-value',
      ref: 'src/agent/tools/dispatcher.ts#REPEAT_CIRCUIT_BREAKER_THRESHOLD',
      detail: String(threshold),
    },
    {
      kind: 'observed-behavior',
      ref: 'SessionToolDispatcher.execute',
      detail: `handler ran ${handlerAfterTrip}× across ${threshold} byte-identical calls; call #${threshold} short-circuited (circuitBreaker=${tripped.circuitBreaker ?? false})`,
    },
  ];

  return { checks, evidence };
}

// ---------------------------------------------------------------------------
// Contract: subagent-block → skill max-depth recovery hint (PR #80)
// ---------------------------------------------------------------------------

// KNOWN MISMAPPING — do NOT add a fixture-replay for `subagent-block` against
// this guardrail. The `subagent-block` DETECTOR fires on `hook_decision` events
// with `hookEvent:'SubagentStart'` + `decision:'block'`
// (src/improve/scan/detectors/subagent-block.ts), emitted by a user/plugin hook
// via `dispatchSubagentStart` (src/agent/subagent-hooks.ts). This contract
// instead validates the skill MAX-DEPTH refusal (`buildSkillMaxDepthRefusal`),
// which fires inside skill-executor.ts BEFORE `forkSubagent` and emits a
// `delegation.skipped` routing row — NOT the `hook_decision` event the detector
// reads. So this contract proves a guardrail the detector never observes, and
// no runtime guardrail neutralises a recurring SubagentStart block. The mapping
// must be resolved before `subagent-block` gets a fixture-replay; left intact in
// this slice (see contracts.test.ts and the recon plan for the full write-up).

/**
 * Assert the skill-tool max-depth refusal carries the actionable recovery
 * hint. Validates the same builder {@link SkillExecutor.execute} returns, so a
 * regression that drops the hint is caught — without firing the executor's
 * `delegation.skipped` routing telemetry as a side effect.
 */
async function runSkillMaxDepthRecoveryHint(): Promise<ContractProbeResult> {
  const depth = 3;
  const maxDepth = 3;
  const message = buildSkillMaxDepthRefusal(depth, maxDepth);

  const checks: EvalCheck[] = [
    makeCheck({
      name: 'refusal-states-depth',
      description: 'Refusal reports the depth that was hit and the max',
      pass: message.includes(`nesting depth ${depth} (max ${maxDepth})`),
      expected: `mentions "nesting depth ${depth} (max ${maxDepth})"`,
      actual: message,
    }),
    makeCheck({
      name: 'recovery-hint-present',
      description: 'Refusal carries the recovery hint clause',
      pass: message.includes(SKILL_MAX_DEPTH_RECOVERY_HINT),
      expected: 'contains SKILL_MAX_DEPTH_RECOVERY_HINT',
      actual: message,
    }),
    makeCheck({
      name: 'hint-directs-inline-work',
      description: 'Hint tells the model to work inline instead of delegating further',
      pass:
        /perform the work inline/i.test(SKILL_MAX_DEPTH_RECOVERY_HINT) &&
        /skill\/agent\/compose/i.test(SKILL_MAX_DEPTH_RECOVERY_HINT),
      expected: 'hint mentions "perform the work inline" and "skill/agent/compose"',
      actual: SKILL_MAX_DEPTH_RECOVERY_HINT,
    }),
  ];

  const evidence: EvalRunEvidenceRef[] = [
    {
      kind: 'source-symbol',
      ref: 'src/agent/tools/skill-depth-message.ts#buildSkillMaxDepthRefusal',
      detail: message,
    },
    {
      kind: 'source-symbol',
      ref: 'src/agent/tools/skill-executor.ts (execute: depth >= maxDepth branch)',
      detail: 'returns buildSkillMaxDepthRefusal(depth, maxDepth)',
    },
  ];

  return { checks, evidence };
}

// ---------------------------------------------------------------------------
// Contract: tool-failure-density → enabled by default (PR #80) + classification
//           fidelity (synthetic-corpus detector exercise)
// ---------------------------------------------------------------------------
//
// `tool-failure-density` has no runtime guardrail to re-drive a recorded failure
// through (unlike repeated-tool-use's circuit breaker or closure-anomaly's
// recovery-hint builder), so it gets NO fixture-replay. What CAN regress and
// silently manufacture/suppress real cards is the detector's CLASSIFICATION math
// — the "system-said-no" exclusions, the circuit-breaker exclusion, and the dual
// count+rate threshold. The classification probe below exercises the live
// `detectToolFailureDensity` over a hand-verifiable synthetic corpus to pin that
// behaviour. No fixture file, no schema change.

const TFD_DETECTOR = 'tool-failure-density';

// Synthetic-corpus tool names + their derived card slugs (see makeSlug in the
// detector). The test asserts against these exact slugs, so they live here as
// the single source of truth.
const TFD_FLAKY_TOOL = 'flaky_tool';
const TFD_REFUSAL_ONLY_TOOL = 'refusal_only_tool';
const TFD_FLAKY_TOOL_SLUG = 'tool-failure-flaky-tool';
const TFD_REFUSAL_ONLY_TOOL_SLUG = 'tool-failure-refusal-only-tool';

/**
 * Assert the `tool-failure-density` detector runs in a default `afk improve
 * scan` (no `--only` / `--include-disabled`). Validates the live detector
 * registry — a regression flipping it back to opt-in is caught.
 */
async function runToolFailureDensityEnabled(): Promise<ContractProbeResult> {
  const enabled = defaultEnabledDetectorNames();
  const disabled = disabledByDefaultDetectorNames();

  const checks: EvalCheck[] = [
    makeCheck({
      name: 'in-default-enabled-set',
      description: `${TFD_DETECTOR} runs in a default scan`,
      pass: enabled.includes(TFD_DETECTOR),
      expected: `defaultEnabledDetectorNames() includes "${TFD_DETECTOR}"`,
      actual: `[${enabled.join(', ')}]`,
    }),
    makeCheck({
      name: 'not-opt-in',
      description: `${TFD_DETECTOR} is not in the disabled-by-default set`,
      pass: !disabled.includes(TFD_DETECTOR),
      expected: `disabledByDefaultDetectorNames() excludes "${TFD_DETECTOR}"`,
      actual: `[${disabled.join(', ')}]`,
    }),
  ];

  const evidence: EvalRunEvidenceRef[] = [
    {
      kind: 'config-value',
      ref: "DETECTOR_REGISTRY['tool-failure-density'].enabledByDefault",
      detail: String(enabled.includes(TFD_DETECTOR)),
    },
  ];

  return { checks, evidence };
}

// --- Synthetic classification corpus --------------------------------------

/** Render one synthetic `tool_call` `completed` trace line (schema-valid JSONL). */
function tfdCompletedLine(
  seq: number,
  name: string,
  opts: {
    isError: boolean;
    failureClass?: ToolFailureClass;
    circuitBreaker?: boolean;
  },
): string {
  const payload: Record<string, unknown> = {
    phase: 'completed',
    toolUseId: `tu-${seq}`,
    name,
    resultBytes: 128,
    isError: opts.isError,
    truncated: false,
    durationMs: 10,
  };
  if (opts.circuitBreaker === true) payload['circuitBreaker'] = true;
  if (opts.failureClass !== undefined) payload['failureClass'] = opts.failureClass;
  return JSON.stringify({ ts: '2026-06-20T10:00:00.000Z', seq, kind: 'tool_call', payload });
}

/** Parse synthetic JSONL lines into a `SessionRead` via the real reader, so the
 *  corpus is schema-validated exactly like a witness trace on disk. */
function tfdSession(sessionId: string, lines: string[]): SessionRead {
  const relativeTracePath = `state/witness/${sessionId}/trace.jsonl`;
  return parseTraceContent({
    sessionId,
    tracePath: relativeTracePath,
    relativeTracePath,
    content: lines.join('\n') + '\n',
    sessionMtimeMs: 0,
  });
}

/**
 * The synthetic corpus the classification probe runs over. Exported so the
 * contract test asserts against the SAME stimulus the contract sees.
 *
 * Hand-verifiable expected detector output at defaults (minFailures=3,
 * minFailureRate=0.25):
 *
 *   `flaky_tool` → ONE card. Counted: sess-a {success, timeout-fail,
 *     unclassified-fail} + sess-b {unclassified-fail, success} = 5 calls,
 *     3 failures, rate 0.6. Excluded from BOTH numerator and denominator:
 *     policy-refusal / permission-denied / abort / hook-block /
 *     elicitation-declined (1 each) → excludedByClass; plus one circuitBreaker
 *     block (skipped BEFORE the class check, so it never appears in
 *     excludedByClass and never inflates totalCalls or the unclassified count).
 *     failureClassBreakdown = {timeout:1, unclassified:2}; affected sessions
 *     {sess-a, sess-b}; failure seqs [1, 2, 0] (sess-a first, then sess-b).
 *
 *   `refusal_only_tool` → NO card. All 5 isError results are excluded classes,
 *     so 0 counted failures — despite a raw 5/6 error rate that WOULD fire if
 *     the exclusion regressed. This is the false-positive guard (the
 *     browser_open / ask_question "looked broken but was working as designed"
 *     class of bug).
 */
export function buildToolFailureClassificationCorpus(): SessionRead[] {
  const sessA = tfdSession('tfd-sess-a', [
    tfdCompletedLine(0, TFD_FLAKY_TOOL, { isError: false }),
    tfdCompletedLine(1, TFD_FLAKY_TOOL, { isError: true, failureClass: 'timeout' }),
    tfdCompletedLine(2, TFD_FLAKY_TOOL, { isError: true }), // unclassified — counts
    tfdCompletedLine(3, TFD_FLAKY_TOOL, { isError: true, failureClass: 'policy-refusal' }), // excluded
    tfdCompletedLine(4, TFD_FLAKY_TOOL, { isError: true, circuitBreaker: true }), // excluded (synthetic)
  ]);
  const sessB = tfdSession('tfd-sess-b', [
    tfdCompletedLine(0, TFD_FLAKY_TOOL, { isError: true }), // unclassified — counts
    tfdCompletedLine(1, TFD_FLAKY_TOOL, { isError: false }),
    tfdCompletedLine(2, TFD_FLAKY_TOOL, { isError: true, failureClass: 'permission-denied' }), // excluded
    tfdCompletedLine(3, TFD_FLAKY_TOOL, { isError: true, failureClass: 'abort' }), // excluded
    tfdCompletedLine(4, TFD_FLAKY_TOOL, { isError: true, failureClass: 'hook-block' }), // excluded
    tfdCompletedLine(5, TFD_FLAKY_TOOL, { isError: true, failureClass: 'elicitation-declined' }), // excluded
  ]);
  const sessC = tfdSession('tfd-sess-c', [
    tfdCompletedLine(0, TFD_REFUSAL_ONLY_TOOL, { isError: false }),
    tfdCompletedLine(1, TFD_REFUSAL_ONLY_TOOL, { isError: true, failureClass: 'policy-refusal' }),
    tfdCompletedLine(2, TFD_REFUSAL_ONLY_TOOL, { isError: true, failureClass: 'policy-refusal' }),
    tfdCompletedLine(3, TFD_REFUSAL_ONLY_TOOL, { isError: true, failureClass: 'permission-denied' }),
    tfdCompletedLine(4, TFD_REFUSAL_ONLY_TOOL, { isError: true, failureClass: 'hook-block' }),
    tfdCompletedLine(5, TFD_REFUSAL_ONLY_TOOL, { isError: true, failureClass: 'abort' }),
  ]);
  return [sessA, sessB, sessC];
}

// --- Classification-probe helpers -----------------------------------------

/** Read a numeric detail field, or `undefined` when absent / non-numeric. */
function tfdNum(detail: Record<string, unknown>, key: string): number | undefined {
  const v = detail[key];
  return typeof v === 'number' ? v : undefined;
}

/** Normalise a `{class: count}` blob to a plain record of numbers. */
function tfdCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

/** Order-independent equality of two `{key: count}` maps. */
function tfdSameCounts(actual: unknown, expected: Record<string, number>): boolean {
  const a = tfdCounts(actual);
  const aKeys = Object.keys(a);
  const eKeys = Object.keys(expected);
  if (aKeys.length !== eKeys.length) return false;
  for (const k of eKeys) {
    if (a[k] !== expected[k]) return false;
  }
  return true;
}

function tfdNumArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : [];
}

function tfdStrArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Synthetic-corpus classification probe for `tool-failure-density`.
 *
 * Feeds {@link buildToolFailureClassificationCorpus} through the LIVE
 * {@link detectToolFailureDensity} and asserts the classification math most
 * prone to silent regression: the "system-said-no" exclusions, the
 * circuit-breaker exclusion, the timeout/unclassified inclusions, the dual
 * count+rate threshold, and the emitted counts / rate / breakdowns / affected
 * sessions / seqs. Pure (no I/O); a regression in the detector surfaces here as
 * a failing check, exactly as it would in a real `afk improve eval-run`.
 */
function runToolFailureDensityClassification(): ContractProbeResult {
  const corpus = buildToolFailureClassificationCorpus();
  const cards = detectToolFailureDensity(corpus, {});
  const flaky = cards.find((c) => c.slug === TFD_FLAKY_TOOL_SLUG);
  const refusalOnly = cards.find((c) => c.slug === TFD_REFUSAL_ONLY_TOOL_SLUG);

  const detail: Record<string, unknown> = flaky?.detail ?? {};
  const failureCount = tfdNum(detail, 'failureCount');
  const totalCalls = tfdNum(detail, 'totalCalls');
  const failureRate = tfdNum(detail, 'failureRate');
  const affectedSessionCount = tfdNum(detail, 'affectedSessionCount');
  const breakdown = tfdCounts(detail['failureClassBreakdown']);
  const excluded = tfdCounts(detail['excludedByClass']);
  const sessionIds = tfdStrArray(detail['sessionIds']).slice().sort();
  const seqs = tfdNumArray(detail['seqs']);

  // Threshold gates: raise the count floor above the recorded 3, and the rate
  // floor above the recorded 0.6, and assert the card drops out each time —
  // proving BOTH thresholds must clear (dual AND), not just one.
  const aboveCount = detectToolFailureDensity(corpus, { minFailures: 4 });
  const aboveRate = detectToolFailureDensity(corpus, { minFailureRate: 0.7 });
  const countGate = !aboveCount.some((c) => c.slug === TFD_FLAKY_TOOL_SLUG);
  const rateGate = !aboveRate.some((c) => c.slug === TFD_FLAKY_TOOL_SLUG);

  const expectedExcluded: Record<string, number> = {
    'policy-refusal': 1,
    'permission-denied': 1,
    abort: 1,
    'hook-block': 1,
    'elicitation-declined': 1,
  };
  const expectedBreakdown: Record<string, number> = { timeout: 1, unclassified: 2 };

  const checks: EvalCheck[] = [
    makeCheck({
      name: 'classification-fires-on-dual-threshold',
      description:
        'A tool clearing BOTH the failure-count and failure-rate floors yields exactly one card at the recorded magnitude',
      pass:
        cards.length === 1 &&
        flaky !== undefined &&
        failureCount === 3 &&
        totalCalls === 5 &&
        failureRate === 0.6,
      expected: `1 card '${TFD_FLAKY_TOOL_SLUG}' with failureCount=3, totalCalls=5, failureRate=0.6`,
      actual:
        flaky === undefined
          ? `no '${TFD_FLAKY_TOOL_SLUG}' card; ${cards.length} card(s): [${cards.map((c) => c.slug).join(', ')}]`
          : `${cards.length} card(s); failureCount=${failureCount}, totalCalls=${totalCalls}, failureRate=${failureRate}`,
    }),
    makeCheck({
      name: 'classification-excludes-system-said-no-classes',
      description:
        'policy-refusal / permission-denied / hook-block / abort / elicitation-declined are excluded from BOTH numerator and denominator and never manufacture a card alone',
      pass:
        tfdSameCounts(excluded, expectedExcluded) &&
        failureCount === 3 &&
        totalCalls === 5 &&
        refusalOnly === undefined,
      expected:
        'excludedByClass={policy-refusal:1,permission-denied:1,abort:1,hook-block:1,elicitation-declined:1}; counts not inflated; refusal-only tool yields NO card',
      actual: `excludedByClass=${JSON.stringify(excluded)}; failureCount=${failureCount}, totalCalls=${totalCalls}; refusal_only_tool card ${refusalOnly === undefined ? 'absent' : 'PRESENT'}`,
    }),
    makeCheck({
      name: 'classification-excludes-circuit-breaker',
      description:
        'A circuitBreaker-synthesised completion is skipped before classification — it inflates neither totalCalls nor the unclassified count, and never lands in excludedByClass',
      pass: totalCalls === 5 && breakdown['unclassified'] === 2 && excluded['circuitBreaker'] === undefined,
      expected:
        'totalCalls=5 (breaker not counted); unclassified=2 (breaker not folded in); no circuitBreaker key in excludedByClass',
      actual: `totalCalls=${totalCalls}; unclassified=${breakdown['unclassified'] ?? 0}; excludedByClass keys=[${Object.keys(excluded).join(', ')}]`,
    }),
    makeCheck({
      name: 'classification-counts-timeout-and-unclassified',
      description: 'timeout and unclassified (no failureClass) failures DO count toward the failure stats',
      pass: tfdSameCounts(breakdown, expectedBreakdown),
      expected: 'failureClassBreakdown={timeout:1,unclassified:2}',
      actual: `failureClassBreakdown=${JSON.stringify(breakdown)}`,
    }),
    makeCheck({
      name: 'classification-respects-thresholds',
      description:
        'The card drops out when EITHER the count floor or the rate floor is raised above the recorded magnitude (dual AND threshold)',
      pass: countGate && rateGate,
      expected: 'minFailures=4 → no card (count gate); minFailureRate=0.7 → no card (rate gate)',
      actual: `count gate ${countGate ? 'held' : 'LEAKED'}; rate gate ${rateGate ? 'held' : 'LEAKED'}`,
    }),
    makeCheck({
      name: 'classification-reports-affected-sessions-and-seqs',
      description: 'The card reports the distinct affected sessions and per-failure seqs in deterministic order',
      pass:
        affectedSessionCount === 2 &&
        JSON.stringify(sessionIds) === JSON.stringify(['tfd-sess-a', 'tfd-sess-b']) &&
        JSON.stringify(seqs) === JSON.stringify([1, 2, 0]),
      expected: 'affectedSessionCount=2; sessionIds=[tfd-sess-a,tfd-sess-b]; seqs=[1,2,0]',
      actual: `affectedSessionCount=${affectedSessionCount}; sessionIds=[${sessionIds.join(',')}]; seqs=[${seqs.join(',')}]`,
    }),
  ];

  const evidence: EvalRunEvidenceRef[] = [
    {
      kind: 'source-symbol',
      ref: 'src/improve/scan/detectors/tool-failure-density.ts#detectToolFailureDensity',
      detail:
        flaky === undefined
          ? `synthetic corpus → ${cards.length} card(s); '${TFD_FLAKY_TOOL_SLUG}' absent`
          : `synthetic corpus → flaky_tool ${failureCount}/${totalCalls} (rate ${failureRate}); breakdown ${JSON.stringify(breakdown)}`,
    },
    {
      kind: 'observed-behavior',
      ref: 'detectToolFailureDensity (EXCLUDED_FAILURE_CLASSES + circuitBreaker exclusion)',
      detail: `excludedByClass=${JSON.stringify(excluded)}; refusal_only_tool card ${refusalOnly === undefined ? 'absent' : 'PRESENT'}`,
    },
  ];

  return { checks, evidence };
}

/**
 * The registered `tool-failure-density` contract: the enabled-by-default
 * presence check (proves the detector runs in a default scan) followed by the
 * synthetic-corpus classification probe (proves the detector classifies a known
 * failure mix correctly). Kept under the stable contract id
 * `tool-failure-density-enabled` so existing eval-run artifacts keep resolving.
 */
async function runToolFailureDensityContract(): Promise<ContractProbeResult> {
  const presence = await runToolFailureDensityEnabled();
  const classification = runToolFailureDensityClassification();
  return {
    checks: [...presence.checks, ...classification.checks],
    evidence: [...presence.evidence, ...classification.evidence],
  };
}

// ---------------------------------------------------------------------------
// Contract: closure-anomaly → actionable recovery hint on abort closures
// ---------------------------------------------------------------------------

/**
 * Assert the `closure-anomaly` guardrail maps an `abort` closure to an
 * actionable recovery hint, and does NOT fabricate guidance for a benign
 * close. Validates the same {@link buildClosureGuidance} the session's
 * `emitClosure` wires onto the `closure` trace event — a regression that
 * drops the hint (or starts emitting one on clean closes) is caught here.
 *
 * Scoped to the `abort` subtype: the only closure reason the guardrail covers
 * today (see `closure-guidance.ts`). The contract validates the GUARDRAIL the
 * pattern maps to, not a fixture replay — matching the other contracts.
 */
async function runClosureAnomalyRecoveryHint(): Promise<ContractProbeResult> {
  const abortGuidance = buildClosureGuidance('abort');
  const benignGuidance = buildClosureGuidance('model_end_turn');

  const checks: EvalCheck[] = [
    makeCheck({
      name: 'abort-closure-has-guidance',
      description: 'An abort closure maps to a non-empty recovery hint',
      pass: typeof abortGuidance === 'string' && abortGuidance.trim().length > 0,
      expected: 'non-empty guidance string for reason=abort',
      actual: abortGuidance === null ? 'null (no guidance)' : snapshot(abortGuidance),
    }),
    makeCheck({
      name: 'guidance-names-a-recovery-action',
      description: 'The abort hint names a concrete next action (resume / re-run)',
      pass: abortGuidance !== null && /\b(resume|re-run|rerun|retry)\b/i.test(abortGuidance),
      expected: 'hint mentions resume / re-run',
      actual: abortGuidance === null ? 'null' : snapshot(abortGuidance),
    }),
    makeCheck({
      name: 'guidance-is-the-canonical-constant',
      description: 'The wired hint is the exported CLOSURE_ABORT_RECOVERY_HINT (no drift)',
      pass: abortGuidance === CLOSURE_ABORT_RECOVERY_HINT,
      expected: 'buildClosureGuidance("abort") === CLOSURE_ABORT_RECOVERY_HINT',
      actual: abortGuidance === null ? 'null' : snapshot(abortGuidance),
    }),
    makeCheck({
      name: 'benign-closure-has-no-guidance',
      description: 'A clean model_end_turn close carries no false-positive guidance',
      pass: benignGuidance === null,
      expected: 'null for reason=model_end_turn',
      actual: benignGuidance === null ? 'null' : snapshot(benignGuidance),
    }),
  ];

  const evidence: EvalRunEvidenceRef[] = [
    {
      kind: 'source-symbol',
      ref: 'src/agent/session/closure-guidance.ts#buildClosureGuidance',
      detail: abortGuidance === null ? 'null' : snapshot(abortGuidance),
    },
    {
      kind: 'source-symbol',
      ref: 'src/agent/session/agent-session.ts (emitClosure: attaches guidance to closure event)',
      detail: 'buildClosureGuidance(reason) → closure payload .guidance',
    },
  ];

  return { checks, evidence };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const CONTRACTS: readonly EvalContract[] = Object.freeze([
  {
    id: 'repeat-loop-circuit-breaker',
    patternId: 'repeated-tool-use',
    title: 'Repeat-loop circuit breaker trips at the consecutive-identical threshold',
    run: runRepeatLoopCircuitBreaker,
  },
  {
    id: 'skill-max-depth-recovery-hint',
    patternId: 'subagent-block',
    title: 'Skill max-depth refusal carries an actionable recovery hint',
    run: runSkillMaxDepthRecoveryHint,
  },
  {
    id: 'tool-failure-density-enabled',
    patternId: 'tool-failure-density',
    title: 'tool-failure-density detector is enabled by default and classifies a known failure mix correctly',
    run: runToolFailureDensityContract,
  },
  {
    id: 'closure-abort-recovery-hint',
    patternId: 'closure-anomaly',
    title: 'Anomalous abort closure carries an actionable recovery hint',
    run: runClosureAnomalyRecoveryHint,
  },
] satisfies EvalContract[]);

/** Resolve the validation contract for a pattern, or `undefined` if none. */
export function resolveContract(patternId: FailurePattern): EvalContract | undefined {
  return CONTRACTS.find((c) => c.patternId === patternId);
}

/** Patterns that currently have a deterministic validation contract. */
export function supportedContractPatterns(): readonly FailurePattern[] {
  return CONTRACTS.map((c) => c.patternId);
}

/** All registered contract ids (for `--help` text and diagnostics). */
export function knownContractIds(): readonly string[] {
  return CONTRACTS.map((c) => c.id);
}
