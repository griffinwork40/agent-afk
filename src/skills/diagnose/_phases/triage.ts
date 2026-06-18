/**
 * Phase 1 triage helpers for the /diagnose skill.
 *
 * Pure heuristics — no LLM calls. Classifies the failure type, extracts an
 * error signature, and identifies affected areas from the raw failure string.
 * Also contains the multi-file span heuristic and the outcome routing table.
 *
 * @module skills/diagnose/_phases/triage
 */

import type { Hypothesis, VerificationResult, DiagnosisOutcome, Triage, FailureType } from './types.js';

/**
 * Heuristic Phase 1 triage. Classifies the failure type and extracts an
 * `error_signature` (first non-empty line of the failure, capped at 200 chars)
 * and `affected_area` (first plausible file path or module mentioned in
 * failure + context).
 *
 * Pure heuristics — no LLM call. Conservative: when in doubt, return
 * `failure_type: 'unknown'` and `affected_area: 'unknown'` rather than a
 * speculative classification. Downstream agents still receive the full
 * original failure string; this is anchor-point extraction, not summarization.
 */
export function classifyAndExtract(failure: string, context: string): Triage {
  const combined = `${failure}\n${context}`;

  // Failure-type classification: ordered priority — flaky beats regression
  // beats crash, because flaky/regression mention causal history that
  // outranks the raw symptom signature.
  let failure_type: FailureType = 'unknown';
  const lc = combined.toLowerCase();
  if (/flaky|non-?deterministic|intermittent|sometimes fails|race/.test(lc)) {
    failure_type = 'flaky';
  } else if (/regression|used to work|worked before|broke in|ci.*green.*red|was passing/.test(lc)) {
    failure_type = 'regression';
  } else if (
    /\b(uncaught|unhandled)\b|panic|segfault|exit(ed)? (with )?(code )?[1-9]|sigsegv|stack overflow|fatal|traceback|core dumped|abort(ed)?|\b(type|reference|range|syntax|internal|eval|uri)error\b/.test(
      lc,
    )
  ) {
    failure_type = 'crash';
  } else if (
    /platform|node version|python version|dependency|version mismatch|works on .* not |env(ironment)?|config drift/.test(lc)
  ) {
    failure_type = 'environment';
  } else if (/expected .* but|got .* expected|wrong|incorrect|unexpected/.test(lc)) {
    failure_type = 'logic-error';
  }

  // error_signature: first non-empty trimmed line, capped at 200 chars.
  //
  // Prose-question guard: when the first line is a natural-language question
  // (e.g. "why is X doing Y rather than Z") AND no concrete error/exception
  // tokens appear anywhere in the failure text, the question itself is NOT a
  // useful anchor — using it leaks the first salient domain noun (e.g. "X")
  // into both research lanes' triage blocks, where the LLM latches onto it
  // ahead of the actual subject of the question. Replace with a sentinel
  // ('prose-question') that downstream consumers can recognize. The full
  // failure text still reaches the agents via `Failure: ...` in the research
  // prompt — only the *anchor* is suppressed.
  //
  // When error tokens DO appear (e.g. "Why does this throw
  // NullPointerException?"), the first line stays as the anchor because the
  // question wraps a real signal and downstream agents benefit from it.
  const PROSE_QUESTION_RE =
    /^(why|what|how|when|where|who|is|are|does|did|can|could|should|would)\b/i;
  const ERROR_TOKEN_RE =
    /\b(error|exception|panic|throws?|traceback|fail(ed|ure|s)?|undefined|null|nan|segfault|sigsegv|stack ?overflow|abort(ed)?)\w*|:\s*\d+|\bat\s+\S|\bcore dumped\b/i;

  const firstLine = failure
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  let error_signature: string;
  if (!firstLine) {
    error_signature = 'unknown';
  } else if (PROSE_QUESTION_RE.test(firstLine) && !ERROR_TOKEN_RE.test(failure)) {
    error_signature = 'prose-question';
  } else if (firstLine.length > 200) {
    error_signature = `${firstLine.slice(0, 197)}...`;
  } else {
    error_signature = firstLine;
  }

  // affected_area: first file-path-shaped token mentioned. Looks for
  // path-like patterns: 'src/foo.ts', './bar.js', 'a/b/c.py:42', etc.
  // Falls back to 'unknown'. Conservative — does not infer module names.
  const pathMatch = combined.match(
    /(?:^|[\s'"`(])((?:\.{1,2}\/)?[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cpp|c|h|hpp|md|json|yaml|yml)(?::\d+(?::\d+)?)?)/,
  );
  const affected_area = pathMatch?.[1] ?? 'unknown';

  return { failure_type, error_signature, affected_area };
}

/**
 * Heuristic: does the proposed fix span more than 2 distinct files?
 * Inspects the winning hypothesis's `proposed_fix` and `location` for
 * file-path-shaped tokens. >2 distinct paths → recommend `/spec` for
 * scoping rather than inline implementation.
 *
 * Conservative — returns false when nothing path-shaped is found, so we
 * don't spuriously recommend `/spec` for fixes described abstractly.
 */
export function fixSpansMultipleFiles(hypothesis: Hypothesis): boolean {
  const text = `${hypothesis.proposed_fix ?? ''}\n${hypothesis.location ?? ''}`;
  const matches = text.match(
    /(?:^|[\s'"`(])((?:\.{1,2}\/)?[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cpp|c|h|hpp))/g,
  );
  if (!matches) return false;
  const distinct = new Set(matches.map((m) => m.trim().replace(/^[\s'"`(]+/, '').split(':')[0]));
  return distinct.size > 2;
}

/**
 * Compute the routing outcome from the diagnose pipeline's terminal state.
 *
 * Decision table:
 * - 0 hypotheses (or all REFUTED in Phase 3.5) → `no_hypotheses`
 * - 0 passes in Phase 4:
 *   - ≥2 hypotheses with Phase-3 confidence ≥ 0.7 → `dissent`
 *   - else → `all_inconclusive`
 * - 1 pass → `clear_winner`
 * - ≥2 passes → `multiple_plausible`
 */
export function computeOutcome(
  hypotheses: Hypothesis[],
  verificationResults: VerificationResult[],
): DiagnosisOutcome {
  if (hypotheses.length === 0) return 'no_hypotheses';
  const passes = verificationResults.filter(
    (r) => r.predicted_pass && r.regressions.length === 0,
  );
  if (passes.length === 1) return 'clear_winner';
  if (passes.length >= 2) return 'multiple_plausible';
  // Zero passes. Distinguish dissent (multiple strong Phase-3 claims that
  // both failed verification) from all_inconclusive (weak claims that failed).
  const strong = hypotheses.filter((h) => h.confidence >= 0.7);
  if (strong.length >= 2) return 'dissent';
  return 'all_inconclusive';
}
