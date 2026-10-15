/**
 * Level-0 structural impact computation for the what-if prediction engine.
 *
 * Compares two {@link RequestSnapshot}s produced by the agent runner's
 * `snapshot()` method and returns a {@link StructuralImpact} describing:
 * - System-prompt line diff (unified text, '' when identical)
 * - Tool additions, removals, and description changes
 * - User-message diff
 * - Estimated token counts and per-turn cost delta
 * - Whether the model changed
 *
 * No I/O. No model calls.
 *
 * @module whatif/structural
 */

import { computeLineDiff } from '../utils/diff.js';
import { deriveCallCostUsd } from '../agent/providers/anthropic-direct/pricing.js';
import type { DiffPayload } from '../utils/diff.js';
import type { RequestSnapshot, StructuralImpact } from './types.js';

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

/**
 * Render a {@link DiffPayload} as a compact unified-style text with +/- lines.
 * Returns '' when the payload is null (no changes).
 */
function renderDiff(payload: DiffPayload | null): string {
  if (!payload || payload.hunks.length === 0) return '';

  const lines: string[] = [];

  for (const hunk of payload.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const dl of hunk.lines) {
      lines.push(`${dl.kind}${dl.text}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Characters-per-token ratio (same heuristic as complete.ts). */
const CHARS_PER_TOKEN = 3.5;

/**
 * Estimate token count for a snapshot's system prompt and tools.
 * Counts chars in system text + all tool names and descriptions, then
 * divides by CHARS_PER_TOKEN.
 */
function estimateTokens(snap: RequestSnapshot): number {
  let chars = snap.system.length;
  for (const t of snap.tools) {
    chars += t.name.length + t.description.length;
  }
  return Math.round(chars / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Tool comparison
// ---------------------------------------------------------------------------

function toolsAdded(
  baseline: RequestSnapshot['tools'],
  candidate: RequestSnapshot['tools'],
): string[] {
  const baseNames = new Set(baseline.map((t) => t.name));
  return candidate.filter((t) => !baseNames.has(t.name)).map((t) => t.name);
}

function toolsRemoved(
  baseline: RequestSnapshot['tools'],
  candidate: RequestSnapshot['tools'],
): string[] {
  const candNames = new Set(candidate.map((t) => t.name));
  return baseline.filter((t) => !candNames.has(t.name)).map((t) => t.name);
}

function toolsChanged(
  baseline: RequestSnapshot['tools'],
  candidate: RequestSnapshot['tools'],
): string[] {
  const baseMap = new Map(baseline.map((t) => [t.name, t.description]));
  const changed: string[] = [];
  for (const t of candidate) {
    const baseDesc = baseMap.get(t.name);
    if (baseDesc !== undefined && baseDesc !== t.description) {
      changed.push(t.name);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Per-turn cost delta
// ---------------------------------------------------------------------------

/**
 * Compute per-turn input cost delta in USD for the candidate model.
 *
 * We compare only input token costs since output costs depend on the actual
 * response and are symmetric between environments for a fair comparison.
 * Returns `undefined` when the model is unpriced.
 */
function perTurnCostDelta(
  model: string,
  baselineTokens: number,
  candidateTokens: number,
): number | undefined {
  const baseCost = deriveCallCostUsd(model, baselineTokens, 0, 0, 0);
  const candCost = deriveCallCostUsd(model, candidateTokens, 0, 0, 0);
  if (baseCost === undefined || candCost === undefined) return undefined;
  return candCost - baseCost;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute the structural impact between a baseline and candidate snapshot.
 *
 * System and user-message diffs are rendered as compact unified text with
 * `+` and `-` prefixed lines. Empty string means identical.
 * Tool deltas compare by name (added/removed) and description (changed).
 * Tokens are estimated at 3.5 chars/token over system text + tool name+desc.
 * Per-turn cost delta uses the CANDIDATE model's pricing table.
 */
export function computeStructuralImpact(
  baseline: RequestSnapshot,
  candidate: RequestSnapshot,
): StructuralImpact {
  const systemDiff = renderDiff(
    computeLineDiff(baseline.system, candidate.system),
  );

  const userMessageDiff = renderDiff(
    computeLineDiff(baseline.firstUserMessage, candidate.firstUserMessage),
  );

  const added = toolsAdded(baseline.tools, candidate.tools);
  const removed = toolsRemoved(baseline.tools, candidate.tools);
  const changed = toolsChanged(baseline.tools, candidate.tools);

  const baselineTokens = estimateTokens(baseline);
  const candidateTokens = estimateTokens(candidate);

  const costDelta = perTurnCostDelta(
    candidate.model,
    baselineTokens,
    candidateTokens,
  );

  return {
    baseline,
    candidate,
    systemDiff,
    toolsAdded: added,
    toolsRemoved: removed,
    toolsChanged: changed,
    userMessageDiff,
    tokens: { baseline: baselineTokens, candidate: candidateTokens },
    perTurnCostDeltaUsd: costDelta,
    modelChanged: baseline.model !== candidate.model,
  };
}
