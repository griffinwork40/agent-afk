/**
 * Evidence-gate policy for durable memory writes.
 *
 * Prototype, opt-in behind `AFK_MEMORY_EVIDENCE_GATE=1`. Goal: stop uncited
 * agent claims about the codebase from silently becoming future ground truth.
 *
 * The existing fact `category` already encodes the classification the gate
 * needs, so no separate classifier is introduced:
 *
 *   - 'convention'             → codebase fact/convention  → EVIDENCE-GATED
 *   - 'preference'             → user preference/instruction → never gated
 *   - 'learning' | 'decision'  → agent reflection / rationale → never gated
 *
 * Only `convention` is treated as a checkable codebase claim. Preferences are
 * the user's own instructions (not the agent's claims) and reflections/
 * decisions are inherently conversational (a file:line citation would be
 * ceremony, not signal) — so neither is gated, and neither is ever stamped
 * 'verified' (that would lend a reflection false factual authority).
 *
 * Design: these helpers are PURE (no I/O, no env) except {@link evidenceGateEnabled},
 * which is the single env read-point. The store persists `evidence` as plain
 * data regardless of the flag; the memory-tool handlers consult the flag and
 * apply warn-on-write / tag-on-recall policy. This keeps classification
 * unit-testable in isolation from both the SQLite layer and the env.
 *
 * @module agent/memory/memory-evidence
 */

import { env } from '../../config/env.js';
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

/** True when `category` is a checkable codebase claim. */
export function isCodebaseFactCategory(category: FactCategory): boolean {
  return CODEBASE_FACT_CATEGORIES.has(category);
}

/**
 * Whether the evidence gate is enabled. Opt-in; any value other than the
 * literal '1' (including unset) leaves memory behavior identical to legacy.
 * The single env read-point for this subsystem.
 */
export function evidenceGateEnabled(): boolean {
  return env.AFK_MEMORY_EVIDENCE_GATE === '1';
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
