/**
 * Source state management and pure helper functions for StreamRenderer.
 * Exports the data structures and formatting utilities that don't depend on
 * the renderer's internal state machine.
 *
 * @module cli/_lib/stream-renderer-source
 */

import type { ResponseMetadata, ToolResultChunk } from '../../agent/types/message-types.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { formatDuration, formatTokens } from '../format-utils.js';

const ORCHESTRATOR_SOURCE_KEY = '__main__';

interface SourceState {
  agentType?: string;
  /** Synthetic Agent entry's toolUseId, present only for subagent sources. */
  syntheticAgentToolUseId?: string;
  startedAt: number;
  /** Per-source aggregate stats — used to compose the Done summary line. */
  stats: {
    tokens: number;
    /**
     * Authoritative, increment-only tool-use counter. Written exclusively by
     * `tool_use_detail` event handlers (+= 1 per event). Never overwritten by
     * progress events. This is the ground-truth count for "how many tools did
     * this agent use."
     */
    toolUses: number;
    /**
     * Advisory field — stores the most recent `event.progress.toolUses` value
     * from the SDK progress event stream. Semantically distinct from `toolUses`:
     * the SDK reports iteration counts, not distinct tool_use_detail events.
     * Stored for potential future diagnostics; never used as an authoritative
     * tool-use count and never overwrites `toolUses`.
     */
    progressReportedToolUses?: number;
  };
  /**
   * Captured content. Orchestrator: used as the markdown source for non-TTY
   * rendering on done. Subagent: the live text-buffer mirrored into the
   * subagent's active TextEntry under its synthetic Agent.
   */
  contentBuffer: string;
  /**
   * Subagent only — the toolUseId of the currently active TextEntry under
   * the synthetic Agent. `undefined` between text blocks (after a tool_use
   * interrupt and before the next content delta arrives).
   */
  currentTextEntryId?: string;
  done: boolean;
  responseMetadata?: ResponseMetadata;
  errored: boolean;
  /** Timestamp (ms) of the last processed event. Used for pause-annotation staleness detection. */
  lastEventAt: number;
  /** Current pause annotation string if source is stale; undefined while active. */
  pauseAnnotation?: string;
  /**
   * Increment-only counter: number of ticks where elapsed > PAUSE_THRESHOLD_MS and
   * source is not yet done/errored. Used by checkStalledEntries for bounded stall
   * detection. At K ticks → soft label; at 2K ticks → auto-settle with synthetic result.
   */
  stalledTicks: number;
  /**
   * Per-source thinking buffer for subagents. Lazy-initialized on the first
   * thinking chunk when `thinkingMode !== 'off'`; absent otherwise so the
   * orchestrator's global lane (held on StreamRenderer) stays the only buffer
   * for the main session. Used by {@link formatDoneSummary} to append a
   * "thought Xs · Ntok" stat to the subagent's Done row.
   */
  thinkingLane?: ThinkingLane;
  /**
   * Orchestrator (main thread) only — wall-clock start of the current thinking
   * phase. Set on the first thinking chunk after a tool/prose boundary and
   * cleared when the phase is sealed into an inline "◆ thought for Xs" line
   * (see `commitThinkingPhase`). Drives per-phase duration for the TTY
   * interleaved-thinking render. Unused on non-TTY, which keeps the cumulative
   * {@link ThinkingLane.collapse} summary.
   */
  thinkingPhaseStartedAt?: number;
}

function freshSourceState(agentType: string | undefined): SourceState {
  const state: SourceState = {
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    stats: { tokens: 0, toolUses: 0 },
    contentBuffer: '',
    done: false,
    errored: false,
    stalledTicks: 0,
  };
  if (agentType !== undefined) state.agentType = agentType;
  return state;
}

function syntheticResult(content: string, isError: boolean): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'synthetic',
    content,
    isError,
  };
}

function formatDoneSummary(source: SourceState): string {
  const parts: string[] = ['Done'];
  const stats: string[] = [];
  // Reads source.stats.toolUses — the increment-only authoritative counter.
  // Never reads progressReportedToolUses (advisory only). Post-2c invariant.
  if (source.stats.toolUses) {
    stats.push(`${source.stats.toolUses} tool${source.stats.toolUses === 1 ? '' : 's'}`);
  }
  if (source.stats.tokens) stats.push(`${formatTokens(source.stats.tokens)} tok`);
  const durationMs = source.responseMetadata?.['durationMs'];
  const wallMs = Date.now() - source.startedAt;
  if (typeof durationMs === 'number') {
    stats.push(formatDuration(durationMs));
    // Wall-clock vs API-time disambiguation. When the wall-clock window for
    // this source materially exceeds the provider-reported durationMs (e.g.
    // a 2s model turn that took 5s to render due to queue/dispatch overhead),
    // surface both so the operator doesn't misread "Done (2s)" as the full
    // span. Heuristic: ≥50% delta AND ≥1s absolute gap, to avoid noise on
    // sub-second turns. Renders as `Done (2s · 5s wall)`.
    if (wallMs > durationMs * 1.5 && wallMs - durationMs >= 1000) {
      stats.push(`${formatDuration(wallMs)} wall`);
    }
  }
  if (stats.length === 0 && wallMs > 0) {
    stats.push(formatDuration(wallMs));
  }
  // Thinking summary — appended only when this source captured any thinking
  // chunks (subagent thinkingMode !== 'off'). Renders inline alongside the
  // other stats so the Done row stays one line.
  const thinkingNote = source.thinkingLane?.inlineSummary();
  if (thinkingNote) stats.push(thinkingNote);
  if (stats.length > 0) parts.push(`(${stats.join(' · ')})`);
  return parts.join(' ');
}

export {
  ORCHESTRATOR_SOURCE_KEY,
  type SourceState,
  freshSourceState,
  syntheticResult,
  formatDoneSummary,
};
