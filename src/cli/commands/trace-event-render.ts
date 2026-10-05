/**
 * Per-event rendering for `afk trace show`.
 *
 * Converts a single `TraceEvent` to a terse human-readable line (or `null`
 * when the event is filtered out of the default view). Extracted from
 * `trace.ts` to keep each module within the 350-line budget.
 *
 * @module cli/commands/trace-event-render
 */

import { fmtBytes, fmtDuration, fmtTime, fmtUsd, label, truncate } from './trace-format.js';
import { renderSecondaryEvent } from './trace-peer-format.js';
import { renderSessionPhase } from './trace-phase-render.js';
import { renderSubagentLifecycle, renderBackgroundAgent } from './trace-lifecycle-render.js';
import { withToolResult } from './trace-results.js';
import { formatCacheUsage } from './trace-usage-format.js';
import type { TraceEvent } from '../../agent/trace/index.js';
import { sanitizeForDisplay } from '../../utils/terminal-sanitize.js';

// ---------------------------------------------------------------------------
// Rendering context
// ---------------------------------------------------------------------------

export interface RenderContext {
  /** toolUseIds that have a `completed` record — used to detect orphaned
   *  `started` events (a tool that began but never returned). */
  completedToolIds: Set<string>;
  /** Include low-signal events (session_phase) and paired tool `started`
   *  lines that have a matching completion. */
  showAll: boolean;
}

/** Re-export so callers that use the result type don't need a separate import. */
export { withToolResult };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a redacted error-head snippet for a completed tool_call line.
 *  Returns an empty string when the call succeeded or errorHead is absent. */
function fmtErrorHead(isError: boolean, head: string | undefined): string {
  return isError && head ? `  "${truncate(sanitizeForDisplay(head), 120)}"` : '';
}

// ---------------------------------------------------------------------------
// renderEvent
// ---------------------------------------------------------------------------

/**
 * Render one event to a human line, or `null` when the event is filtered
 * out of the default view. The detail text per kind is deliberately terse
 * — this is a "what happened" scan, not a full dump (use `--json` for that).
 */
export function renderEvent(event: TraceEvent, ctx: RenderContext): string | null {
  const time = fmtTime(event.ts);
  const line = (kind: string, detail: string): string =>
    `  ${time}  ${label(kind)}  ${detail}`;

  switch (event.kind) {
    case 'tool_call': {
      const p = event.payload;
      if (p.phase === 'started') {
        // An orphaned `started` (no matching `completed`) means the call
        // never returned — a crash or abort mid-tool. Surface only orphans
        // by default; with --all, show every started line too.
        const orphan = !ctx.completedToolIds.has(p.toolUseId);
        if (!ctx.showAll && !orphan) return null;
        const sub = p.subagentId ? `  [${p.subagentId}]` : '';
        const note = orphan ? 'started (no completion recorded)' : 'started';
        return line('tool', `${p.name}  ${note}${sub}`);
      }
      const status = p.isError ? 'ERR' : 'ok';
      const trunc = p.truncated ? '  (truncated)' : '';
      const sub = p.subagentId ? `  [${p.subagentId}]` : '';
      return line('tool', `${p.name}  ${status}  ${fmtDuration(p.durationMs)}  ${fmtBytes(p.resultBytes)}${trunc}${sub}${fmtErrorHead(p.isError, p.errorHead)}`);
    }

    case 'hook_decision': {
      const p = event.payload;
      if (p.decision === undefined) return null; // all handlers passed — noise
      if (p.decision === 'block') {
        const tool = p.blockedTool ? ` ${p.blockedTool}` : '';
        const reason = p.reason ? `  (${truncate(p.reason, 80)})` : '';
        return line('hook', `BLOCK ${p.hookEvent}${tool}${reason}`);
      }
      const reason = p.reason ? `  (${truncate(p.reason, 80)})` : '';
      return line('hook', `approve ${p.hookEvent}${reason}`);
    }

    case 'subagent_lifecycle':
      return renderSubagentLifecycle(event.payload, line);

    case 'background_agent':
      return renderBackgroundAgent(event.payload, line);

    case 'abort': {
      const p = event.payload;
      const reason = p.reason ? `  ${truncate(p.reason, 80)}` : '';
      const cascade = p.cascadedTo.length > 0 ? `  cascaded→${p.cascadedTo.length}` : '';
      return line('abort', `${p.origin}${reason}${cascade}`);
    }

    case 'compaction': {
      const p = event.payload;
      const saved =
        p.tokensSavedEstimate !== undefined ? `  ~${p.tokensSavedEstimate} tokens saved` : '';
      return line('compact', `${p.trigger}  ${p.messagesBefore}→${p.messagesAfter} msgs${saved}`);
    }

    case 'closure': {
      const p = event.payload;
      const guidance = p.guidance ? `  — ${truncate(p.guidance, 100)}` : '';
      // Surface the raw provider stop_reason (e.g. `refusal`, `max_tokens`)
      // alongside the AFK-classified closure reason. It is already persisted
      // on the closure event but was previously unrendered — leaving silent
      // stops (a turn that ends with no output and no error) diagnosable only
      // by reading the raw trace.jsonl. See docs: silent-model-loop debugging.
      const stop = p.lastStopReason ? `  stop=${p.lastStopReason}` : '';
      // Prompt-cache hit rate was recorded but never rendered — see
      // trace-usage-format.ts for why that made cache regressions invisible.
      const cache = formatCacheUsage(p.finalTokens);
      return line(
        'closure',
        `${p.reason}  turns=${p.finalTurnCount}${stop}  ${fmtUsd(p.finalCostUsd)}${cache}${guidance}`,
      );
    }

    case 'claim': {
      const p = event.payload;
      return line(
        'claim',
        `[${p.source}] "${truncate(p.assertion, 80)}"  conf=${p.confidence}  ${p.evidence.length} evidence`,
      );
    }

    case 'browser_event': {
      const p = event.payload;
      const action = p.action ? ` ${p.action}` : '';
      const url = p.urlAfter ? `  ${p.urlAfter}` : '';
      return line('browser', `${p.tool}${action}  ${p.status}${url}`);
    }

    case 'budget': {
      const p = event.payload;
      return line('budget', `${p.kind}  ${fmtUsd(p.runningCostUsd)}/${fmtUsd(p.maxBudgetUsd)}`);
    }

    case 'session_phase':
      return renderSessionPhase(event.payload, ctx.showAll, line);

    case 'session_sealed': {
      const p = event.payload;
      const subs = p.subagentCount ? `  ${p.subagentCount} subagents` : '';
      return line(
        'SEALED',
        `${p.status}  turns=${p.finalTurnCount}  ${fmtUsd(p.finalCostUsd)}${subs}  (closed ${p.closedAt})`,
      );
    }

    default:
      // peer_message + forward-compatible rendering of unknown future kinds.
      return renderSecondaryEvent(event, line);
  }
}
