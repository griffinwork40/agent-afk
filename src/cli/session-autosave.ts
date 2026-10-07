/**
 * Per-turn session sidecar autosave for surfaces that do not own a REPL-style
 * stats loop (the daemon and the `afk web` session owner).
 *
 * The sidecar (`<sessions>/<id>.json`, written by `saveSession`) is what
 * `/resume` lists and names, and what the web session list titles from. The
 * REPL, one-shot `chat`, and Telegram each fold completed turns into a
 * `SessionStats` and save it; without this helper daemon and web sessions
 * wrote only their ledger and message journal, so they never appeared in
 * `/resume` even though the journal could replay them.
 *
 * Contract: nothing here throws into the caller. Persistence is best-effort
 * and must never break a daemon tick or a web turn; the FIRST failure per
 * autosaver is reported through `onError` so a persistent EACCES/ENOSPC is not
 * silently swallowed every turn.
 *
 * @module cli/session-autosave
 */

import type { ResponseMetadata } from '../agent/types/message-types.js';
import type { AgentModelInput, OutputEvent } from '../agent/types.js';
import { createSessionStats, recordTurn } from './slash/session-stats.js';
import { saveSession } from './session-store.js';
import type { SessionStats, ToolEvent } from './slash/types.js';

export interface SessionAutosaverOptions {
  model: AgentModelInput;
  source: NonNullable<SessionStats['source']>;
  cwd?: string;
  /** Known session id; otherwise taken from the first turn's metadata. */
  sessionId?: string;
  /** Fixed sidecar name; otherwise auto-derived from the first user message. */
  name?: string;
  /** Receives the first save failure only. */
  onError?: (err: unknown) => void;
}

export interface SessionAutosaver {
  readonly stats: SessionStats;
  /** Fold one COMPLETED turn into the stats and write the sidecar. Never throws. */
  saveTurn(
    userInput: string,
    assistantText: string,
    metadata: ResponseMetadata | undefined,
    toolEvents?: ToolEvent[],
  ): void;
}

export function createSessionAutosaver(opts: SessionAutosaverOptions): SessionAutosaver {
  const stats = createSessionStats(opts.model);
  stats.source = opts.source;
  if (opts.cwd !== undefined) stats.cwd = opts.cwd;
  if (opts.sessionId !== undefined) stats.sessionId = opts.sessionId;
  if (opts.name !== undefined) stats.name = opts.name;
  let reported = false;

  return {
    stats,
    saveTurn(userInput, assistantText, metadata, toolEvents) {
      try {
        recordTurn(stats, userInput, assistantText, metadata, toolEvents);
        // Keyed by session id; with none known yet the turn stays in memory and
        // is flushed by the first later turn that carries one (Telegram parity).
        if (stats.sessionId) saveSession(stats);
      } catch (err) {
        if (!reported) {
          reported = true;
          opts.onError?.(err);
        }
      }
    },
  };
}

/** What one streamed turn produced, as `saveTurn` consumes it. */
export interface CollectedTurn {
  /** True only when the turn reached its `done` event (i.e. it completed). */
  completed: boolean;
  assistantText: string;
  metadata: ResponseMetadata | undefined;
  toolEvents: ToolEvent[];
}

/**
 * Accumulates a turn's assistant text, `done` metadata, and tool events from
 * its `OutputEvent` stream: the same fields the REPL's turn handler and the
 * skill-dispatch path collect before calling `recordTurn`.
 */
export function createTurnCollector(): { observe(event: OutputEvent): void; result(): CollectedTurn } {
  const turn: CollectedTurn = { completed: false, assistantText: '', metadata: undefined, toolEvents: [] };
  const pending = new Map<string, ToolEvent>();
  return {
    observe(event) {
      if (event.type === 'message' && event.message.role === 'assistant') {
        turn.assistantText = event.message.content;
      } else if (event.type === 'done') {
        turn.completed = true;
        turn.metadata = event.metadata;
      } else if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
        const c = event.chunk;
        const te: ToolEvent = { toolName: c.toolName, toolUseId: c.toolUseId, input: c.toolInput };
        pending.set(c.toolUseId, te);
        turn.toolEvents.push(te);
      } else if (event.type === 'chunk' && event.chunk.type === 'tool_result') {
        const te = pending.get(event.chunk.toolUseId);
        if (te) {
          te.result = event.chunk.content;
          te.isError = event.chunk.isError;
          pending.delete(event.chunk.toolUseId);
        }
      }
    },
    result: () => turn,
  };
}
