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
 *   - `repeated-tool-use`    -> the repeat-loop circuit breaker (PR #80).
 *   - `subagent-block`       -> the skill max-depth recovery hint (PR #80).
 *   - `tool-failure-density` -> that detector being enabled by default (PR #80).
 *   - `closure-anomaly`      -> the closure recovery hint (`session/closure-guidance.ts`;
 *                              abort + truncated subtypes).
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
 * The tool-failure-density contract implementation lives in
 * {@link ./contracts.tfd} to keep each file under the 350 code-line ceiling.
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
  CLOSURE_TRUNCATED_RECOVERY_HINT,
  buildClosureGuidance,
} from '../../agent/session/closure-guidance.js';
import type { EvalCheck, EvalRunEvidenceRef, FailurePattern } from '../schemas.js';
import { makeCheck, snapshot, type ContractProbeResult, type EvalContract } from './contracts.types.js';
import { runToolFailureDensityContract } from './contracts.tfd.js';

// Re-export the shared surface so callers that import from this module path
// continue to resolve without change.
export type { ContractProbeResult, EvalContract } from './contracts.types.js';
export { makeCheck, snapshot } from './contracts.types.js';

// Re-export so tests that import buildToolFailureClassificationCorpus from
// this module path continue to resolve.
export { buildToolFailureClassificationCorpus } from './contracts.tfd.js';

// ---------------------------------------------------------------------------
// Contract: repeated-tool-use -> repeat-loop circuit breaker (PR #80)
// ---------------------------------------------------------------------------

const PROBE_TOOL = 'eval_run_probe_tool';

/**
 * Exercise the real {@link SessionToolDispatcher} repeat-loop circuit breaker.
 *
 * Builds a throwaway dispatcher (no hooks, no permissions allowlist beyond the
 * probe tool, no trace writer -> zero side effects), fires the same call with
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
      expected: `${threshold - 1} clean executions; handler runs ${threshold - 1}\u00d7`,
      actual: `${below.filter((r) => r.isError !== true).length} clean; handler ran ${handlerAfterBelow}\u00d7`,
    }),
    makeCheck({
      name: 'trips-at-threshold',
      description: `Call #${threshold} is short-circuited with isError + circuitBreaker, handler skipped`,
      pass:
        tripped.isError === true &&
        tripped.circuitBreaker === true &&
        handlerAfterTrip === handlerAfterBelow,
      expected: 'isError=true, circuitBreaker=true, handler not re-run',
      actual: `isError=${tripped.isError ?? false}, circuitBreaker=${tripped.circuitBreaker ?? false}, handler ran ${handlerAfterTrip}\u00d7`,
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
      actual: `isError=${afterReset.isError ?? false}, circuitBreaker=${afterReset.circuitBreaker ?? false}, handler ran ${handlerCalls}\u00d7`,
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
      detail: `handler ran ${handlerAfterTrip}\u00d7 across ${threshold} byte-identical calls; call #${threshold} short-circuited (circuitBreaker=${tripped.circuitBreaker ?? false})`,
    },
  ];

  return { checks, evidence };
}

// ---------------------------------------------------------------------------
// Contract: subagent-block -> skill max-depth recovery hint (PR #80)
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
// Contract: closure-anomaly -> actionable recovery hint on abort closures
// ---------------------------------------------------------------------------

/**
 * Assert the `closure-anomaly` guardrail maps an `abort` closure to an
 * actionable recovery hint, and does NOT fabricate guidance for a benign
 * close. Validates the same {@link buildClosureGuidance} the session's
 * `emitClosure` wires onto the `closure` trace event — a regression that
 * drops the hint (or starts emitting one on clean closes) is caught here.
 *
 * Covers `abort` (canonical check + recovery-action presence + canonical-constant
 * identity) and `truncated` (canonical-constant identity) — the two subtypes
 * most likely to silently regress. The contract validates the GUARDRAIL the
 * pattern maps to, not a fixture replay — matching the other contracts.
 */
async function runClosureAnomalyRecoveryHint(): Promise<ContractProbeResult> {
  const abortGuidance = buildClosureGuidance('abort');
  const truncatedGuidance = buildClosureGuidance('truncated');
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
      name: 'truncated-closure-has-canonical-guidance',
      description: 'A truncated closure maps to the exported CLOSURE_TRUNCATED_RECOVERY_HINT (no drift)',
      pass: truncatedGuidance === CLOSURE_TRUNCATED_RECOVERY_HINT,
      expected: 'buildClosureGuidance("truncated") === CLOSURE_TRUNCATED_RECOVERY_HINT',
      actual: truncatedGuidance === null ? 'null' : snapshot(truncatedGuidance),
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
      detail: 'buildClosureGuidance(reason) -> closure payload .guidance',
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
    title: 'Anomalous closure (abort, truncated) carries an actionable recovery hint',
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
