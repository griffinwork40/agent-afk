/**
 * Built-in SubagentStop hook: when a child sub-agent returns decision-driving
 * findings (verdicts, recommendations, audit conclusions), inject a nudge
 * into the parent session suggesting `/shadow-verify` before acting.
 *
 * Design reference: `agent-workflow-amplifiers-private/hooks/shadow_verify_nudge.py`.
 * Heuristics are intentionally conservative — false silence is cheap, false
 * alarms train users to ignore the nudge. Changes to the reference Python
 * version should be mirrored here.
 *
 * @module agent/shadow-verify-nudge
 */

import type { HookContext, HookDecision } from './hooks.js';

const MIN_OUTPUT_CHARS = 600;
const MIN_MARKER_HITS = 2;

const VERIFIED_ORCHESTRATORS = [
  'shadow-verify',
  'shadow_verify',
  'resolve',
  'diagnose',
  'appmap',
  'mint',
  // `review` is read-only by hard constraint (it never edits/commits/pushes)
  // and runs shadow-verify internally for critical/high findings. Nudging the
  // parent to re-verify its output would either fire on a report it can't act
  // on destructively, or double-verify what review already verified. Suppress.
  'review',
];

const DECISION_MARKERS: RegExp[] = [
  /\bverdict(s)?\b/i,
  /\brecommend(ation)?s?\b/i,
  /\bshould\s+(delete|remove|rewrite|refactor|rename|reject|merge|revert|disable)\b/i,
  /\b(USELESS|KEEP|REJECT|APPROVE|SALVAGE|BLOCK|FAIL)\b/,
  /\b(redundant|duplicated|superseded|obsolete)\b/i,
  /\bvulnerab\w*\b/i,
  /\bunused\b/i,
  /\bbroken\b/i,
  /\bregress\w*\b/i,
  /\|\s*(status|verdict|decision|severity|risk|finding|priority|holds\??)\s*\|/i,
  /\bfound\s+\d+\s*(issue|problem|bug|error|finding|vulnerabilit)/i,
  /\b(critical|high|medium|low)\s+(severity|priority|risk)\b/i,
  /\bclaim(s)?\b[^\n]{0,80}\b(holds?|refuted|verified|partial|confirmed|disputed)\b/i,
  /\b(root\s*cause|incident)\b/i,
  /\brecommend\s+(removing|deleting|rewriting|refactoring|merging|reverting)\b/i,
  /\bI\s+(applied|committed|pushed|edited|wrote|fixed|patched|reset|restored|staged)\b/i,
  /\b(applied|committed|pushed|fixed|patched)\s+(the|these|those)\s+(change|commit|fix|patch|edit)/i,
];

const VERIFIER_SIGNATURES: RegExp[] = [
  /\bverifier_verdict\b/i,
  /"\s*claim\s*"\s*:/i,
  /\bre-derived\b[^.\n]{0,80}\bindependent/i,
  /\bindependently\s+(re-derived|re-verified|verified|checked)\b/i,
  /\bverifier\s+(agrees|disagrees|confirms|refutes)\b/i,
];

const CONTEXT_MESSAGE =
  '[framework-generated context: shadow-verify nudge]\n\n' +
  'The sub-agent that just finished returned output that reads like ' +
  '**decision-driving findings** (verdicts, recommendations, audit ' +
  'conclusions, or claim-style results that could drive file edits, ' +
  'deletions, commits, or external side-effects).\n\n' +
  'Single-pass sub-agent reports are prone to confident hallucination — ' +
  'polished output that falls apart on re-derivation. Before acting on ' +
  'these conclusions, consider dispatching `/shadow-verify`. Independent ' +
  'verifiers will re-derive the 2–3 most load-bearing claims from scratch ' +
  "(without seeing the original reasoning) and flag any that don't hold up.\n\n" +
  'Skip when: the findings are purely exploratory, the sub-agent ran ' +
  'inside an already-verifying orchestrator, the user is about to ' +
  'dismiss the report, or the stakes are low (read-only Q&A).';

// Match an orchestrator name only at a hyphen/word boundary, never as an
// arbitrary substring. agentType is `effectiveAgentType ?? idPrefix`
// (subagent.ts), and skill dispatch labels forks `skill-<name>` /
// `skill-fork-<name>`, so we must catch the bare name AND the prefixed forms
// (`review`, `skill-review`, `skill-fork-review`) while NOT false-matching
// look-alikes like `preview`, `reviewer`, `resolver`, or `minty-fresh`. Each
// name is treated as a token delimited by `-` or the string start/end.
const VERIFIED_ORCHESTRATOR_RES: readonly RegExp[] = VERIFIED_ORCHESTRATORS.map(
  (o) => new RegExp(`(?:^|-)${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-|$)`, 'i'),
);

function fromVerifiedOrchestrator(agentType: string | undefined): boolean {
  if (!agentType) return false;
  return VERIFIED_ORCHESTRATOR_RES.some((re) => re.test(agentType));
}

function looksLikeVerifierResponse(output: string): boolean {
  return VERIFIER_SIGNATURES.some((re) => re.test(output));
}

function decisionHits(output: string): number {
  let hits = 0;
  for (const re of DECISION_MARKERS) if (re.test(output)) hits++;
  return hits;
}

export function shadowVerifyNudge(context: HookContext): HookDecision {
  if (context.event !== 'SubagentStop') return {};
  const output = context.lastMessage ?? '';
  if (output.length < MIN_OUTPUT_CHARS) return {};
  if (fromVerifiedOrchestrator(context.agentType)) return {};
  if (looksLikeVerifierResponse(output)) return {};
  if (decisionHits(output) < MIN_MARKER_HITS) return {};
  return { injectContext: CONTEXT_MESSAGE };
}
