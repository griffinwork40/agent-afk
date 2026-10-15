/**
 * Tool-failure-density validation contract for `afk improve eval-run`.
 *
 * Implements the enabled-by-default presence check and the
 * synthetic-corpus classification probe for the `tool-failure-density`
 * detector pattern. Extracted from `contracts.ts` to keep each file under
 * the 350 code-line ceiling.
 *
 * @module improve/eval-run/contracts.tfd
 */

import {
  defaultEnabledDetectorNames,
  disabledByDefaultDetectorNames,
} from '../scan/detectors/index.js';
import { detectToolFailureDensity } from '../scan/detectors/tool-failure-density.js';
import { parseTraceContent, type SessionRead } from '../scan/reader.js';
import type { ToolFailureClass } from '../../agent/trace/types.js';
import type { EvalCheck, EvalRunEvidenceRef } from '../schemas.js';
import { makeCheck, type ContractProbeResult } from './contracts.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TFD_DETECTOR = 'tool-failure-density';

// Synthetic-corpus tool names + their derived card slugs (see makeSlug in the
// detector). The test asserts against these exact slugs, so they live here as
// the single source of truth.
const TFD_FLAKY_TOOL = 'flaky_tool';
const TFD_REFUSAL_ONLY_TOOL = 'refusal_only_tool';
const TFD_FLAKY_TOOL_SLUG = 'tool-failure-flaky-tool';
const TFD_REFUSAL_ONLY_TOOL_SLUG = 'tool-failure-refusal-only-tool';

// ---------------------------------------------------------------------------
// Synthetic corpus helpers
// ---------------------------------------------------------------------------

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
 *   `flaky_tool` -> ONE card. Counted: sess-a {success, timeout-fail,
 *     unclassified-fail} + sess-b {unclassified-fail, success} = 5 calls,
 *     3 failures, rate 0.6. Excluded from BOTH numerator and denominator:
 *     policy-refusal / permission-denied / abort / hook-block /
 *     elicitation-declined (1 each) -> excludedByClass; plus one circuitBreaker
 *     block (skipped BEFORE the class check, so it never appears in
 *     excludedByClass and never inflates totalCalls or the unclassified count).
 *     failureClassBreakdown = {timeout:1, unclassified:2}; affected sessions
 *     {sess-a, sess-b}; failure seqs [1, 2, 0] (sess-a first, then sess-b).
 *
 *   `refusal_only_tool` -> NO card. All 5 isError results are excluded classes,
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

// ---------------------------------------------------------------------------
// Classification-probe helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TFD enabled-by-default check
// ---------------------------------------------------------------------------

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
// TFD classification probe
// ---------------------------------------------------------------------------

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
      expected: 'minFailures=4 \u2192 no card (count gate); minFailureRate=0.7 \u2192 no card (rate gate)',
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
          ? `synthetic corpus \u2192 ${cards.length} card(s); '${TFD_FLAKY_TOOL_SLUG}' absent`
          : `synthetic corpus \u2192 flaky_tool ${failureCount}/${totalCalls} (rate ${failureRate}); breakdown ${JSON.stringify(breakdown)}`,
    },
    {
      kind: 'observed-behavior',
      ref: 'detectToolFailureDensity (EXCLUDED_FAILURE_CLASSES + circuitBreaker exclusion)',
      detail: `excludedByClass=${JSON.stringify(excluded)}; refusal_only_tool card ${refusalOnly === undefined ? 'absent' : 'PRESENT'}`,
    },
  ];

  return { checks, evidence };
}

// ---------------------------------------------------------------------------
// Exported TFD contract runner
// ---------------------------------------------------------------------------

/**
 * The registered `tool-failure-density` contract: the enabled-by-default
 * presence check (proves the detector runs in a default scan) followed by the
 * synthetic-corpus classification probe (proves the detector classifies a known
 * failure mix correctly). Kept under the stable contract id
 * `tool-failure-density-enabled` so existing eval-run artifacts keep resolving.
 */
export async function runToolFailureDensityContract(): Promise<ContractProbeResult> {
  const presence = await runToolFailureDensityEnabled();
  const classification = runToolFailureDensityClassification();
  return {
    checks: [...presence.checks, ...classification.checks],
    evidence: [...presence.evidence, ...classification.evidence],
  };
}
