/**
 * Progress event handling for the Telegram streaming handler
 *
 * `handleProgressEvent` and `handleSubagentSink` extracted from `streamResponse`
 * in streaming.ts. Each takes an explicit state bag and callback parameters rather
 * than closing over the outer scope, mirroring the pattern in
 * `src/agent/session/stream-consumer.ts`.
 * Extracted from streaming.ts — the public surface of streaming.ts is unchanged.
 * @module telegram/streaming.progress
 */

import type { Context } from 'telegraf';
import type { OutputEvent, SubagentProgressMeta } from '../agent/types.js';
import { formatTelegramAgentLabel, humanizeToolActivity, MAX_SUBAGENT_PREVIEW_LINES } from './streaming.activity.js';
import { sendOrEdit } from './streaming.sender.js';
import type { SenderState } from './streaming.sender.js';
import { formatTelegramActivity } from './streaming.activity.js';
import { MAX_PROGRESS_ENTRIES } from './streaming.preview.js';
import type { ProgressEntry } from './streaming.preview.js';
import { armProgressGateTimer } from './streaming.watchdog.js';

/**
 * Mutable state slice for progress and subagent tracking. A subset of
 * `StreamState` from `streaming.handlers.ts`, kept separate so progress
 * helpers remain independently testable.
 */
export interface ProgressState extends SenderState {
  accumulated: string;
  progressEntries: ProgressEntry[];
  progressRounds: number;
  progressTimer: ReturnType<typeof setTimeout> | null;
  turnEnded: boolean;
  editInFlight: boolean;
  turnStartedAt: number;
}

/**
 * Handle a `progress` event from the provider.
 *
 * Records the `◦` tool-progress line, enforces the rolling cap, and renders
 * it (or arms the latency gate timer) based on `progressGateOpen`.
 *
 * Invariant: `inContentRun = false` is NOT cosmetic and must stay unconditional
 * — it is the `stream_retry` round boundary. Skipping it (e.g. by returning
 * early when progress rendering is gated off) leaves the snapshot at an older
 * offset and a later `stream_retry` truncates MORE of `answerText` than the
 * retry produced — silently deleting already-delivered answer text.
 * Gate the RENDER, never this line.
 */
export async function handleProgressEvent(
  event: {
    progress: {
      description?: string;
      lastToolName?: string;
    };
  },
  state: ProgressState,
  progressGateOpen: boolean,
  progressDelayMs: number,
  ctx: Context,
  chatId: number,
  livePreview: () => string,
  setProgressGateOpen: (v: boolean) => void,
  clearProgressTimer: () => void,
): Promise<void> {
  state.progressRounds++;
  const { description, lastToolName } = event.progress;
  // Telegram is a compact chat surface, not a terminal. Prefer a short
  // activity category for generic progress and intentionally omit the
  // summary, which routinely contains commands, URLs, and local paths.
  // formatTelegramActivity keeps the field-scoped hardening these
  // model-controlled fields require (sanitizeLabel on both description
  // and tool name) because markdownToTelegramHtml does not strip
  // ANSI/C1/control bytes — same contract as the CLI banner
  // (tool-lane-format-sanitize.ts).
  const line = `◦ ${formatTelegramActivity(description, lastToolName)}`;
  // Record first, render second: a line withheld by the latency gate is
  // still retained, so when the gate opens — by a later event OR by the
  // timer armed below — the bounded region shows the most recent rounds.
  // The list is global and capped, so the bound holds across a stream
  // that interleaves content with tool rounds, not just within one run.
  // Repeated tool categories add no information to a rolling mobile
  // preview: count every round for the receipt, but render duplicates once.
  //
  // Ordering constraint (externally governed by the provider's event
  // order): `at` must be sampled from `accumulated` BEFORE any later
  // content chunk of the NEXT round is appended. A `progress` event is
  // emitted only after a round's text deltas are complete — the
  // anthropic-direct loop yields it after `turnResult` is resolved, the
  // openai-compatible loop after `runIteration` returns — so sampling
  // here lands exactly on the boundary between two rounds of narration.
  // Deferring the sample would place the line inside the following round's
  // prose.
  if (state.progressEntries[state.progressEntries.length - 1]?.label !== line) {
    state.progressEntries.push({ label: line, at: state.accumulated.length });
  }
  if (state.progressEntries.length > MAX_PROGRESS_ENTRIES) {
    state.progressEntries = state.progressEntries.slice(-MAX_PROGRESS_ENTRIES);
  }
  if (!progressGateOpen && Date.now() - state.turnStartedAt >= progressDelayMs) {
    setProgressGateOpen(true);
    progressGateOpen = true;
  }
  if (progressGateOpen) {
    clearProgressTimer();
    await sendOrEdit(state, ctx, chatId, livePreview());
  } else if (state.progressTimer === null) {
    // Invariant: the gate must be able to open with NO further stream
    // event. Checking it only on the next `progress` event means one tool
    // that runs silently past the delay leaves the user on `Thinking…`
    // for its entire duration. Arm a one-shot timer for the remaining
    // wait; it is cleared on every terminal path and in the finally.
    state.progressTimer = armProgressGateTimer(
      progressDelayMs - (Date.now() - state.turnStartedAt),
      () => {
        state.progressTimer = null;
        setProgressGateOpen(true);
        if (state.editInFlight) return;
        state.editInFlight = true;
        void sendOrEdit(state, ctx, chatId, livePreview(), true).finally(() => { state.editInFlight = false; });
      },
      () => state.turnEnded,
      () => state.editInFlight,
    );
  }
}

/**
 * Build the subagent-sink callback for one streaming turn.
 *
 * Converts child-agent events into Telegram-visible annotations on the
 * accumulated message. Without this, subagent events are silently dropped
 * because no ambient sink is set. Returns the sink function.
 */
export function makeSubagentSink(
  state: SenderState,
  ctx: Context,
  chatId: number,
  livePreview: () => string,
  bumpActivity: () => void,
  subagentState: {
    subagentSteps: number;
    recentSubagentSteps: string[];
  },
): (event: OutputEvent, meta: SubagentProgressMeta) => void {
  return (event: OutputEvent, meta: SubagentProgressMeta): void => {
    const label = formatTelegramAgentLabel(meta.agentType ?? meta.subagentId);
    // Sub-agent activity keeps the turn alive: bump the watchdog so deep
    // fan-out (silent on the parent stream) does not trip a false timeout.
    bumpActivity();
    if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
      // Bounded: count every step but retain only the most recent few lines,
      // rendered as a compact footer rather than one appended line per call.
      // Never include toolInput: even summarized input commonly contains raw
      // commands and private filesystem paths that are poor mobile UI.
      subagentState.subagentSteps++;
      subagentState.recentSubagentSteps.push(`${label} — ${humanizeToolActivity(event.chunk.toolName)}`);
      if (subagentState.recentSubagentSteps.length > MAX_SUBAGENT_PREVIEW_LINES) {
        subagentState.recentSubagentSteps.shift();
      }
      void sendOrEdit(state, ctx, chatId, livePreview());
    } else if (event.type === 'done') {
      // A child finishing refreshes the footer but must not grow the buffer.
      void sendOrEdit(state, ctx, chatId, livePreview());
    }
  };
}
