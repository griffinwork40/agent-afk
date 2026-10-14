/**
 * Post-DAG settlement helpers for {@link ComposeExecutor}: wave-manifest
 * status updates and model-facing content assembly. Split out of
 * `compose-executor.ts` to keep `ComposeExecutor.execute` under the 200-line
 * function ceiling (#1865).
 *
 * @module agent/tools/compose-executor.settle
 */

import { updateWaveUnit } from '../manifest/write.js';
import { formatDAGResult, formatTruncationWarning } from './compose-executor.format.js';
import { prependUsageNotice } from './usage-notice.js';

type ComposeRunResult = Parameters<typeof formatDAGResult>[0];

/**
 * Wave manifest: update unit statuses based on DAG outcome. Fire-and-forget:
 * status update failures must never abort settlement.
 */
export function updateComposeWaveUnits(composeWaveId: string | undefined, result: ComposeRunResult): void {
  if (composeWaveId === undefined) return;
  try {
    for (const nodeId of Object.keys(result.outputs)) {
      updateWaveUnit(composeWaveId, nodeId, 'done');
    }
    for (const f of result.failed) {
      updateWaveUnit(composeWaveId, f.id, 'failed', {
        errorMessage: f.error.message.slice(0, 500),
      });
    }
    for (const nodeId of result.skipped) {
      updateWaveUnit(composeWaveId, nodeId, 'skipped');
    }
  } catch {
    // Fire-and-forget: status update failures must never abort settlement.
  }
}

/** Explicit inputs for {@link buildComposeResultContent}. */
export interface BuildComposeResultContentArgs {
  result: ComposeRunResult;
  spillSessionId: string;
  callId: string;
  parseWarnings: string[];
  usageNotice: Parameters<typeof prependUsageNotice>[0];
}

/**
 * Format the DAG result for the model, prefixing structural warnings and the
 * usage notice.
 */
export function buildComposeResultContent(args: BuildComposeResultContentArgs): string {
  const { result, spillSessionId, callId, parseWarnings, usageNotice } = args;
  // Fall back to a stable placeholder when the parent has no sessionId
  // yet (e.g. tests, or early-turn compose calls before the SDK assigns
  // one). Spill files still land in a predictable per-call directory.
  const { content: dagContent, truncations } = formatDAGResult(result, {
    sessionId: spillSessionId,
    callId,
  });
  // Prepend warnings so the model learns of any structural events that
  // would otherwise be silent: parse-time clamping (e.g. node_timeout_ms)
  // and per-node output truncation (with spill path so the parent can
  // call `read_file` to recover the full text). Truncation was historically
  // silent — the inline `… (truncated)` marker buried the loss in prose.
  // Surfacing it as a structured warning makes the data loss observable.
  const truncationWarnings = truncations.map(formatTruncationWarning);
  const allWarnings = [...parseWarnings, ...truncationWarnings];
  const warningPrefix = allWarnings.length > 0
    ? `> [compose warnings]\n${allWarnings.map((w) => `> - ${w}`).join('\n')}\n\n`
    : '';
  return prependUsageNotice(usageNotice, warningPrefix + dagContent);
}

/**
 * Drop edges that reference pre-failed (attachment-error) nodes so validateDAG
 * does not throw "Edge references non-existent node".
 */
export function filterComposeEdges<E extends { from: string; to: string }>(
  edges: E[] | undefined,
  attachmentErrors: Array<{ id: string }>,
): E[] {
  const failedNodeIds = new Set(attachmentErrors.map((e) => e.id));
  return failedNodeIds.size > 0
    ? (edges ?? []).filter((e) => !failedNodeIds.has(e.from) && !failedNodeIds.has(e.to))
    : (edges ?? []);
}
