/**
 * Evidence-gate policy for durable memory writes.
 *
 * On by default; set `AFK_MEMORY_EVIDENCE_GATE=0/false/no/off` to disable. Goal: stop uncited
 * agent claims about the codebase from silently becoming future ground truth.
 *
 * The existing fact `category` already encodes the classification the gate
 * needs, so no separate classifier is introduced:
 *
 *   - 'convention'  → codebase fact/convention        → EVIDENCE-GATED
 *   - 'learning'    → agent reflection / rationale    → AUTO-REFLECTED tagged
 *   - 'preference'  → user preference/instruction     → never gated
 *   - 'decision'    → rationale / choice              → never gated
 *
 * Only `convention` is treated as a checkable codebase claim (evidence-gated).
 * `learning` facts are agent-authored reflections; they receive an
 * `[auto-reflected]` prefix at recall so readers know the content was written
 * by automated end-of-session reflection, not by a human directly. Preferences
 * are the user's own instructions and decisions are inherently conversational
 * (a file:line citation would be ceremony, not signal) -- so neither is gated,
 * and neither is ever stamped 'verified' (that would lend a reflection false
 * factual authority).
 *
 * Design: these helpers are PURE (no I/O, no env) except {@link evidenceGateEnabled},
 * which is the single env read-point. The store persists `evidence` as plain
 * data regardless of the flag; the memory-tool handlers consult the flag and
 * apply warn-on-write / tag-on-recall policy. This keeps classification
 * unit-testable in isolation from both the SQLite layer and the env.
 *
 * @module agent/memory/memory-evidence
 */

import { env, isExplicitlyDisabled } from '../../config/env.js';
import type { FactCategory, FactVerification } from './types.js';

/**
 * Fact categories treated as checkable codebase claims subject to the gate.
 * A `ReadonlySet` (not a bare `=== 'convention'`) so the gated set can grow
 * (e.g. add `'decision'`) in exactly one place without touching call sites.
 */
export const CODEBASE_FACT_CATEGORIES: ReadonlySet<FactCategory> = new Set<FactCategory>([
  'convention',
]);

/** Marker prefixed to recalled content for an uncited codebase fact. */
export const UNVERIFIED_TAG = '[unverified]';

/**
 * Marker prefixed to recalled content for an agent-authored reflection
 * (`learning` category). Signals that the content was written by automated
 * end-of-session reflection, not by a human directly, so readers can weight
 * it accordingly. Idempotent and stripped from comparison when checking.
 */
export const AUTO_REFLECTED_TAG = '[auto-reflected]';

/**
 * Fact categories that carry the `[auto-reflected]` tag at recall time.
 * A ReadonlySet (not a bare === 'learning') so the tagged set can grow in
 * exactly one place without touching call sites.
 */
export const AUTO_REFLECTED_CATEGORIES: ReadonlySet<FactCategory> = new Set<FactCategory>([
  'learning',
]);

/** True when `category` is a checkable codebase claim. */
export function isCodebaseFactCategory(category: FactCategory): boolean {
  return CODEBASE_FACT_CATEGORIES.has(category);
}

/**
 * Whether the evidence gate is enabled. On by default; set AFK_MEMORY_EVIDENCE_GATE
 * to 0/false/no/off to disable. The single env read-point for this subsystem.
 */
export function evidenceGateEnabled(): boolean {
  const v = env.AFK_MEMORY_EVIDENCE_GATE;
  if (!v) return true; // on by default
  return !isExplicitlyDisabled(v);
}

/**
 * Whether a write of `category` is expected to carry evidence under the gate.
 * (A missing citation does NOT block the write — it downgrades the recall
 * verdict to 'unverified' and surfaces a warning. Never a hard reject.)
 */
export function requiresEvidence(category: FactCategory): boolean {
  return isCodebaseFactCategory(category);
}

/** Trim an evidence string; treat empty/whitespace/non-string as absent (null). */
export function normalizeEvidence(evidence: string | null | undefined): string | null {
  if (typeof evidence !== 'string') return null;
  const trimmed = evidence.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Recall-time provenance verdict for a fact.
 *   - non-codebase category        → 'not-applicable'
 *   - codebase category + citation → 'verified'
 *   - codebase category, no cite   → 'unverified'
 */
export function verificationStatus(
  category: FactCategory,
  evidence: string | null | undefined,
): FactVerification {
  if (!isCodebaseFactCategory(category)) return 'not-applicable';
  return normalizeEvidence(evidence) ? 'verified' : 'unverified';
}

/**
 * Prefix recalled content with {@link UNVERIFIED_TAG} for an uncited codebase
 * fact. Idempotent (never double-tags) and a no-op for any other verdict.
 */
export function applyUnverifiedTag(content: string, status: FactVerification): string {
  if (status !== 'unverified') return content;
  if (content.startsWith(UNVERIFIED_TAG)) return content;
  return `${UNVERIFIED_TAG} ${content}`;
}

/** True when `category` is an agent-authored reflection that gets tagged at recall. */
export function isAutoReflectedCategory(category: FactCategory): boolean {
  return AUTO_REFLECTED_CATEGORIES.has(category);
}

/**
 * Prefix recalled content with {@link AUTO_REFLECTED_TAG} for a `learning`
 * fact. Idempotent (never double-tags) and a no-op for any other category.
 */
export function applyAutoReflectedTag(content: string, category: FactCategory): string {
  if (!isAutoReflectedCategory(category)) return content;
  if (content.startsWith(AUTO_REFLECTED_TAG)) return content;
  return `${AUTO_REFLECTED_TAG} ${content}`;
}
