/**
 * Turn completion / terminal-state logic extracted from turn-handler.ts.
 *
 * Handles everything that happens *after* the stream loop finishes:
 *   1. Strip the terminal-state prose from the pending buffer (suppressVerdictCard)
 *   2. Dispose the renderer
 *   3. Soft-stop notice
 *   4. Pause-interrupt notice
 *   5. The doneFired block: recordTurn, bells, verdict card, footer, onAfterTurn
 *
 * Extracted to keep turn-handler.ts within its code-line ceiling.
 *
 * @module cli/commands/interactive/turn-handler.completion
 */

import type { SessionStats, ToolEvent } from '../../slash/types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { CompletionWriter, TurnHandles } from './shared.js';
import type { StreamEventState } from './turn-handler.stream-events.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';
import type { StreamRenderer } from '../../_lib/stream-renderer.js';
import { recordTurn } from '../../slash/session-stats.js';

// ─── Content block builders ───────────────────────────────────────────────────

/**
 * Build `ContentBlockParam[]` for the assistant message from the accumulated
 * response text and tool events.
 *
 * Only emitted when meaningful — i.e. the turn has tool_use blocks (so the
 * structured path carries semantic value beyond plain text). Text-only turns
 * skip blocks entirely to keep sidecar size reasonable.
 *
 * Structure per the Anthropic Messages API:
 *   - One `text` block (when responseText is non-empty)
 *   - One `tool_use` block per completed tool event (no pending tools)
 *
 * The corresponding `tool_result` blocks belong in the NEXT user message, not
 * here. `resumeHistoryToMessages` will read the next TurnRecord's
 * `userContentBlocks` to satisfy that side of the pairing.
 */
export function buildAssistantContentBlocks(
  responseText: string,
  toolEvents: ToolEvent[],
): ContentBlockParam[] | undefined {
  const completedToolUses = toolEvents.filter((te) => te.result !== undefined);
  // Only emit blocks when there are tool_use calls — preserves sidecar brevity
  // for simple text turns while capturing the semantically rich mixed turns.
  if (completedToolUses.length === 0) return undefined;

  const blocks: ContentBlockParam[] = [];
  if (responseText.trim().length > 0) {
    blocks.push({ type: 'text', text: responseText });
  }
  for (const te of completedToolUses) {
    let parsedInput: Record<string, unknown> = {};
    if (te.inputRaw) {
      try { parsedInput = JSON.parse(te.inputRaw) as Record<string, unknown>; } catch { /* leave empty */ }
    } else if (te.input) {
      try { parsedInput = JSON.parse(te.input) as Record<string, unknown>; } catch { /* leave empty */ }
    }
    blocks.push({ type: 'tool_use', id: te.toolUseId, name: te.toolName, input: parsedInput });
  }
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Build `ContentBlockParam[]` for the user message when the turn included
 * tool results from the previous assistant turn's tool_use blocks.
 *
 * In a tool-use turn, the *user* side of the exchange carries `tool_result`
 * blocks corresponding to each tool_use the assistant emitted. These are
 * stored on the TurnRecord that *follows* the tool_use turn, which is why
 * callers must pass in the tool events from the preceding assistant turn.
 *
 * For turns with no tool results (plain text exchange), returns `undefined`
 * so the text fallback path is used instead.
 */
export function buildUserContentBlocks(
  userText: string,
  toolEvents: ToolEvent[],
): ContentBlockParam[] | undefined {
  const completedToolUses = toolEvents.filter((te) => te.result !== undefined);
  if (completedToolUses.length === 0) return undefined;

  const blocks: ContentBlockParam[] = [];
  if (userText.trim().length > 0) {
    blocks.push({ type: 'text', text: userText });
  }
  for (const te of completedToolUses) {
    blocks.push({
      type: 'tool_result',
      tool_use_id: te.toolUseId,
      content: te.result ?? '',
      ...(te.isError ? { is_error: true } : {}),
    });
  }
  return blocks.length > 0 ? blocks : undefined;
}
import { palette } from '../../palette.js';
import {
  ringBellIfEnabled,
  notifyIfEnabled,
} from '../../_lib/capture-mode.js';
import { parseTerminalState, findTerminalStateHeadingOffset, type TerminalState } from './terminal-state.js';
import { renderVerdictCard } from './verdict-card.js';
import { pushTerminalStateToTelegram, doneHasCorroboratingEvidence, classifyDoneEvidence } from './afk-push.js';
import { loadTelegramConfig } from '../../config.js';
import { printTurnFooter, printTurnSeparator } from './turn-handler.footer.js';

// ─── Context ─────────────────────────────────────────────────────────────────

/** Everything the post-stream completion block needs from `runTurn`. */
export interface TurnCompletionContext {
  state: StreamEventState;
  stats: SessionStats;
  h: TurnHandles;
  toolEvents: ToolEvent[];
  historyText: string;
  /** Pre-computed by `buildAssistantContentBlocks` in `runTurn`. */
  assistantBlocks: ContentBlockParam[] | undefined;
  /** Pre-computed by `buildUserContentBlocks` (or raw structured payload). */
  userBlocks: ContentBlockParam[] | undefined;
  completionWriter: CompletionWriter | undefined;
  /** Borrowed REPL compositor, or `null` on non-TTY paths. */
  borrowedCompositor: TerminalCompositor | null;
  /** Live renderer — used to strip the pending terminal-state prose. */
  renderer: StreamRenderer;
  /** Idempotent disposal (owned by `runTurn`). */
  disposeRendererOnce: () => Promise<void>;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * Execute the post-stream completion block for a turn.
 * Called from within the `try` block of `runTurn` after `runWithSink` resolves.
 * The `catch` and `finally` blocks remain in `runTurn`.
 */
export async function handleTurnCompletion(ctx: TurnCompletionContext): Promise<void> {
  const {
    state, stats, h, toolEvents, historyText, assistantBlocks, userBlocks,
    completionWriter, borrowedCompositor, renderer, disposeRendererOnce,
  } = ctx;

  // Strip the terminal-state prose from the pending buffer BEFORE dispose
  // flushes it — the verdict card is the sole rendering. When the block was
  // already committed to scrollback (pending buffer empty, no strip), suppress
  // the card to avoid a double-render. See #1407.
  let suppressVerdictCard = false;
  if (state.doneFired && !state.softStopRequested && !state.pauseInterruptRequested) {
    const off = findTerminalStateHeadingOffset(renderer.getPendingBuffer());
    if (off >= 0) {
      renderer.stripPendingTerminalState(off);
    } else if (parseTerminalState(state.responseText) !== null) {
      suppressVerdictCard = true;
    }
  }

  await disposeRendererOnce();

  // Invariant: ESC soft-stop intent OVERRIDES stream completion (including a
  // late-ESC race where doneFired=true and softStopRequested=true together).
  // Both cases render the notice and suppress the completed-turn path.
  // (/resume operates on OTHER saved sessions — must NOT be advertised here;
  // see terminal-compositor.types.ts: "next Enter starts a new turn in the
  // same session." — /resume must NOT be advertised here.)
  const writeNotice = completionWriter ? completionWriter.fn : console.log;

  if (state.softStopRequested) {
    const queuedCount = borrowedCompositor ? borrowedCompositor.getPendingCount() : 0;
    const queuedSuffix = queuedCount > 0 ? ` · ${queuedCount} queued` : '';
    // TUI rhythm: owns ONE trailing blank; predecessor owns its own.
    writeNotice(palette.warning(`⏸ Stopped${queuedSuffix} — work so far kept.`) +
      palette.dim('  Send a message to continue.'));
    writeNotice('');
  }

  // Pause-interrupt: user submitted a line during usage-limit pause — queue
  // flushes as the next turn at readLine's idle-transition.
  if (state.pauseInterruptRequested) {
    writeNotice(palette.dim('▶ Ending wait — running your next command…'));
    writeNotice('');
  }

  if (state.doneFired && !state.softStopRequested && !state.pauseInterruptRequested) {
    recordTurn(stats, historyText, state.responseText, state.doneMeta, toolEvents, userBlocks, assistantBlocks);
    await h.onTurnComplete?.(historyText, state.responseText).catch(() => { /* best-effort */ });

    // Bell (AFK_BELL=1) and desktop notification (AFK_NOTIFY=1, OSC 9):
    // clean-completion-only — misleading after soft-stop or error.
    ringBellIfEnabled(process.stdout);
    notifyIfEnabled(process.stdout, 'afk: turn complete');

    // Post-dispose writes still run against the borrowed compositor (still
    // armed in idle mode — surface owns disarm). Route through completionWriter.
    const writeAbove = (line: string): void => {
      if (completionWriter) { completionWriter.fn(line); } else { console.log(line); }
    };

    // Verdict card: parse the terminal state from the response text and
    // render it as a first-class card before the cost/token footer.
    const verdict: TerminalState | null = parseTerminalState(state.responseText);
    if (verdict && !suppressVerdictCard) {
      writeAbove(renderVerdictCard(verdict, {
        durationMs: state.doneMeta?.durationMs,
        totalCostUsd: state.doneMeta?.totalCostUsd,
        toolCount: toolEvents.length,
      }));
      writeAbove('');
      // Two evidence values: boolean (corroboration) → Telegram label;
      // three-state (verification) → terminal-state gate injection.
      const evidenceClassification = classifyDoneEvidence(toolEvents);
      const hasCorroboratingEvidence = doneHasCorroboratingEvidence(toolEvents);
      if (h.onTerminalState) {
        try {
          h.onTerminalState(verdict, { doneHasCorroboratingEvidence: hasCorroboratingEvidence, doneEvidenceClassification: evidenceClassification });
        } catch { /* ledger update is best-effort */ }
      }
      // AFK mode: push terminal state to Telegram. Fire-and-forget.
      if (stats.permissionMode === 'autonomous') {
        const unverified =
          verdict.kind === 'done' &&
          loadTelegramConfig().verifyDone === true &&
          !hasCorroboratingEvidence;
        void pushTerminalStateToTelegram(verdict, undefined, { unverified });
      }
    }

    printTurnFooter(state.doneMeta, stats, writeAbove);
    printTurnSeparator(writeAbove, process.stdout);

    if (h.onAfterTurn) {
      const result = h.onAfterTurn();
      if (result instanceof Promise) {
        await result.catch(() => { /* best-effort */ });
      }
    }
  }
}
