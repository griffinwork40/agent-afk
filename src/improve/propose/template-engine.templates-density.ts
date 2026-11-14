/**
 * Pattern templates for density-class and closure-class failure patterns.
 *
 * Provides the starter template records for `tool-failure-density` and
 * `closure-anomaly`, plus the `closureAdviceFor` helper consumed by the
 * `closure-anomaly` fix sketch. Consumed by `template-engine.ts` which
 * assembles the full TEMPLATES registry.
 *
 * @module improve/propose/template-engine.templates-density
 */

import type {
  FailureCard,
  LikelyFile,
  ValidationPlan,
} from '../schemas.js';
import type { RootCauseClass, Severity } from '../schemas.js';

// ---------------------------------------------------------------------------
// Helpers — rootCauseClass inference and per-tool likelyFiles
// ---------------------------------------------------------------------------

/**
 * Infer a `RootCauseClass` from the dominant error-cluster key.
 *
 * The cluster key is normalized (lowercase, ids/paths/numbers collapsed) so
 * we match on stable keyword patterns rather than exact strings.
 *
 * Exported for unit testing.
 */
export function rootCauseFromClusterKey(key: string): RootCauseClass {
  const k = key.toLowerCase();
  // Hook / permission blocks
  if (
    k.includes('blocked by') ||
    k.includes('permission denied') ||
    k.includes('hook') ||
    k.includes('guard') ||
    k.includes('allowlist') ||
    k.includes('denylist') ||
    k.includes('not allowed')
  ) return 'hook-overreach';
  // Schema / input-shape rejections
  if (
    k.includes('invalid input') ||
    k.includes('validation') ||
    k.includes('schema') ||
    k.includes('malformed') ||
    k.includes('unexpected token') ||
    k.includes('parse error')
  ) return 'schema-too-strict';
  // Stale reference / not-found
  if (
    k.includes('enoent') ||
    k.includes('not found') ||
    k.includes('no such file') ||
    k.includes('does not exist') ||
    k.includes('cannot find')
  ) return 'tool-output-shape';
  // Timeout
  if (
    k.includes('timed out') ||
    k.includes('timeout') ||
    k.includes('deadline')
  ) return 'timeout-too-low';
  return 'unknown';
}

/**
 * Build tool-specific `likelyFiles` for a `tool-failure-density` card.
 *
 * When a handler file for the tool name exists under
 * `src/agent/tools/handlers/`, it is surfaced first with high confidence.
 * `dispatcher.ts` is always included as the fallback entry point.
 *
 * Exported for unit testing.
 */
export function likelyFilesForTool(toolName: string): readonly LikelyFile[] {
  const files: LikelyFile[] = [];

  if (toolName && toolName !== '<unknown>' && toolName !== '<the tool>') {
    const handlerName = toolName.replace(/_/g, '-');
    files.push({
      path: `src/agent/tools/handlers/${handlerName}.ts`,
      rationale: `Handler for the '${toolName}' tool. Read its error paths first — most isError: true returns originate here.`,
      riskTier: 'moderate',
      // Contract: confidence is 'medium' not 'high' because several tools share a
      // handler file (e.g. create_schedule → schedules.ts, config_get → config-ops.ts).
      // A reviewer should verify the path before acting on it.
      confidence: 'medium',
    });
  }

  files.push({
    path: 'src/agent/tools/dispatcher.ts',
    rationale:
      'Tool dispatch core. Every isError: true path goes through here: hook block, permission denied, handler throw, unknown tool. Needed when the failure is a pre-handler rejection.',
    riskTier: 'high',
    confidence: 'medium',
  });

  files.push({
    path: 'src/improve/scan/detectors/tool-failure-density.ts',
    rationale:
      'If the detector is flagging legitimate isError-as-signal behavior, tune the threshold here or document the tool as expected-failures.',
    riskTier: 'safe',
    confidence: 'low',
  });

  return files;
}

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
// tool-failure-density
// ---------------------------------------------------------------------------

export const toolFailureDensityTemplate: PatternTemplate = {
  rootCauseClass: 'unknown',
  hypothesis: (card) => {
    // Wire helpers: use rootCauseFromClusterKey + likelyFilesForTool per-tool
    // (rootCauseClass is set statically as fallback; proposeFromCard overrides it)
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
    // H3 fix: convert underscore tool names to hyphenated handler filenames
    // (e.g. read_file → read-file.ts, wait_for → wait-for.ts)
    const handlerName = toolName.replace(/_/g, '-');
    const sessionIds = Array.isArray(card.detail['sessionIds']) ? (card.detail['sessionIds'] as string[]) : [];
    const firstId = sessionIds[0] ?? '<session-id>';
    // M1 fix: sessionIds entries are durable session IDs (not witness labels),
    // so the subagents/ path is correct when using the session ID directly.
    // The witness label (random UUID under state/witness/) is separate from the
    // session ID (under state/sessions/); card.detail.sessionIds holds session IDs.
    return [
      '## Diagnostic steps (do these first)',
      '',
      // H2 fix: positional arg, not --session/--tool flags
      `1. Read the error text from a representative failure: \`afk trace show ${firstId} --results | head -20\``,
      `   The \`errorHead\` field on each \`tool_call.completed\` row contains the first ≤200 chars of the error — usually enough to name the cause without reading the full trace.`,
      `2. Look at the events immediately BEFORE each failure — what did the model send as input?`,
      `3. For child-session calls (where \`subagentId\` appears on the evidence row), full tool args are recorded in the subagent journal: \`~/.afk/state/sessions/${firstId}/subagents/<subagentId>.jsonl\`. ` +
        `Use \`afk trace show ${firstId} --results\` to surface both the error text and the subagent context in one pass.`,
      '',
      '## Candidate fixes (human picks)',
      '',
      // H3 fix: use handlerName (underscores → hyphens) for the file path
      `**Option A — handler bug.** Read \`src/agent/tools/handlers/${handlerName}.ts\` (or the closest match under \`handlers/\`) and inspect its error paths. If a specific failure mode is reachable from common LLM inputs, fix the handler.`,
      '',
      `**Option B — input shape too restrictive.** If the tool's input schema rejects inputs the model naturally produces, either loosen the schema or improve the schema's description so the model can comply.`,
      '',
      `**Option C — permission/hook denial.** Check whether a PreToolUse hook or permission gate is rejecting the call. The dispatcher returns isError: true for hook blocks and permission denials (\`src/agent/tools/dispatcher.ts\`).`,
      '',
      `**Option D — accept as normal.** Some tools intentionally return isError as a signal (e.g., grep finding nothing). If this is the case, mark the card resolved with a note explaining why, or tune the detector threshold via \`--tool-failure-min-rate\`.`,
    ].join('\n');
  },
  // H1 fix: wire likelyFilesForTool so the template produces tool-specific
  // likelyFiles at proposal time. The static array below is the default
  // fallback; proposeFromCard must call likelyFilesForTool(toolName) to
  // override it per-card. See proposeFromCard in template-engine.ts.
  likelyFiles: [
    {
      path: 'src/agent/tools/handlers/',
      rationale:
        'Tool handlers directory. The handler for the failing tool lives here (e.g. `handlers/bash.ts` for bash, `handlers/git-read.ts` for git-read). Read its error paths — most isError: true returns originate in the handler.',
      riskTier: 'moderate',
      confidence: 'high',
    },
    {
      path: 'src/agent/tools/dispatcher.ts',
      rationale:
        'Tool dispatch core. Every isError: true path goes through here: hook block, permission denied, handler throw, unknown tool. Needed when the failure is a pre-handler rejection.',
      riskTier: 'high',
      confidence: 'medium',
    },
    {
      path: 'src/improve/scan/detectors/tool-failure-density.ts',
      rationale:
        'If the detector is flagging legitimate isError-as-signal behavior, tune the threshold here or document the tool as expected-failures.',
      riskTier: 'safe',
      confidence: 'low',
    },
  ],
  riskFloor: 'medium',
  validationPlan: {
    unitTests: [
      'pnpm test src/improve/scan/detectors/tool-failure-density',
      'pnpm test src/improve/propose/template-engine.templates-density',
      'pnpm test src/agent/tools/dispatcher',
    ],
    evalCases: [],
    smokeChecks: [
      'pnpm lint',
      'afk improve scan --only tool-failure-density --since 7d  # after fix, failure rate should drop',
    ],
    manualChecks: [
      'Open the trace at the evidence seqs and read the errorHead annotations.',
      'For child-session failures, check the subagent journal for full tool args.',
      'Decide which of the four root cause classes (handler bug / input shape / permission / detector noise) the failures belong to.',
    ],
  },
};

// ---------------------------------------------------------------------------
// closureAdviceFor — used only by the closure-anomaly fix sketch below
// ---------------------------------------------------------------------------

/**
 * Stable, file-set-tested advice per closure reason. Kept next to the
 * `closure-anomaly` template it serves so changes to either stay together.
 * Exported so `template-engine.test.ts` can assert against it directly.
 */
export function closureAdviceFor(reason: string): string {
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
    case 'truncated':
      return 'The model hit the output-token ceiling mid-response. Check `max_tokens` and the model\'s output limit. Consider retrying with a larger output budget or splitting the task into smaller steps.';
    default:
      return 'Reason not in the known anomalous set. Inspect the trace and update the detector if this is a new closure variant.';
  }
}

// ---------------------------------------------------------------------------
// closure-anomaly
// ---------------------------------------------------------------------------

export const closureAnomalyTemplate: PatternTemplate = {
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
      'pnpm test src/agent/session',
      'pnpm test src/improve/scan/detectors/closure-anomaly',
    ],
    evalCases: [],
    smokeChecks: ['pnpm lint'],
    manualChecks: [
      'Read the closure events at the seqs listed in the evidence.',
      'Confirm the closure reason is correct semantically (not a misclassification).',
    ],
  },
};
