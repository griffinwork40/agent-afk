import type { Message, IAgentSession, OutputEvent } from '../types.js';
import { emitSubagentLifecycle } from '../trace/emit.js';
import type { SubagentHandleImpl } from './handle.js';
import { TOOL_USE_LOOP_CAPPED } from '../providers/shared/tool-loop-cap.js';

/** Advisory classifier, deliberately narrow: never discard a multiline findings report. */
export function isNarrationOnly(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 300 && !trimmed.includes('\n') &&
    /^(?:(?:okay|sure|alright|right|great|so|well|yes)[,.]?\s+)?(?:now\s+)?(?:let me|i(?:'ll| will| am going to))\b/i.test(trimmed) &&
    /\b(?:write|check|read|return|create|finish|prepare|summarize)\b/i.test(trimmed);
}

/** Bounded to one previous assistant text and the current round; never reads journals or tool results. */
export class CappedHandoffAccumulator {
  private priorText = '';
  private roundText = '';
  private lastMessage: Message | undefined;
  private roundsUsed: number | undefined;
  private budget: number | undefined;
  /** History length at construction time — bounds the backward walk in finish() to this turn only. */
  private historyLengthAtStart = 0;

  /** Call once at the start of a turn to prevent cross-turn history leakage when a handle is reused. */
  setHistoryBaseline(length: number): void {
    this.historyLengthAtStart = length;
  }

  onEvent(event: OutputEvent): void {
    if (event.type === 'chunk' && event.chunk.type === 'content') this.roundText += event.chunk.content;
    if (event.type === 'stream_retry') this.roundText = '';
    if (event.type === 'progress' && typeof event.progress.roundsUsed === 'number') {
      this.roundsUsed = event.progress.roundsUsed;
      this.budget = event.progress.budget;
      if (this.roundText.trim() && !isNarrationOnly(this.roundText)) this.priorText = this.roundText;
      this.roundText = '';
    }
    if (event.type === 'message') {
      if (!this.priorText && this.lastMessage?.content.trim() && !isNarrationOnly(this.lastMessage.content)) {
        this.priorText = this.lastMessage.content;
      }
      this.lastMessage = event.message;
    }
  }

  finish(finalMessage: Message | undefined, session: IAgentSession): Message {
    const history = session.getHistory?.() ?? [];
    let historyText = '';
    for (let i = history.length - 1; i >= this.historyLengthAtStart; i--) {
      const m = history[i];
      if (m?.role === 'assistant' && m.content.trim() && !isNarrationOnly(m.content) && m !== finalMessage) {
        historyText = m.content;
        break;
      }
    }
    // Renderer parentId can be a compose tool id, not the journal's root session id.
    const journalPath = session.messageJournal?.path;
    return salvageCappedMessage(finalMessage, this.roundText, this.priorText || historyText || '', {
      ...(this.roundsUsed !== undefined && { roundsUsed: this.roundsUsed }),
      ...(this.budget !== undefined && { budget: this.budget }),
      ...(journalPath !== undefined && { journalPath }),
    });
  }
}

/** Invariant: await the lifecycle receipt before onTerminal can seal the trace. */
export async function emitSuccessfulHandoff<T>(handle: SubagentHandleImpl<T>, message: Message, startTime: number): Promise<void> {
  await emitSubagentLifecycle(handle._traceWriter, {
    transition: 'succeeded',
    subagentId: handle.id,
    durationMs: Date.now() - startTime,
    turnCount: handle._currentTrace.turnCount,
    outputBytes: Buffer.byteLength(message.content, 'utf8'),
    ...(handle._lastStopReason !== undefined && { stopReason: handle._lastStopReason }),
    ...cappedHandoffFields(message, handle._lastStopReason),
  });
}

export interface CappedHandoff {
  incomplete: true;
  incompleteReason: typeof TOOL_USE_LOOP_CAPPED;
  roundsUsed?: number;
  budget?: number;
  journalPath?: string;
  salvaged?: true;
}

/** Only capped turns acquire this metadata; a normal completion stays byte compatible. */
export function cappedHandoffFields(message: Message, stopReason: string | undefined): Partial<CappedHandoff> {
  if (stopReason !== TOOL_USE_LOOP_CAPPED) return {};
  const meta = message.metadata;
  return {
    incomplete: true,
    incompleteReason: TOOL_USE_LOOP_CAPPED,
    ...(typeof meta?.['roundsUsed'] === 'number' && { roundsUsed: meta['roundsUsed'] }),
    ...(typeof meta?.['budget'] === 'number' && { budget: meta['budget'] }),
    ...(typeof meta?.['journalPath'] === 'string' && { journalPath: meta['journalPath'] }),
    ...(meta?.['salvaged'] === true && { salvaged: true }),
  };
}

/** Preserve findings without pretending that prior reasoning is a verified final answer. */
export function salvageCappedMessage(
  finalMessage: Message | undefined,
  buffered: string,
  priorText: string,
  fields: Omit<CappedHandoff, 'incomplete' | 'incompleteReason'>,
): Message {
  const finalText = finalMessage?.content ?? buffered;
  const salvage = (!finalText.trim() || isNarrationOnly(finalText)) && priorText.trim().length > 0;
  const content = salvage
    ? '[Salvaged prior assistant findings; incomplete and not a final verification.]\n\n' + priorText
    : finalText.trim() ? finalText : '[Capped by tool-use iteration cap; no substantive assistant findings available; partial result.]';
  return {
    ...(finalMessage ?? { role: 'assistant', timestamp: new Date() }),
    content,
    metadata: { ...finalMessage?.metadata, ...fields, ...(salvage && { salvaged: true }) },
  };
}
