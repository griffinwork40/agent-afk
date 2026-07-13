/**
 * Fixture-replay validation for `afk improve eval-run`.
 *
 * Where the guardrail-presence contracts in {@link ./contracts} prove a
 * guardrail EXISTS and behaves against a synthetic stimulus, a fixture-replay
 * handler proves the guardrail NEUTRALISES *this card's recorded failure* —
 * the actual tool and loop magnitude captured in the committed fixture.
 *
 * ## Why not "re-scan the fixture and expect zero findings"
 *
 * Invariant: a detector is a PURE function of the trace bytes, and the
 * committed fixture is an IMMUTABLE byte-identical recording. Fixing the code
 * does not rewrite an old trace, so re-scanning the static fixture through the
 * same detector ALWAYS reproduces the original finding — it can never flip to
 * "absent". A naive rescan therefore cannot distinguish fixed from unfixed,
 * which is exactly why the eval-case's literal `pattern-absent`-by-rescan
 * assertion is not what this handler evaluates.
 *
 * ## What a fixture-replay handler does instead
 *
 * It re-drives the fixture's recorded failure CONDITIONS through the LIVE
 * guardrailed code path and asserts the failure would not recur at the
 * magnitude the fixture recorded:
 *
 *   1. Parse the committed fixture and run the detector over it to confirm the
 *      fixture genuinely encodes the pattern (fail-closed: a fixture that no
 *      longer reproduces cannot green-light a fix). This also extracts the
 *      recorded `(toolName, runLength)`.
 *   2. Re-drive that recorded loop through the production guardrail symbol and
 *      assert it neutralises the loop before it reaches the recorded length.
 *
 * "Still reproduces" → the guardrail does not cut the loop short → `fail`.
 * "Fixed"            → the guardrail cuts the loop short            → `pass`.
 *
 * ## Boundary (no overclaiming)
 *
 * This re-drives the recorded loop SHAPE (tool name + consecutive-identical
 * count), not the original tool/LLM execution. It proves the live guardrail
 * covers the recorded failure; it does not prove the loop can never arise for
 * an unrelated reason. The fixture bytes are checksum-pinned by the eval-case
 * (the runner re-verifies the sha256 before any replay runs), so the stimulus
 * is stable across runs.
 *
 * @module improve/eval-run/replay
 */

import {
  REPEAT_CIRCUIT_BREAKER_THRESHOLD,
  SessionToolDispatcher,
} from '../../agent/tools/dispatcher.js';
import type { ToolCall, ToolHandler, ToolResult } from '../../agent/tools/types.js';
import { buildClosureGuidance } from '../../agent/session/closure-guidance.js';
import type { ClosureReason } from '../../agent/trace/index.js';
import {
  DEFAULT_MIN_REPEATS,
  detectRepeatedToolUse,
} from '../scan/detectors/repeated-tool-use.js';
import { detectClosureAnomaly } from '../scan/detectors/closure-anomaly.js';
import { parseTraceContent } from '../scan/reader.js';
import type { DetectorResult, EvalCase, EvalCheck, EvalRunEvidenceRef, FailurePattern } from '../schemas.js';
import { makeCheck, snapshot, type ContractProbeResult } from './contracts.js';

// ---------------------------------------------------------------------------
// Stable check names — exported so the runner can detect that a replay ran
// (it adjusts its markdown disclaimer) without a schema field.
// ---------------------------------------------------------------------------

/** Prefix marking a check as produced by a fixture-replay handler. */
export const REPLAY_CHECK_PREFIX = 'replay:';
/** Check #1 — the committed fixture still encodes the recorded pattern. */
export const REPLAY_CHECK_REPRODUCES = `${REPLAY_CHECK_PREFIX}fixture-reproduces-pattern`;
/** Check #2 — the live guardrail neutralises the recorded loop. */
export const REPLAY_CHECK_NEUTRALIZED = `${REPLAY_CHECK_PREFIX}guardrail-neutralizes-recorded-loop`;

// closure-anomaly replay check names. Distinct from the repeat-loop ones so a
// run that mixes patterns (it never does today, but the registry allows it)
// keeps unambiguous check names; the GUIDED check is the closure-anomaly
// counterpart of REPLAY_CHECK_NEUTRALIZED — see {@link isReplayNeutralizeCheck}.
/** Closure check #1 — the committed fixture still encodes an anomalous closure. */
export const REPLAY_CHECK_CLOSURE_REPRODUCES = `${REPLAY_CHECK_PREFIX}fixture-reproduces-closure-anomaly`;
/** Closure check #2 — the live guardrail attaches recovery guidance to the recorded closure. */
export const REPLAY_CHECK_CLOSURE_GUIDED = `${REPLAY_CHECK_PREFIX}guardrail-guides-recorded-closure`;

/** Shared description for the reproduce check — emitted on both the matched
 *  (`pass`) and the non-reproducing (`skipped`) path, so it lives once here. */
const REPRODUCES_DESCRIPTION =
  'The committed fixture still reproduces the recorded repeated-tool-use loop when re-scanned by the detector';

// ---------------------------------------------------------------------------
// Loop driver — the injectable seam
// ---------------------------------------------------------------------------

/** Outcome of driving a recorded loop through a guardrailed executor. */
export interface LoopDriveResult {
  /**
   * 1-based position at which the circuit breaker tripped, or `null` if it
   * never tripped within the calls driven.
   */
  trippedAtCall: number | null;
  /** How many calls were actually driven (bounded by the caller). */
  callsDriven: number;
}

/**
 * Drives `count` byte-identical calls to `toolName` and reports whether the
 * live repeat-loop circuit breaker tripped. Injectable so tests can simulate
 * the pre-fix world (a driver that never trips) and assert the gate flips.
 */
export type LoopDriver = (toolName: string, count: number) => Promise<LoopDriveResult>;

/** Constant input object — byte-identical across calls so the breaker's
 *  `(name, JSON(input))` fingerprint collides and the consecutive count grows. */
const REPLAY_PROBE_INPUT = Object.freeze({ replay: 'byte-identical-input' });

/**
 * Default driver: drive the recorded loop through the REAL
 * {@link SessionToolDispatcher}. Builds a throwaway dispatcher (no hooks, no
 * trace writer, permission scoped to the single probe tool) so the only
 * production behaviour exercised is the repeat-loop circuit breaker. Mirrors
 * the isolation the guardrail-presence contract uses.
 */
export const liveCircuitBreakerDriver: LoopDriver = async (toolName, count) => {
  const handler: ToolHandler = async () => ({ content: 'replay-probe-ok' });
  const dispatcher = new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([[toolName, handler]]),
    schemas: [],
    hookRegistry: undefined,
    permissions: { allowedTools: [toolName] },
  });
  const signal = new AbortController().signal;

  let trippedAtCall: number | null = null;
  let callsDriven = 0;
  for (let i = 1; i <= count; i++) {
    const call: ToolCall = { id: `replay-${i}`, name: toolName, input: REPLAY_PROBE_INPUT, signal };
    const result: ToolResult = await dispatcher.execute(call);
    callsDriven = i;
    if (result.circuitBreaker === true) {
      trippedAtCall = i;
      break;
    }
  }
  return { trippedAtCall, callsDriven };
};

// ---------------------------------------------------------------------------
// Replay handlers
// ---------------------------------------------------------------------------

/** Optional injection seams for a replay handler. */
export interface ReplayContext {
  /** Override the loop driver. Defaults to {@link liveCircuitBreakerDriver}. */
  driveLoop?: LoopDriver;
  /**
   * Override the closure-guidance builder. Defaults to the production
   * {@link buildClosureGuidance}. Tests inject a null-returning builder to
   * simulate the pre-fix world (the abort recovery hint dropped) and assert the
   * closure-anomaly gate flips to `fail`.
   */
  buildGuidance?: (reason: ClosureReason) => string | null;
}

export interface ReplayHandler {
  /** The pattern whose recorded failure this handler replays. */
  patternId: FailurePattern;
  /** Replay the fixture and return checks + evidence (never throws for a
   *  non-reproducing fixture — it returns a failing check instead). */
  run: (evalCase: EvalCase, fixtureBytes: Buffer, ctx: ReplayContext) => Promise<ContractProbeResult>;
}

function runLengthOf(result: DetectorResult): number {
  const n = result.detail['runLength'];
  return typeof n === 'number' ? n : 0;
}

/**
 * Fixture-replay for `repeated-tool-use`.
 *
 * Re-drives the recorded loop through the live repeat-loop circuit breaker and
 * asserts the breaker trips at or before the recorded run length. A run length
 * below {@link REPEAT_CIRCUIT_BREAKER_THRESHOLD} correctly reports "not
 * neutralised" — the breaker genuinely does not cover loops shorter than its
 * threshold, and a gate must fail closed rather than imply coverage it lacks.
 */
async function replayRepeatedToolUse(
  evalCase: EvalCase,
  fixtureBytes: Buffer,
  ctx: ReplayContext,
): Promise<ContractProbeResult> {
  const checks: EvalCheck[] = [];
  const evidence: EvalRunEvidenceRef[] = [];

  // 1. Re-scan the committed fixture and confirm it still encodes the pattern.
  const content = fixtureBytes.toString('utf8');
  const session = parseTraceContent({
    sessionId: evalCase.replay.sourceSessionId,
    tracePath: evalCase.replay.sourceTracePath,
    relativeTracePath: evalCase.replay.sourceTracePath,
    content,
    sessionMtimeMs: 0,
  });
  const findings = detectRepeatedToolUse([session], { minRepeats: DEFAULT_MIN_REPEATS });

  // Prefer the run whose fingerprint matches the eval-case provenance; fall
  // back to the longest run when no fingerprint was recorded.
  const wantFp = evalCase.provenance.fingerprintAtGeneration;
  const byFingerprint = wantFp
    ? findings.find((f) => f.detail['fingerprint'] === wantFp)
    : undefined;
  const longest = [...findings].sort((a, b) => runLengthOf(b) - runLengthOf(a))[0];
  const matched = byFingerprint ?? longest;

  if (matched === undefined) {
    // The fixture's sha256 already re-verified upstream, so the bytes are
    // intact — they simply do not encode the pattern. That is an eval-case
    // quality problem, not a code regression: emit a `skipped` check (which
    // does NOT force the run to `fail`) so the run's verdict is still governed
    // by the guardrail-presence contract, and surface the gap loudly. `fail`
    // stays reserved for the real "still reproduces" signal below.
    checks.push(
      makeCheck({
        name: REPLAY_CHECK_REPRODUCES,
        description: REPRODUCES_DESCRIPTION,
        pass: false,
        status: 'skipped',
        expected: wantFp
          ? `detector finds a run with fingerprint ${wantFp.slice(0, 12)}…`
          : 'detector finds ≥1 repeated-tool-use run in the fixture',
        actual: `detector found ${findings.length} run(s); none matched — replay skipped (eval-case may be stale or misgenerated)`,
      }),
    );
    evidence.push({
      kind: 'fixture',
      ref: evalCase.replay.fixturePath,
      detail:
        'fixture did not reproduce the repeated-tool-use pattern; replay skipped (no loop to re-drive)',
    });
    return { checks, evidence };
  }

  checks.push(
    makeCheck({
      name: REPLAY_CHECK_REPRODUCES,
      description: REPRODUCES_DESCRIPTION,
      pass: true,
      expected: wantFp
        ? `detector finds a run with fingerprint ${wantFp.slice(0, 12)}…`
        : 'detector finds ≥1 repeated-tool-use run in the fixture',
      actual: `found '${String(matched.detail['toolName'])}' ×${runLengthOf(matched)}`,
    }),
  );

  const toolName = String(matched.detail['toolName']);
  const recordedRunLength = runLengthOf(matched);

  // 2. Re-drive the recorded loop through the live guardrail. Bounded to the
  //    breaker threshold: we only need to observe whether it trips at or
  //    before the recorded length, and the breaker trips deterministically at
  //    call #threshold.
  const driveLoop = ctx.driveLoop ?? liveCircuitBreakerDriver;
  const driveCount = Math.min(recordedRunLength, REPEAT_CIRCUIT_BREAKER_THRESHOLD);
  const drive = await driveLoop(toolName, driveCount);

  const neutralized = drive.trippedAtCall !== null && drive.trippedAtCall <= recordedRunLength;
  checks.push(
    makeCheck({
      name: REPLAY_CHECK_NEUTRALIZED,
      description:
        'Re-driving the recorded loop through the live guardrail trips the circuit breaker at or before the recorded length',
      pass: neutralized,
      expected: `circuit breaker trips at call ≤ ${recordedRunLength} (recorded run length)`,
      actual:
        drive.trippedAtCall === null
          ? `no trip within ${drive.callsDriven} call(s) — recorded loop of ${recordedRunLength} would still complete`
          : `tripped at call ${drive.trippedAtCall}`,
    }),
  );

  evidence.push(
    {
      kind: 'observed-behavior',
      ref: 'SessionToolDispatcher.execute (repeat-loop circuit breaker)',
      detail: `'${toolName}' recorded ×${recordedRunLength}; live breaker ${
        drive.trippedAtCall === null ? 'did NOT trip' : `tripped at call ${drive.trippedAtCall}`
      } (threshold ${REPEAT_CIRCUIT_BREAKER_THRESHOLD})`,
    },
    {
      kind: 'fixture',
      ref: evalCase.replay.fixturePath,
      detail: `replayed recorded loop on '${toolName}' (run length ${recordedRunLength})`,
    },
  );

  return { checks, evidence };
}

/** Read the recorded closure reason from a closure-anomaly finding's detail. */
function closureReasonOf(result: DetectorResult): string | null {
  const r = result.detail['closureReason'];
  return typeof r === 'string' ? r : null;
}

/** Read the recorded `seq` list from a finding's detail (provenance selector). */
function seqsOf(result: DetectorResult): number[] {
  const s = result.detail['seqs'];
  return Array.isArray(s) ? s.filter((n): n is number => typeof n === 'number') : [];
}

/** Shared description for the closure reproduce check — emitted on both the
 *  matched (`pass`) and the non-reproducing (`skipped`) path. */
const CLOSURE_REPRODUCES_DESCRIPTION =
  'The committed fixture still reproduces the recorded anomalous closure when re-scanned by the detector';

/**
 * Fixture-replay for `closure-anomaly`.
 *
 * Re-drives the fixture's recorded closure reason through the live
 * {@link buildClosureGuidance} guardrail and asserts the recorded anomalous
 * closure now carries actionable recovery guidance.
 *
 * ## Neutralisation here is advisory, not preventive
 *
 * Unlike the repeat-loop circuit breaker (which actually cuts a loop short),
 * the closure recovery hint does NOT prevent the closure — an abort still
 * aborts. "Neutralised" means the recorded anomalous closure no longer surfaces
 * WITHOUT a recovery path: the live guardrail now attaches a concrete next step
 * (`afk --resume <id>` / re-run) for the recorded reason. This is the closure
 * analog of the repeat-loop handler's "re-drives the loop shape, not the
 * original tool/LLM" boundary — it proves the fix (PR-added guidance) covers
 * THIS card's recorded reason, not that the abort can never occur.
 *
 * ## Fail-closed on uncovered reasons
 *
 * The guardrail covers `abort` today (`closure-guidance.ts`); other anomalous
 * reasons (`timeout`, `budget_exceeded`, …) return `null` until their hints
 * land. A `null` result reports "not neutralised" → `fail`, mirroring how the
 * repeat-loop handler fails a sub-threshold loop: a gate must fail closed
 * rather than imply coverage it lacks. In practice `abort` is the only
 * anomalous reason emitted today, so a `null` for an `abort` fixture signals a
 * genuine regression (the hint was dropped).
 */
async function replayClosureAnomaly(
  evalCase: EvalCase,
  fixtureBytes: Buffer,
  ctx: ReplayContext,
): Promise<ContractProbeResult> {
  const checks: EvalCheck[] = [];
  const evidence: EvalRunEvidenceRef[] = [];

  // 1. Re-scan the committed fixture and confirm it still encodes the pattern.
  const content = fixtureBytes.toString('utf8');
  const session = parseTraceContent({
    sessionId: evalCase.replay.sourceSessionId,
    tracePath: evalCase.replay.sourceTracePath,
    relativeTracePath: evalCase.replay.sourceTracePath,
    content,
    sessionMtimeMs: 0,
  });
  const findings = detectClosureAnomaly([session], { minOccurrences: 1 });

  // closure-anomaly has no fingerprint (provenance.fingerprintAtGeneration is
  // null by design), so select the finding whose recorded seqs include the
  // eval-case's evidence seq; fall back to the sole finding.
  const wantSeq = Math.max(...evalCase.replay.evidenceEventIndices);
  const bySeq = findings.find((f) => seqsOf(f).includes(wantSeq));
  const matched = bySeq ?? findings[0];

  if (matched === undefined) {
    // The fixture's sha256 already re-verified upstream, so the bytes are
    // intact — they simply do not encode an anomalous closure. That is an
    // eval-case quality problem, not a code regression: emit a `skipped` check
    // (which does NOT force `fail`) and surface the gap. No guided check is
    // emitted, so the runner demotes the run to `unsupported` (never `pass`).
    checks.push(
      makeCheck({
        name: REPLAY_CHECK_CLOSURE_REPRODUCES,
        description: CLOSURE_REPRODUCES_DESCRIPTION,
        pass: false,
        status: 'skipped',
        expected: 'detector finds ≥1 anomalous closure in the fixture',
        actual: `detector found ${findings.length} closure-anomaly finding(s); none matched — replay skipped (eval-case may be stale or misgenerated)`,
      }),
    );
    evidence.push({
      kind: 'fixture',
      ref: evalCase.replay.fixturePath,
      detail: 'fixture did not reproduce an anomalous closure; replay skipped (no closure to re-drive)',
    });
    return { checks, evidence };
  }

  const reason = closureReasonOf(matched) ?? '';
  checks.push(
    makeCheck({
      name: REPLAY_CHECK_CLOSURE_REPRODUCES,
      description: CLOSURE_REPRODUCES_DESCRIPTION,
      pass: true,
      expected: 'detector finds ≥1 anomalous closure in the fixture',
      actual: `found closure.reason='${reason}' (seq ${wantSeq})`,
    }),
  );

  // 2. Re-drive the recorded closure reason through the live guardrail. The
  //    hint is advisory (see the handler docstring); a covered reason yields a
  //    non-empty recovery hint → neutralised, an uncovered reason yields null →
  //    fail-closed.
  const build = ctx.buildGuidance ?? buildClosureGuidance;
  const guidance = build(reason as ClosureReason);
  const neutralized = guidance !== null && guidance.trim().length > 0;
  checks.push(
    makeCheck({
      name: REPLAY_CHECK_CLOSURE_GUIDED,
      description:
        'Re-driving the recorded closure reason through the live guardrail yields actionable recovery guidance',
      pass: neutralized,
      expected: `buildClosureGuidance('${reason}') returns a non-empty recovery hint`,
      actual: neutralized
        ? snapshot(guidance as string)
        : `no guidance for reason '${reason}' — the recorded closure anomaly would still surface with no recovery path`,
    }),
  );

  evidence.push(
    {
      kind: 'observed-behavior',
      ref: 'buildClosureGuidance (closure-anomaly recovery hint)',
      detail: `closure.reason='${reason}'; live guardrail ${
        neutralized ? 'returned a recovery hint' : 'returned no guidance'
      }`,
    },
    {
      kind: 'fixture',
      ref: evalCase.replay.fixturePath,
      detail: `replayed recorded closure reason '${reason}'`,
    },
  );

  return { checks, evidence };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REPLAY_HANDLERS: readonly ReplayHandler[] = Object.freeze([
  { patternId: 'repeated-tool-use', run: replayRepeatedToolUse },
  { patternId: 'closure-anomaly', run: replayClosureAnomaly },
] satisfies ReplayHandler[]);

/**
 * Check names that signal a replay reached a conclusive neutralise verdict
 * (`pass`/`fail`), as opposed to the reproduce gate. The runner uses this to
 * distinguish "a replay actually drove the guardrail" from "a replay handler
 * ran but the fixture did not reproduce" — the latter demotes the run to
 * `unsupported` (a skipped replay must never read as `pass`). Each handler that
 * conclusively drives its guardrail emits exactly one of these.
 */
const REPLAY_NEUTRALIZE_CHECK_NAMES: readonly string[] = [
  REPLAY_CHECK_NEUTRALIZED,
  REPLAY_CHECK_CLOSURE_GUIDED,
];

/** True when `name` is a conclusive neutralise check from any replay handler. */
export function isReplayNeutralizeCheck(name: string): boolean {
  return REPLAY_NEUTRALIZE_CHECK_NAMES.includes(name);
}

/** Resolve the fixture-replay handler for a pattern, or `undefined` if none. */
export function resolveReplayHandler(patternId: FailurePattern): ReplayHandler | undefined {
  return REPLAY_HANDLERS.find((h) => h.patternId === patternId);
}

/** Patterns that currently have a fixture-replay handler. */
export function replaySupportedPatterns(): readonly FailurePattern[] {
  return REPLAY_HANDLERS.map((h) => h.patternId);
}
