/**
 * Pattern templates for loop-class and hook-class failure patterns.
 *
 * Provides the starter template records for `repeated-tool-use`,
 * `subagent-block`, and `subagent-read-denial`. Consumed by
 * `template-engine.ts` which assembles the full TEMPLATES registry.
 *
 * @module improve/propose/template-engine.templates-loop
 */

import type {
  FailureCard,
  LikelyFile,
  ValidationPlan,
} from '../schemas.js';
import type { RootCauseClass, Severity } from '../schemas.js';

// ---------------------------------------------------------------------------
// PatternTemplate interface (local mirror — the canonical copy lives in
// template-engine.ts; each sibling declares it to avoid a circular import).
// ---------------------------------------------------------------------------

/** Invariant: must stay byte-for-byte in sync with the copy in template-engine.ts. */
interface PatternTemplate {
  rootCauseClass: RootCauseClass;
  hypothesis(card: FailureCard): string;
  fixSketch(card: FailureCard): string;
  likelyFiles: readonly LikelyFile[];
  riskFloor: Severity;
  validationPlan: ValidationPlan;
}

// ---------------------------------------------------------------------------
// repeated-tool-use
// ---------------------------------------------------------------------------

export const repeatedToolUseTemplate: PatternTemplate = {
  rootCauseClass: 'dispatcher-bug',
  hypothesis: (card) => {
    const toolName = typeof card.detail['toolName'] === 'string' ? card.detail['toolName'] : '<unknown>';
    const runLength = typeof card.detail['runLength'] === 'number' ? card.detail['runLength'] : '?';
    return (
      `The '${toolName}' tool was dispatched ${runLength} times in a row with an identical input/output byte fingerprint. ` +
      `This is either (a) the model is stuck retrying the same call without responding to its result, ` +
      `(b) the tool's result shape is too uninformative for the model to make progress, or ` +
      `(c) a productive recursion that happens to share byte counts (rare; the fingerprint caveat is documented on the detector).`
    );
  },
  fixSketch: (card) => {
    const toolName = typeof card.detail['toolName'] === 'string' ? card.detail['toolName'] : '<the tool>';
    return [
      '## Candidate fixes (human picks)',
      '',
      `**Option A — make the loop visible.** Surface a clear "no-progress" signal to the model when '${toolName}' returns the same result N times in a row. Today the dispatcher just executes the call.`,
      '',
      `**Option B — improve the tool's result shape.** If the model can't distinguish "no results" from "same results," its result is information-poor. Inspect the tool's response and verify it carries enough signal for the model to change its query.`,
      '',
      `**Option C — confirm productive recursion.** Open the source trace at the seq values listed in the evidence and inspect the model's reasoning between repeats. If each call's args genuinely differ (and the byte-count collision is the issue), no code change is needed; tune the detector instead.`,
      '',
      '_Option C first — the byte-fingerprint detector has a documented collision caveat. Confirm there is a real loop before changing dispatcher behavior._',
    ].join('\n');
  },
  likelyFiles: [
    {
      path: 'src/agent/providers/anthropic-direct/loop.ts',
      rationale:
        'Main tool dispatch loop. If a no-progress detector is added at the dispatch boundary, it lives here.',
      riskTier: 'moderate',
      confidence: 'medium',
    },
    {
      path: 'src/agent/tools/',
      rationale:
        'Tool implementations. If the result shape is information-poor, the specific tool implementation needs the change.',
      riskTier: 'safe',
      confidence: 'low',
    },
    {
      path: 'src/improve/scan/detectors/repeated-tool-use.ts',
      rationale: 'If this turns out to be detector noise rather than a real bug, tune here.',
      riskTier: 'safe',
      confidence: 'medium',
    },
  ],
  riskFloor: 'medium',
  validationPlan: {
    unitTests: [
      'pnpm test src/improve/scan/detectors/repeated-tool-use',
      'pnpm test src/agent/providers/anthropic-direct',
    ],
    evalCases: [],
    smokeChecks: [
      'pnpm lint',
      'afk improve scan --since 7d  # after fix lands, this pattern should NOT recur',
    ],
    manualChecks: [
      'Open the trace at the evidence seqs and confirm the calls are truly identical (not just byte-coincident).',
    ],
  },
};

// ---------------------------------------------------------------------------
// subagent-block
// ---------------------------------------------------------------------------

export const subagentBlockTemplate: PatternTemplate = {
  rootCauseClass: 'hook-overreach',
  hypothesis: (card) => {
    const reason = typeof card.detail['reason'] === 'string' ? card.detail['reason'] : '';
    const blockCount = typeof card.detail['blockCount'] === 'number' ? card.detail['blockCount'] : '?';
    const distinctSessions = typeof card.detail['distinctSessions'] === 'number' ? card.detail['distinctSessions'] : '?';
    const reasonPart = reason ? ` with reason "${reason.slice(0, 200)}"` : ' (no reason field on the block events)';
    return (
      `A SubagentStart hook returned decision:'block' ${blockCount} times across ${distinctSessions} session(s)${reasonPart}. ` +
      `Recurring blocks suggest either (a) the guard is over-broad and trips on legitimate dispatches, (b) the legitimate use case actually needs a refactor to satisfy the guard, or (c) the user has no signal explaining the block and keeps retrying.`
    );
  },
  fixSketch: (card) => {
    const reason = typeof card.detail['reason'] === 'string' ? card.detail['reason'] : '<not in payload>';
    return [
      '## Candidate fixes (human picks)',
      '',
      `**Identify the hook owner first.** The trace's hook_decision event carries the \`reason\` field ("${reason}"). Grep the codebase for that literal string — that locates the hook handler.`,
      '',
      '```sh',
      `# Replace the quoted string below with the actual reason text from the evidence.`,
      `grep -rn -- "${reason.slice(0, 60).replace(/"/g, '\\"')}" src/`,
      '```',
      '',
      '**Option A — tighten the guard.** If the block fires on dispatches it should not, narrow the predicate. Confirm by adding a unit test that exercises the false-positive case.',
      '',
      '**Option B — make the refusal legible.** Instead of `decision: \'block\'`, return a hook decision that injects a context message via `injectContext`. The parent session then sees a clear no-op message instead of a silent block.',
      '',
      '**Option C — accept the block as correct.** If the guard is doing its job, mark the card resolved via `afk improve cards triage <slug> --status resolved --note "..."`. No code change.',
    ].join('\n');
  },
  likelyFiles: [
    {
      path: 'src/agent/hooks.ts',
      rationale: 'Hook dispatch core. Only touched if the injectContext mechanism itself needs an extension.',
      riskTier: 'high',
      confidence: 'low',
    },
    {
      path: 'src/agent/hook-registry.ts',
      rationale: 'Hook registration. Same caveat — usually not the right spot.',
      riskTier: 'high',
      confidence: 'low',
    },
    {
      path: 'src/agent/subagent-hooks.ts',
      rationale: 'SubagentStart hook dispatch path. The reason text is set by whatever handler is registered here.',
      riskTier: 'moderate',
      confidence: 'medium',
    },
    {
      path: 'src/skills/',
      rationale:
        'A skill is the typical owner of a SubagentStart hook. Grep for the block reason text to locate the specific handler.',
      riskTier: 'safe',
      confidence: 'medium',
    },
  ],
  riskFloor: 'medium',
  validationPlan: {
    unitTests: [
      'pnpm test src/agent/hooks',
      'pnpm test src/agent/subagent-hooks',
      'pnpm test src/improve/scan/detectors/subagent-block',
    ],
    evalCases: [],
    smokeChecks: [
      'pnpm lint',
      'afk improve scan --since 7d  # after fix, blocks with same reason should not recur',
    ],
    manualChecks: [
      'Grep the codebase for the reason text from the evidence to find the hook handler.',
      'Run a session that exercises the legitimate dispatch and confirm it is no longer blocked.',
    ],
  },
};

// ---------------------------------------------------------------------------
// subagent-read-denial
// ---------------------------------------------------------------------------

export const subagentReadDenialTemplate: PatternTemplate = {
  rootCauseClass: 'dispatcher-bug',
  hypothesis: (card) => {
    const denialCount = typeof card.detail['denialCount'] === 'number' ? card.detail['denialCount'] : '?';
    const distinctSessions = typeof card.detail['distinctSessions'] === 'number' ? card.detail['distinctSessions'] : '?';
    const tools = Array.isArray(card.detail['blockedTools']) ? (card.detail['blockedTools'] as unknown[]).join(', ') : '?';
    return (
      `The path-approval PreToolUse hook auto-denied a forked sub-agent's READ (${tools}) ${denialCount} times across ${distinctSessions} session(s) — the resolved path fell outside the fork's granted READ roots and a fork cannot prompt to approve. ` +
      `The child then retries the read and spins until a wall-clock timeout. Root cause is almost always a read-scope grant that is NARROWER than the parent's: the fork was given a concrete cwd but not the parent's read reach (main repo, sibling .afk-worktrees/*, ~/.afk/state).`
    );
  },
  fixSketch: () => {
    return [
      '## Candidate fixes (human picks)',
      '',
      "**Option A — widen the fork's inherited read scope (usual fix).** A forked read-only sub-agent must be able to READ everything its parent could; only WRITES stay confined. The inheritance rule lives in `computeInheritedReadRoots` (`src/agent/subagent-read-scope.ts`), applied at the fork choke point in `SubagentManager.forkSubagent` (`src/agent/subagent.ts`). Confirm an unconfined parent yields a read-open child and a confined parent yields union(childCwd, parentRoots, worktreeMainRoot).",
      '',
      '**Option B — verify the `afk farm` guardrail still holds.** A caller that pins `readRoots` (branch workers) must keep suppressing inheritance so a deliberately-confined worker is never widened. Guard with the regression test in `subagent-worktree-readroot.test.ts`.',
      '',
      '**Option C — fail fast instead of hanging.** If a denial is legitimate (genuinely out-of-scope), the fork should abort with an actionable message after N identical denials rather than retry to a wall-clock timeout. Separate hardening from the scope fix.',
    ].join('\n');
  },
  likelyFiles: [
    {
      path: 'src/agent/subagent-read-scope.ts',
      rationale: 'The read-scope inheritance rule (computeInheritedReadRoots). The usual fix site.',
      riskTier: 'moderate',
      confidence: 'high',
    },
    {
      path: 'src/agent/subagent.ts',
      rationale: 'forkSubagent applies the inherited read roots at the fork choke point.',
      riskTier: 'moderate',
      confidence: 'medium',
    },
    {
      path: 'src/agent/tools/hooks/path-approval-hook.ts',
      rationale: 'The PreToolUse hook that auto-denies out-of-root reads. Touch only to change the fail-fast behavior (Option C), not the grant.',
      riskTier: 'high',
      confidence: 'low',
    },
  ],
  riskFloor: 'medium',
  validationPlan: {
    unitTests: [
      'pnpm test src/agent/subagent-read-scope',
      'pnpm test src/agent/subagent-worktree-readroot',
      'pnpm test src/improve/scan/detectors/subagent-read-denial',
    ],
    evalCases: [],
    smokeChecks: [
      'pnpm lint',
      'afk improve scan --only subagent-read-denial --since 7d  # after fix, read-denials should not recur',
    ],
    manualChecks: [
      'Open the trace at the evidence seqs; confirm the denied paths are ones the parent could read (main repo / sibling worktree / ~/.afk/state).',
      'Run a fan-out (e.g. /diagnose) that dispatches read-only forks and confirm they can read across the workspace.',
    ],
  },
};
