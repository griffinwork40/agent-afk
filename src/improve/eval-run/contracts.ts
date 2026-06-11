/**
 * Deterministic validation contracts for `afk improve eval-run`.
 *
 * Each contract is the **smallest deterministic check** that a guardrail
 * associated with one {@link FailurePattern} is present and behaving. A
 * contract runs entirely in-process: no LLM, no network, no patch/apply, and
 * no I/O side effects (the circuit-breaker probe builds a throwaway dispatcher
 * with no trace writer / hooks; the others read constants and pure helpers).
 *
 * ## Why guardrail-presence, not fixture replay
 *
 * An eval-case's own assertion is `pattern-absent`: replay the committed
 * fixture through the detector after the fix lands and expect zero findings.
 * That broader replay capability is reserved for a later sprint. This runner
 * validates the *fix* instead — the guardrail the pattern maps to:
 *
 *   - `repeated-tool-use`    → the repeat-loop circuit breaker (PR #80).
 *   - `subagent-block`       → the skill max-depth recovery hint (PR #80).
 *   - `tool-failure-density` → that detector being enabled by default (PR #80).
 *
 * Patterns with no registered contract (e.g. `closure-anomaly`) resolve to
 * `undefined`; the runner records an `unsupported` result rather than failing.
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
  defaultEnabledDetectorNames,
  disabledByDefaultDetectorNames,
} from '../scan/detectors/index.js';
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
// Contract: tool-failure-density → enabled by default (PR #80)
// ---------------------------------------------------------------------------

const TFD_DETECTOR = 'tool-failure-density';

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
    title: 'tool-failure-density detector is enabled by default',
    run: runToolFailureDensityEnabled,
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
