/**
 * Level-1 prediction: given a structural impact summary, produce up to
 * `maxPredictions` predicted behavior changes, each with `probesPerPrediction`
 * diverse synthetic probes.
 *
 * One model call. Output is validated against the Prediction schema; invalid
 * entries are dropped. Each prediction is tagged `observable: 'decision' |
 * 'downstream'` here, before any episode runs (#2409); a missing or invalid
 * tag defaults to `'decision'`. The model is instructed to return an empty list when
 * the change has no plausible behavioral effect (no filler). Near-duplicate
 * probes within a prediction are dropped after parse.
 *
 * @module whatif/predict
 */

import { z } from 'zod';
import { extractJsonAs } from './json-extract.js';
import type { CompleteFn, OperatorPrediction, Prediction, StructuralImpact } from './types.js';
import type { RepoManifest } from './repo-manifest.js';
import { formatRepoManifest } from './repo-manifest.js';
import { dedupeProbes } from './probe-dedupe.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Default number of synthetic probe episodes per prediction. */
export const DEFAULT_PROBES = 6;

/** Maximum number of synthetic probe episodes per prediction. */
export const MAX_PROBES = 12;

/** Legacy default for max predictions (≤2 probes, backward-compat). */
const LEGACY_MAX_PREDICTIONS = 8;

/** Default max predictions when probes > 2 (concentrate budget). */
const DEFAULT_MAX_PREDICTIONS = 3;

/**
 * Resolve the effective max-predictions cap.
 *
 * When probes > 2 and no explicit cap is provided, default to 3 so the
 * budget concentrates on fewer, better-powered predictions.  At ≤ 2 probes
 * the legacy cap of 8 is preserved for backward compatibility.
 */
export function resolveMaxPredictions(probes: number, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  return probes > 2 ? DEFAULT_MAX_PREDICTIONS : LEGACY_MAX_PREDICTIONS;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const PredictionSchema = z.object({
  id: z.string(),
  behavior: z.string(),
  direction: z.enum(['added', 'removed', 'strengthened', 'weakened']),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
  testQuestion: z.string(),
  probes: z.array(z.string()).min(1).max(MAX_PROBES),
  // Lenient (#2409): a missing or invalid tag never drops the prediction; it
  // is normalized to 'decision' by `withObservability`.
  observable: z.unknown().optional(),
  observabilityReason: z.unknown().optional(),
  // Lenient (#2504): out-of-range or non-numeric values are clamped/dropped in
  // withObservability so older outputs and hand-built fixtures still parse.
  baselineEstimate: z.unknown().optional(),
});

/**
 * Normalize the predict-time observability tag and baselineEstimate.
 * Anything but `'downstream'` becomes `'decision'` (backward compatible);
 * a reason is kept only for a downstream prediction and only when it is a
 * non-empty string. baselineEstimate is clamped to [0,1] and dropped when
 * out-of-range or non-numeric (#2504).
 */
function withObservability(
  entry: z.infer<typeof PredictionSchema>,
  id: string,
): Prediction {
  const { observable, observabilityReason, baselineEstimate, ...rest } = entry;

  // Normalize baselineEstimate: accept numbers in [0,1], drop everything else.
  let normalizedEstimate: number | undefined;
  if (typeof baselineEstimate === 'number' && isFinite(baselineEstimate)) {
    const clamped = Math.max(0, Math.min(1, baselineEstimate));
    normalizedEstimate = clamped;
  }

  const estimateField = normalizedEstimate !== undefined ? { baselineEstimate: normalizedEstimate } : {};

  if (observable !== 'downstream') {
    return { ...rest, id, observable: 'decision', ...estimateField };
  }
  const reason = typeof observabilityReason === 'string' ? observabilityReason.trim() : '';
  return {
    ...rest,
    id,
    observable: 'downstream',
    ...(reason ? { observabilityReason: reason } : {}),
    ...estimateField,
  };
}

const RawPredictionsArraySchema = z.array(z.unknown());

// ---------------------------------------------------------------------------
// System prompt helpers
// ---------------------------------------------------------------------------

/** Truncate a string to maxChars keeping head and tail when over limit. */
function headTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const half = Math.floor(maxChars / 2);
  return `${s.slice(0, half)}\n…[truncated]…\n${s.slice(s.length - half)}`;
}

/**
 * Build the system prompt parameterised by the number of probes and the
 * maximum number of predictions.
 */
function buildSystem(probesPerPrediction: number, maxPredictions: number): string {
  return `You are a behavioral prediction assistant for agent-afk's what-if engine.

Your job: given a description of a change to an AI agent's environment, predict
how the agent's behavior will change. Return a JSON array of Prediction objects.

## Rules

- Return at most ${maxPredictions} predictions.
- Return an empty array [] when the change has no plausible behavioral effect.
- Never pad with filler predictions to reach a count. An empty list is correct output.
- Each prediction must have a POSITIVELY framed testQuestion answerable from a
  single agent output. Phrase as "Does the response …?" — never "Is it too …?".
- probes: exactly ${probesPerPrediction} realistic user requests that would exercise the predicted behavior.
  Probes MUST be genuinely DIVERSE: different files, different tasks, different phrasings.
  Do NOT write rewordings or near-duplicates of the same request.
  CRITICAL — pick probes on which the CURRENT (baseline) agent leaves room to move:
    • For 'added' or 'strengthened' predictions: choose requests where the current
      agent usually does NOT show the behavior yet. The baseline P(yes) on these
      probes should be well below 1.0, so there is real room for the change to push
      it higher. If every baseline episode would show the behavior regardless of the
      change, the prediction cannot be confirmed.
    • For 'removed' or 'weakened' predictions: choose requests where the current
      agent currently DOES show the behavior. The baseline P(yes) should be well
      above 0.0, so there is real room for the change to push it lower.
  The goal is maximum sensitivity: if the baseline already saturates the scale, the
  run cannot detect movement even with perfect power.
- baselineEstimate: your honest estimate (0.0 to 1.0) of P(yes) on these probes
  for the CURRENT unmodified agent. This is used for a preflight headroom check.
  Required — omit only when you truly cannot estimate it.
- confidence must be honest: high only when the causal link is clear from the diff.
- Ids must be p1, p2, … pN (sequential, no gaps).
- observable: REQUIRED. Tag every prediction "decision" or "downstream" (see below).

## Observability (decide before any data exists)

Verification runs each probe as a single decision-only turn. Read-only tools
run normally. The FIRST side-effecting request (write/edit a file, mutating
shell command, spawning a subagent or skill, network write, git push) is
recorded as the agent's decision and NOT executed; the turn stops there. The
grader sees the request itself, e.g. "[tool requested: agent (not executed)]",
and counts it as the agent doing that thing.

- "decision": the behavior is visible in what the agent chooses, says,
  requests, or proposes in its turn, up to and including that first
  side-effecting request. Examples: asks a clarifying question before acting;
  spawns a subagent when asked to; edits the file directly instead of
  explaining; runs the tests before editing; refuses; answers without tools;
  response tone or length.
- "downstream": the behavior only shows once an intercepted action COMPLETES,
  or in its results. Examples: the tests pass after the fix; the written file
  content is correct; the subagent finds the bug; total task cost or turn
  count; how the agent behaves after verifying its change.

When unsure, prefer rephrasing the testQuestion to ask about the decision
(e.g. "Does the response request a subagent?" rather than "Does the subagent
find the bug?"). Tag "downstream" only when no decision-level question
captures the behavior. For "downstream", add observabilityReason: one short
line naming the action that would have to complete. Downstream predictions are
reported as unobservable and never count as confirmed or refuted.

## Output format

Respond with ONLY a JSON array (no prose, no fences):
[{"id":"p1","behavior":"…","direction":"added"|"removed"|"strengthened"|"weakened",
  "confidence":"high"|"medium"|"low","reason":"…","testQuestion":"Does the response …?",
  "probes":["…","…"],"observable":"decision"|"downstream",
  "observabilityReason":"… (downstream only)",
  "baselineEstimate":0.15}, …]`;
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface PredictInput {
  spec: { title: string; changes: unknown[] };
  changeDescriptions: string[];
  structural: StructuralImpact;
  trackRecord?: string;
  /** Optional repo manifest used to ground probes in real paths. */
  repoManifest?: RepoManifest;
  /** Number of probes per prediction (default: DEFAULT_PROBES). */
  probesPerPrediction?: number;
  /**
   * Whether the verify phase is requested. When true and an operator prediction
   * has no probes, predictChanges warns — the prediction produces zero episodes
   * and will show as 'unclear' in the verify report.
   */
  verify?: boolean;
  /** Maximum number of predictions to retain (resolved via resolveMaxPredictions). */
  maxPredictions?: number;
  /**
   * Optional redundancy-preflight section from {@link checkRedundancy} (#2414).
   * When present, injected into the analyst prompt so the model can return []
   * when the change merely restates an existing baseline instruction.
   */
  redundancySection?: string;
  /**
   * Operator-supplied predictions (#2861). When non-empty, these are used
   * instead of calling the analyst model. Each entry is normalized into a
   * full Prediction with sensible defaults for omitted fields.
   */
  operatorPredictions?: OperatorPrediction[];
}

// ---------------------------------------------------------------------------
// Operator prediction normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an operator-supplied prediction into a full {@link Prediction}.
 * Fills in defaults for omitted fields so the prediction participates in the
 * standard verify flow without requiring the operator to specify everything.
 */
export function normalizeOperatorPrediction(op: OperatorPrediction, id: string): Prediction {
  return {
    id,
    behavior: op.behavior,
    direction: op.direction ?? 'added',
    confidence: op.confidence ?? 'high',
    reason: 'Operator-supplied prediction',
    testQuestion: op.testQuestion,
    probes: op.probes ?? [],
    observable: 'decision',
  };
}

// ---------------------------------------------------------------------------
// Predictor
// ---------------------------------------------------------------------------

/**
 * Generate up to `maxPredictions` behavioral predictions for the proposed
 * change, each with `probesPerPrediction` diverse synthetic probes.
 *
 * Returns an empty array when the model determines the change has no
 * behavioral effect. Invalid prediction entries are silently dropped.
 * Near-duplicate probes within each prediction are removed before returning.
 */
export async function predictChanges(
  input: PredictInput,
  complete: CompleteFn,
  model: string,
): Promise<Prediction[]> {
  const { spec, changeDescriptions, structural, trackRecord, repoManifest, redundancySection, operatorPredictions } = input;

  // When operator predictions are supplied, normalize them and return immediately
  // (no analyst model call, so the run is fully deterministic).
  if (operatorPredictions && operatorPredictions.length > 0) {
    if (input.verify) {
      for (const op of operatorPredictions) {
        if (!op.probes || op.probes.length === 0) {
          process.stderr.write(
            `[whatif] warning: operator prediction "${op.behavior}" has no probes — ` +
              `it will produce zero episodes under --verify and score as 'unclear'.\n` +
              `Add a probes[] array to your prediction or omit --verify.\n`,
          );
        }
      }
    }
    return operatorPredictions.map((op, i) => normalizeOperatorPrediction(op, `p${i + 1}`));
  }

  const probesPerPrediction = input.probesPerPrediction ?? DEFAULT_PROBES;
  const maxPredictions = input.maxPredictions ?? resolveMaxPredictions(probesPerPrediction);

  // Build a concise summary of the structural diff.
  const systemDiffSnippet = headTail(structural.systemDiff || '(no system prompt diff)', 12000);

  const sections: string[] = [
    `## Change spec\nTitle: ${spec.title}\n${changeDescriptions.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}`,
    `## System prompt diff (truncated to ~12k chars)\n${systemDiffSnippet}`,
    `## Tools\nAdded: ${structural.toolsAdded.join(', ') || 'none'}\nRemoved: ${structural.toolsRemoved.join(', ') || 'none'}\nChanged: ${structural.toolsChanged.join(', ') || 'none'}`,
    `## User message diff\n${structural.userMessageDiff || '(no diff)'}`,
    `## Model changed: ${structural.modelChanged ? 'yes' : 'no'}`,
    `## Token delta: ${structural.tokens.candidate - structural.tokens.baseline > 0 ? '+' : ''}${structural.tokens.candidate - structural.tokens.baseline} tokens`,
  ];

  if (trackRecord) {
    sections.push(`## Engine track record (calibration)\n${headTail(trackRecord, 2000)}`);
  }

  // Redundancy preflight (#2414): inject before repo context so the model
  // sees the warning early and can return [] when the change restates an
  // existing rule.
  if (redundancySection) {
    sections.push(redundancySection);
  }

  if (repoManifest) {
    const repoSection = formatRepoManifest(repoManifest);
    if (repoSection) {
      sections.push(repoSection);
    }
  }

  const user = sections.join('\n\n');

  // Scale maxTokens with predictions × probes so large outputs fit.
  const maxTokens = Math.max(2048, maxPredictions * probesPerPrediction * 120);

  const system = buildSystem(probesPerPrediction, maxPredictions);
  const { text } = await complete({ system, user, maxTokens, model });

  let raw: unknown[];
  try {
    raw = extractJsonAs(text, RawPredictionsArraySchema);
  } catch {
    // Model returned malformed JSON — treat as no predictions.
    return [];
  }

  // Drop invalid entries, re-assign sequential ids, cap at maxPredictions.
  const valid: Prediction[] = [];
  for (const entry of raw) {
    if (valid.length >= maxPredictions) break;
    const parsed = PredictionSchema.safeParse(entry);
    if (!parsed.success) continue;

    // Dedupe and truncate probes to the requested count.
    const { kept } = dedupeProbes(parsed.data.probes);
    const effectiveProbes = kept.slice(0, probesPerPrediction);
    if (effectiveProbes.length === 0) continue; // no valid probes remain

    const prediction: z.infer<typeof PredictionSchema> = {
      ...parsed.data,
      probes: effectiveProbes,
    };

    valid.push(withObservability(prediction, `p${valid.length + 1}`));
  }

  return valid;
}
