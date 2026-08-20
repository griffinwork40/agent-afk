/**
 * Plain-mode turn-level hooks for tool and subagent progress.
 *
 * Encapsulates all plain-output progress wiring so turn-handler.ts can
 * invoke a single `PlainTurnHooks` instance rather than inlining per-event
 * conditional blocks. The hooks are zero-cost in TTY mode because every
 * emitter in plain-progress.ts gates on isPlainOutputRequested() at call time.
 *
 * Wiring summary (called by turn-handler.ts at each event site):
 *   onToolStart(chunk)           — records start time for duration tracking.
 *   onToolResult(chunk, name)    — emits one-line completion (plain mode only).
 *   onSubagentEvent(event, meta) — emits start/finish lines (plain mode only).
 *   onFirstContent(stdout)       — erases the TTFB waiting line on TTY+plain.
 *
 * Note: this module does NOT import eraseWaitingLineIfNeeded from
 * turn-handler.ttfb.ts to avoid a circular module dependency (ttfb imports
 * this type; this imports TurnTtfbState). Instead, onFirstContent inlines
 * the 3-line erase sequence directly.
 */

import type { OutputEvent, SubagentProgressMeta } from '../../../agent/types.js';
import type { ToolResultChunk, ToolUseDetailChunk } from '../../../agent/types/message-types.js';
import type { CompletionWriter } from './shared.js';
import type { TurnTtfbState } from './turn-handler.ttfb.js';
import {
  createPlainProgressState,
  emitPlainToolCompletion,
  observePlainSubagentEvent,
  recordToolStart,
  type PlainProgressState,
} from './plain-progress.js';

export class PlainTurnHooks {
  private readonly state: PlainProgressState;
  private readonly writer: CompletionWriter;
  private readonly ttfb: TurnTtfbState;

  constructor(writer: CompletionWriter, ttfb: TurnTtfbState) {
    this.state = createPlainProgressState();
    this.writer = writer;
    this.ttfb = ttfb;
  }

  onToolStart(chunk: ToolUseDetailChunk): void {
    recordToolStart(this.state, chunk);
  }

  onToolResult(chunk: ToolResultChunk, toolName: string | undefined): void {
    emitPlainToolCompletion(this.state, chunk, toolName, this.writer);
  }

  onSubagentEvent(event: OutputEvent, meta: SubagentProgressMeta): void {
    observePlainSubagentEvent(this.state, event, meta, this.writer);
  }

  onFirstContent(stdout: NodeJS.WriteStream): void {
    if (!this.ttfb.waitingLineEmitted) return;
    this.ttfb.waitingLineEmitted = false;
    // `\r\x1b[2K` = carriage return + CSI Erase Line.
    stdout.write('\r\x1b[2K');
  }
}
