/**
 * Template-mode proposal engine.
 *
 * Given a {@link FailureCard}, deterministically produces an
 * {@link ImprovementProposal} populated from a static pattern → starter
 * map. No LLM calls, no file-system access, no network. Pure.
 *
 * The goal is NOT to produce a finished fix — it's to produce a starter
 * proposal a human reviewer refines before any patch lands. The template
 * provides:
 *
 *   - A hypothesis sentence honestly framed as a guess.
 *   - A coarse root-cause class.
 *   - Pointers to files MOST commonly related to the pattern (verified
 *     against the repo layout as of this commit).
 *   - The canonical forbidden-path globs from
 *     {@link DEFAULT_FORBIDDEN_PATH_GLOBS}.
 *   - A validation plan whose unit tests reference real existing files.
 *
 * Every template marks `confidence: 'low' | 'medium'` on its file
 * suggestions — never `'high'` without a human review. The proposal's
 * top-level `riskLevel` is derived from the worst `likelyFiles[].riskTier`.
 *
 * ## Why these specific files?
 *
 * The file pointers below are grounded in the repo as of the commit that
 * introduces this module. They are deliberately conservative — each entry
 * is a file the detector pattern is materially related to, never a guess.
 * When the codebase moves, the templates need to move too (these are
 * implementation references, not philosophy).
 *
 * @module improve/propose/template-engine
 */

import {
  DEFAULT_FORBIDDEN_PATH_GLOBS,
  type FailureCard,
  type ImprovementProposal,
  type LikelyFile,
  type RootCauseClass,
  type Severity,
  type ValidationPlan,
} from '../schemas.js';

/** Optional injection seam for deterministic tests. */
export interface TemplateContext {
  /** Override the proposal id. Tests use this; production uses the
   *  generator in `writer.ts`. */
  proposalId: string;
  /** Override the timestamp. Tests use this; production defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * The per-pattern starter contents. Kept as a discriminated lookup so the
 * compiler catches missing pattern handlers when the enum grows.
 */
interface PatternTemplate {
  rootCauseClass: RootCauseClass;
  hypothesis(card: FailureCard): string;
  fixSketch(card: FailureCard): string;
  likelyFiles: readonly LikelyFile[];
  /** Severity floor for the proposal's `riskLevel`. The final risk is the
   *  MAX of this and the worst likelyFiles tier. */
  riskFloor: Severity;
  validationPlan: ValidationPlan;
}

const TEMPLATES: Record<FailureCard['pattern'], PatternTemplate> = {
  // -------------------------------------------------------------------------
  // repeated-tool-use
  // -------------------------------------------------------------------------
  'repeated-tool-use': {
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
        'pnpm test -- src/improve/scan/detectors/repeated-tool-use',
        'pnpm test -- src/agent/providers/anthropic-direct',
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
  },

  // -------------------------------------------------------------------------
  // subagent-block
  // -------------------------------------------------------------------------
  'subagent-block': {
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
        'pnpm test -- src/agent/hooks',
        'pnpm test -- src/agent/subagent-hooks',
        'pnpm test -- src/improve/scan/detectors/subagent-block',
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
  },

  // -------------------------------------------------------------------------
  // tool-failure-density
  // -------------------------------------------------------------------------
  'tool-failure-density': {
    rootCauseClass: 'unknown',
    hypothesis: (card) => {
      const toolName = typeof card.detail['toolName'] === 'string' ? card.detail['toolName'] : '<unknown>';
      const failures = typeof card.detail['failureCount'] === 'number' ? card.detail['failureCount'] : '?';
      const total = typeof card.detail['totalCalls'] === 'number' ? card.detail['totalCalls'] : '?';
      const rate = typeof card.detail['failureRate'] === 'number'
        ? `${(card.detail['failureRate'] * 100).toFixed(1)}%`
        : '?%';
      const truncated = typeof card.detail['truncatedFailureCount'] === 'number'
        ? card.detail['truncatedFailureCount']
        : 0;
      const truncatedPart = truncated > 0
        ? ` ${truncated} of those failures were also truncated, which often indicates a separate output-shape problem.`
        : '';
      return (
        `The '${toolName}' tool returned isError: true on ${failures}/${total} calls (${rate}).${truncatedPart} ` +
        `Likely causes: (a) the tool's handler has a bug, (b) the model is calling the tool with malformed inputs the tool rejects, ` +
        `(c) a permission/hook guard is denying legitimate calls, or (d) the tool legitimately returns isError as a signal to the model and this detector is firing on normal behavior.`
      );
    },
    fixSketch: (card) => {
      const toolName = typeof card.detail['toolName'] === 'string' ? card.detail['toolName'] : '<the tool>';
      const sessionIds = Array.isArray(card.detail['sessionIds']) ? (card.detail['sessionIds'] as string[]) : [];
      const firstId = sessionIds[0] ?? '<session-id>';
      return [
        '## Diagnostic steps (do these first)',
        '',
        `1. Inspect a representative failure trace: \`cat ~/.afk/state/witness/${firstId}/trace.jsonl | grep '"name":"${toolName}"' | tail -5\``,
        `2. Look at the events immediately BEFORE each failure — what did the model send as input?`,
        '3. The witness trace does not capture tool args verbatim. To see the actual input, check the session message history under `~/.afk/state/sessions/<sessionId>/`.',
        '',
        '## Candidate fixes (human picks)',
        '',
        `**Option A — handler bug.** Locate the tool implementation under \`src/agent/tools/handlers/\` and read its error paths. If a specific failure mode is reachable from common LLM inputs, fix the handler.`,
        '',
        `**Option B — input shape too restrictive.** If the tool's input schema rejects inputs the model naturally produces, either loosen the schema or improve the schema's description so the model can comply.`,
        '',
        `**Option C — permission/hook denial.** Check whether a PreToolUse hook or permission gate is rejecting the call. The dispatcher returns isError: true for hook blocks and permission denials (\`src/agent/tools/dispatcher.ts:337–352\`).`,
        '',
        `**Option D — accept as normal.** Some tools intentionally return isError as a signal (e.g., grep finding nothing). If this is the case, mark the card resolved with a note explaining why, or tune the detector threshold via \`--tool-failure-min-rate\`.`,
      ].join('\n');
    },
    likelyFiles: [
      {
        path: 'src/agent/tools/dispatcher.ts',
        rationale:
          'Tool dispatch core. Every isError: true path goes through here: hook block, permission denied, handler throw, unknown tool. Read this to understand which class each failure falls into.',
        riskTier: 'high',
        confidence: 'medium',
      },
      {
        path: 'src/agent/tools/handlers/',
        rationale:
          'Tool handlers. If a specific handler is buggy, the fix lives in the handler file matching the tool name (e.g. handlers/bash.ts for the Bash tool).',
        riskTier: 'moderate',
        confidence: 'medium',
      },
      {
        path: 'src/improve/scan/detectors/tool-failure-density.ts',
        rationale: 'If the detector is flagging legitimate isError-as-signal behavior, tune the threshold here or document the tool as expected-failures.',
        riskTier: 'safe',
        confidence: 'low',
      },
    ],
    riskFloor: 'medium',
    validationPlan: {
      unitTests: [
        'pnpm test -- src/improve/scan/detectors/tool-failure-density',
        'pnpm test -- src/agent/tools/dispatcher',
      ],
      evalCases: [],
      smokeChecks: [
        'pnpm lint',
        'afk improve scan --only tool-failure-density --since 7d  # after fix, failure rate should drop',
      ],
      manualChecks: [
        'Open the trace at the evidence seqs and read the failure annotations (resultBytes, durationMs).',
        'Inspect the session message history for the actual tool input that triggered the failure.',
        'Decide which of the four root cause classes (handler bug / input shape / permission / detector noise) the failures belong to.',
      ],
    },
  },

  // -------------------------------------------------------------------------
  // closure-anomaly
  // -------------------------------------------------------------------------
  'closure-anomaly': {
    rootCauseClass: 'unknown',
    hypothesis: (card) => {
      const reason = typeof card.detail['closureReason'] === 'string' ? card.detail['closureReason'] : '<unknown>';
      const affected = typeof card.detail['affectedSessions'] === 'number' ? card.detail['affectedSessions'] : '?';
      const total = typeof card.detail['totalCostUsd'] === 'number' ? card.detail['totalCostUsd'] : null;
      const costPart = total !== null ? ` totalling $${total.toFixed(4)}` : '';
      return (
        `${affected} session(s) closed with reason='${reason}'${costPart}. ` +
        `Anomalous closure reasons signal one of: budget mis-configuration, timeout too tight, a hook returning block at the session edge, or an explicit/cascaded abort. The right fix depends on the reason value.`
      );
    },
    fixSketch: (card) => {
      const reason = typeof card.detail['closureReason'] === 'string' ? card.detail['closureReason'] : '<unknown>';
      const sessionIds = Array.isArray(card.detail['sessionIds']) ? (card.detail['sessionIds'] as string[]) : [];
      const firstId = sessionIds[0] ?? '<session-id>';
      const advice = closureAdviceFor(reason);
      return [
        `## Closure reason: \`${reason}\``,
        '',
        advice,
        '',
        '## Diagnostic steps',
        '',
        `1. Inspect the trace for one of the affected sessions: \`cat ~/.afk/state/witness/${firstId}/trace.jsonl | tail -20\``,
        `2. Check the events immediately before the closure — what was the runtime trying to do?`,
        '3. Cross-reference with \`~/.afk/agent-framework/routing-decisions.jsonl\` for any subagent activity at the same timestamp.',
      ].join('\n');
    },
    likelyFiles: [
      {
        path: 'src/agent/session/agent-session.ts',
        rationale: 'Closure-event emission lives here. Field meanings and the reason classification are owned by this module.',
        riskTier: 'high',
        confidence: 'medium',
      },
      {
        path: 'src/agent/session/stream-consumer.ts',
        rationale: 'Budget threshold detection / closure-reason routing. Touch only if the closure CAUSE is here.',
        riskTier: 'high',
        confidence: 'low',
      },
      {
        path: 'src/agent/abort-graph.ts',
        rationale: 'Origin tracking for abort-type closures.',
        riskTier: 'moderate',
        confidence: 'low',
      },
    ],
    riskFloor: 'medium',
    validationPlan: {
      unitTests: [
        'pnpm test -- src/agent/session',
        'pnpm test -- src/improve/scan/detectors/closure-anomaly',
      ],
      evalCases: [],
      smokeChecks: ['pnpm lint'],
      manualChecks: [
        'Read the closure events at the seqs listed in the evidence.',
        'Confirm the closure reason is correct semantically (not a misclassification).',
      ],
    },
  },
};

/**
 * Stable, file-set-tested advice per closure reason. Kept separate so it
 * can be unit-tested without exercising the full template pipeline.
 */
function closureAdviceFor(reason: string): string {
  switch (reason) {
    case 'budget_exceeded':
      return 'The monetary ceiling tripped. Confirm `AFK_MAX_BUDGET_USD` is set to a realistic value for the workload; if so, the LLM call shape (cache use, output cap, model choice) is the next place to look.';
    case 'timeout':
      return 'The wall-clock cap fired. Check whether the timeout is configured too tightly for the workload, or whether a tool call is hanging. Tool-call durations in the same trace will tell you which.';
    case 'hook_blocked':
      return 'A hook returned `decision: \'block\'` at the session edge. Cross-reference with any `subagent-block` cards on this scan — the underlying cause is likely the same handler.';
    case 'abort':
      return 'An explicit or cascaded abort closed the session. If origin is `user_signal`, no action needed. If `cascade`/`budget`/`timeout`, the originating cause is the real issue.';
    case 'iteration_cap':
      return 'Loop iteration ceiling tripped. The model could not make progress in N turns. Either the task is genuinely impossible at that budget, or a tool is in an unproductive loop (cross-reference repeated-tool-use cards).';
    case 'max_turns_exceeded':
      return 'Turn ceiling tripped. Same diagnostic as iteration_cap.';
    default:
      return 'Reason not in the known anomalous set. Inspect the trace and update the detector if this is a new closure variant.';
  }
}

/**
 * Build a starter proposal from a card. Deterministic given the same
 * inputs. Throws if the card's pattern is unknown to the template engine
 * (would indicate a schema/template drift — fail loudly).
 */
export function proposeFromCard(card: FailureCard, ctx: TemplateContext): ImprovementProposal {
  const template = TEMPLATES[card.pattern];
  if (!template) {
    throw new Error(
      `template-engine: no template for pattern '${card.pattern}' — add one to TEMPLATES`,
    );
  }

  const createdAt = (ctx.now ?? (() => new Date()))().toISOString();
  const hypothesis = template.hypothesis(card);
  const fixSketch = template.fixSketch(card);
  const likelyFiles = template.likelyFiles.map((f) => ({ ...f }));

  // Compute risk: MAX of riskFloor and worst likelyFiles tier.
  const riskLevel = deriveRiskLevel(template.riskFloor, likelyFiles);

  // Evidence refs back to the card: one per evidence row.
  const evidenceRefs = card.evidence.map((ev) => ({
    cardSlug: card.slug,
    eventIndices: [...ev.eventIndices],
    ...(ev.annotation !== undefined ? { annotation: ev.annotation } : {}),
  }));

  return {
    schemaVersion: 1,
    proposalId: ctx.proposalId,
    cardSlug: card.slug,
    title: buildTitle(card),
    hypothesis,
    rootCauseClass: template.rootCauseClass,
    evidenceRefs,
    fixSketch,
    likelyFiles,
    riskLevel,
    validationPlan: structuredCloneShallow(template.validationPlan),
    scopeFreeze: {
      forbiddenPaths: [...DEFAULT_FORBIDDEN_PATH_GLOBS],
      requiresExplicitApproval: riskLevel === 'high',
    },
    generatedBy: 'template',
    createdAt,
    status: 'draft',
    notes: [],
  };
}

/**
 * Risk derivation. Goal: never UNDERESTIMATE risk.
 *
 *   - Worst tier `forbidden` → high (and `requiresExplicitApproval: true`
 *     downstream).
 *   - Worst tier `high` → high.
 *   - Worst tier `moderate` → max(floor, 'medium').
 *   - Worst tier `safe` → floor.
 */
export function deriveRiskLevel(
  floor: Severity,
  files: readonly LikelyFile[],
): Severity {
  const fileTier = worstTier(files);
  if (fileTier === 'forbidden' || fileTier === 'high') return 'high';
  if (fileTier === 'moderate') return maxSeverity(floor, 'medium');
  return floor;
}

function worstTier(files: readonly LikelyFile[]): 'safe' | 'moderate' | 'high' | 'forbidden' {
  const order = ['safe', 'moderate', 'high', 'forbidden'] as const;
  let worstIdx = 0;
  for (const f of files) {
    const idx = order.indexOf(f.riskTier);
    if (idx > worstIdx) worstIdx = idx;
  }
  return order[worstIdx]!;
}

const SEV_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };
function maxSeverity(a: Severity, b: Severity): Severity {
  return SEV_RANK[a] >= SEV_RANK[b] ? a : b;
}

function buildTitle(card: FailureCard): string {
  return `Proposal: address ${card.pattern} — ${card.title}`.slice(0, 200);
}

/**
 * Shallow clone of the validation plan (arrays only — strings are
 * immutable). Avoids the proposal's arrays aliasing the template's.
 */
function structuredCloneShallow(plan: ValidationPlan): ValidationPlan {
  return {
    unitTests: [...plan.unitTests],
    evalCases: [...plan.evalCases],
    smokeChecks: [...plan.smokeChecks],
    manualChecks: [...plan.manualChecks],
  };
}
