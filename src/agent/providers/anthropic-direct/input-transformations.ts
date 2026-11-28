// Contract: Observe thinking_dropped entries from message_start and message_delta.
// thinking_mismatch_allowed and unknown types are not drops. Never record paths,
// thinking text, or signatures. Every drop-bearing frame is traced, even when
// its console notice is suppressed by per-stream or per-session deduplication.

import { emitSessionPhase } from '../../trace/emit.js';
import type { TraceSink } from '../../trace/index.js';

const REASON_DESCRIPTIONS = new Map([
  ['prefix_binding_mismatch', 'the request context changed (system prompt, tools, or earlier messages)'],
  ['model_binding_mismatch', 'the model changed'],
  ['organization_binding_mismatch', 'the account changed'],
]);

// FIFO retention bounds process memory. An evicted session may be notified again
// if revisited after 4096 other sessions have received notices; no global log cap.
const MAX_NOTIFIED_SESSIONS = 4096;
const notifiedSessions = new Set<string>();

type DropSummary = {
  droppedCount: number;
  reasonCounts: Record<string, number>;
};

/** Shared filtering and tally for both first-frame and already-warned paths. */
function summarizeDrops(transformations: unknown): DropSummary {
  const reasonCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  let droppedCount = 0;
  if (!Array.isArray(transformations)) return { droppedCount, reasonCounts };
  for (const entry of transformations) {
    if (typeof entry !== 'object' || entry === null || entry['type'] !== 'thinking_dropped') continue;
    droppedCount++;
    // Preserve searchable future reason codes, but not arbitrary untrusted text.
    // The bounded identifier alphabet also keeps console notices on one line.
    const raw: unknown = entry['reason'];
    const reason = typeof raw === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(raw)
      ? raw : 'unknown_reason';
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  return { droppedCount, reasonCounts };
}

/** Returns whether this frame carries drops; tracing is independent of notices. */
export function warnOnDroppedThinkingBlocks(
  transformations: unknown,
  source: 'message_start' | 'message_delta',
  sessionId: string,
  traceWriter?: TraceSink,
  alreadyWarned = false,
): boolean {
  const { droppedCount, reasonCounts } = summarizeDrops(transformations);
  if (droppedCount === 0) return false;

  if (traceWriter) {
    // Flat numeric fields fit session_phase metadata and scalar witness where filters.
    const metadata: Record<string, string | number> = { droppedCount, source };
    for (const [reason, count] of Object.entries(reasonCounts)) metadata[`reason_${reason}`] = count;
    void emitSessionPhase(traceWriter, { phase: 'thinking_block_dropped', metadata });
  }

  if (alreadyWarned || notifiedSessions.has(sessionId)) return true;
  if (notifiedSessions.size >= MAX_NOTIFIED_SESSIONS) {
    const oldest = notifiedSessions.values().next().value;
    if (oldest !== undefined) notifiedSessions.delete(oldest);
  }
  notifiedSessions.add(sessionId);

  const reasonSummary = Object.entries(reasonCounts).map(([reason, count]) =>
    `${REASON_DESCRIPTIONS.get(reason) ?? 'reason not recognised'} [${count} ${reason}]`,
  ).join('; ');
  console.warn(
    `[afk] Earlier reasoning from ${droppedCount} thinking block(s) was not available to the model ` +
    `on this request because ${reasonSummary}. AFK continued normally and no action is needed. ` +
    'Further omissions in this session are recorded in the trace only.',
  );
  return true;
}

/** @internal Reset notice retention for isolated tests only. */
export function _resetNotifiedSessionsForTest(): void {
  notifiedSessions.clear();
}
