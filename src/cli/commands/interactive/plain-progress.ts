/**
 * Plain-output-mode progress emitter.
 *
 * In plain/non-TTY mode the terminal compositor is never armed, so ALL
 * tool-call and subagent-progress feedback rendered via the compositor
 * overlay (tool-lane, progress-banner) is silently dropped. This module
 * bridges that gap by emitting compact one-line progress events to the
 * `CompletionWriter` sink for plain-mode sessions ONLY.
 *
 * Design rules:
 *   - Completion lines only for tools (no start lines — avoids flooding).
 *   - Start + finish lines for subagents (lifecycle events matter).
 *   - Plain lines only — no ANSI cursor movement. Piped output stays clean.
 *   - All palette calls via `palette.*`, never raw chalk (CI gate enforced).
 *   - All env reads via the typed `env` object (CI gate enforced).
 *
 * Event sources: hook points are wired by {@link createPlainProgressHooks}
 * in `turn-handler.ts` at the `tool_use_detail` / `tool_result` chunk events
 * and the ambientSink for subagent lifecycle. The main exports are the
 * per-turn state bag and the three hook callbacks.
 */

import type { OutputEvent, SubagentProgressMeta } from '../../../agent/types.js';
import type { ToolResultChunk, ToolUseDetailChunk } from '../../../agent/types/message-types.js';
import { isPlainOutputRequested } from '../../../config/env.js';
import { formatDuration } from '../../format-utils.js';
import { palette } from '../../palette.js';
import { sanitizeLabel } from './tool-lane-format-sanitize.js';
import type { CompletionWriter } from './shared.js';

// ---------------------------------------------------------------------------
// Per-turn state
// ---------------------------------------------------------------------------

/** Per-turn mutable state for the plain progress tracker. */
export interface PlainProgressState {
  /** toolUseId → startedAt ms */
  readonly toolStartTimes: Map<string, number>;
  /** subagentId → startedAt ms (first event seen for that id) */
  readonly subagentStartTimes: Map<string, number>;
  /** subagentId → resolved label (from first SubagentProgressMeta seen) */
  readonly subagentLabels: Map<string, string>;
}

export function createPlainProgressState(): PlainProgressState {
  return {
    toolStartTimes: new Map(),
    subagentStartTimes: new Map(),
    subagentLabels: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tool hook: start recording
// ---------------------------------------------------------------------------

/**
 * Record a tool start so we can compute duration on completion.
 * Safe to call unconditionally — no-ops when plain output is not requested.
 */
export function recordToolStart(
  state: PlainProgressState,
  chunk: ToolUseDetailChunk,
): void {
  if (!isPlainOutputRequested()) return;
  if (chunk.pending) return; // placeholder; real chunk follows
  if (!state.toolStartTimes.has(chunk.toolUseId)) {
    state.toolStartTimes.set(chunk.toolUseId, Date.now());
  }
}

// ---------------------------------------------------------------------------
// Tool hook: completion line
// ---------------------------------------------------------------------------

/**
 * Emit a one-line tool-completion event in plain mode.
 *
 * Format: `  ◦ <ToolName> · <duration> · ok|err`
 *
 * Safe to call unconditionally — no-ops when plain output is not requested.
 */
export function emitPlainToolCompletion(
  state: PlainProgressState,
  chunk: ToolResultChunk,
  toolName: string | undefined,
  writer: CompletionWriter,
): void {
  if (!isPlainOutputRequested()) return;
  const startedAt = state.toolStartTimes.get(chunk.toolUseId);
  const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
  state.toolStartTimes.delete(chunk.toolUseId);
  const name = sanitizeLabel(toolName ?? 'tool');
  const status = chunk.isError ? palette.error('err') : palette.success('ok');
  const durationStr = durationMs !== undefined ? ` · ${formatDuration(durationMs)}` : '';
  writer.fn(palette.dim(`  ◦ ${name}${durationStr} · `) + status);
}

// ---------------------------------------------------------------------------
// Subagent hook: start + finish lines
// ---------------------------------------------------------------------------

/**
 * Observe a subagent event from the ambient sink and emit start/finish lines.
 *
 * - First event from a new subagentId → emit a "started" line.
 * - `done` or `error` event → emit a "finished" line.
 *
 * Safe to call unconditionally — no-ops when plain output is not requested.
 */
export function observePlainSubagentEvent(
  state: PlainProgressState,
  event: OutputEvent,
  meta: SubagentProgressMeta,
  writer: CompletionWriter,
): void {
  if (!isPlainOutputRequested()) return;
  const { subagentId, agentType } = meta;
  const label = sanitizeLabel(agentType ?? subagentId);
  if (!state.subagentStartTimes.has(subagentId)) {
    state.subagentStartTimes.set(subagentId, Date.now());
    state.subagentLabels.set(subagentId, label);
    writer.fn(palette.dim(`  ◦ helper ${label} started`));
  }
  const isTerminal = event.type === 'done' || event.type === 'error';
  if (isTerminal) {
    const startedAt = state.subagentStartTimes.get(subagentId);
    const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
    state.subagentStartTimes.delete(subagentId);
    state.subagentLabels.delete(subagentId);
    const durationStr = durationMs !== undefined ? ` · ${formatDuration(durationMs)}` : '';
    const statusStr = event.type === 'error' ? palette.error('failed') : palette.success('done');
    writer.fn(palette.dim(`  ◦ helper ${label}${durationStr} · `) + statusStr);
  }
}
