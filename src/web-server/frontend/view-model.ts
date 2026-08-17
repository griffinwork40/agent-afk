/**
 * Pure, DOM-free transcript view-model for the `afk web` frontend.
 *
 * Folds the agent's {@link OutputEvent} stream into a renderable list of
 * {@link TranscriptItem}s. Contains no browser globals (`document`/`window`)
 * so it runs under plain Vitest with `environment: 'node'`; DOM rendering is
 * wired up separately.
 *
 * Invariant: after a browser refresh the frontend replays the persisted
 * session ledger rather than the live event stream. That ledger is a lossy
 * PROJECTION of what actually happened — assistant text and tool inputs are
 * length-capped, and successful tool output is never persisted at all (only
 * error output is). Callers pass `{ replay: true }` to {@link TranscriptModel.apply}
 * for every event sourced from that replay so this model can flag outputs it
 * cannot vouch for via `outputUnavailable`, instead of ever rendering an
 * empty string as if it were a genuine empty result.
 *
 * @module web-server/frontend/view-model
 */

import type { OutputEvent } from '../../agent/types/session-types.js';
import type { Message, MessageChunk, ToolDiffChunk } from '../../agent/types/message-types.js';

/** A completed user turn. */
export interface UserMessageItem {
  kind: 'user';
  id: string;
  text: string;
  timestamp?: Date;
}

/** An assistant text block. Streamed `content` chunk deltas accumulate into one item. */
export interface AssistantTextItem {
  kind: 'assistant';
  id: string;
  text: string;
}

/** Extended-thinking block. Streamed `thinking` chunk deltas accumulate into one item. */
export interface ThinkingItem {
  kind: 'thinking';
  id: string;
  text: string;
}

export type ToolCallStatus = 'running' | 'ok' | 'error';

/** A single tool invocation, correlated by `toolUseId`. */
export interface ToolCallItem {
  kind: 'tool';
  id: string;
  name: string;
  inputPreview: string;
  status: ToolCallStatus;
  output?: string;
  /**
   * `true` when this item's success output cannot be shown because the
   * source event came from a replayed session ledger that never persisted
   * successful tool output (only failures are persisted). MUST be checked
   * before rendering `output` — a missing/empty `output` alongside a falsy
   * `outputUnavailable` means the tool genuinely produced no text, whereas
   * `outputUnavailable: true` means the real output is gone, not empty.
   */
  outputUnavailable?: boolean;
  diff?: ToolDiffChunk['diff'];
}

/** A terminal or turn-level error. */
export interface ErrorItem {
  kind: 'error';
  id: string;
  message: string;
}

/** Progress, pause/resume, rate-limit banners, and bare tool-use summaries. */
export interface NoticeItem {
  kind: 'notice';
  id: string;
  text: string;
}

export type TranscriptItem =
  | UserMessageItem
  | AssistantTextItem
  | ThinkingItem
  | ToolCallItem
  | ErrorItem
  | NoticeItem;

export interface ApplyOptions {
  /**
   * Set when `event` was sourced from the persisted session ledger replay
   * (e.g. after a browser refresh) rather than the live provider stream.
   * Governs whether a successful `tool_result` can trust its `content` as
   * real output — see {@link ToolCallItem.outputUnavailable}.
   */
  replay?: boolean;
}

export interface TranscriptModel {
  /** Fold one event into the model, mutating internal state in place. */
  apply(event: OutputEvent, opts?: ApplyOptions): void;
  /** Current items, oldest first. Returns a fresh array each call. */
  getItems(): TranscriptItem[];
}

function isToolCallItem(item: TranscriptItem | undefined): item is ToolCallItem {
  return item !== undefined && item.kind === 'tool';
}

export function createTranscriptModel(): TranscriptModel {
  const items: TranscriptItem[] = [];
  let currentAssistantId: string | null = null;
  let currentThinkingId: string | null = null;
  let seq = 0;

  function nextId(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}`;
  }

  function indexOf(id: string): number {
    return items.findIndex((item) => item.id === id);
  }

  /** Turn boundary: subsequent `content`/`thinking` chunks start fresh blocks. */
  function endTurn(): void {
    currentAssistantId = null;
    currentThinkingId = null;
  }

  function assistantIndex(): number {
    if (currentAssistantId !== null) {
      const idx = indexOf(currentAssistantId);
      const existing = items[idx];
      if (existing && existing.kind === 'assistant') return idx;
    }
    const item: AssistantTextItem = { kind: 'assistant', id: nextId('assistant'), text: '' };
    items.push(item);
    currentAssistantId = item.id;
    return items.length - 1;
  }

  function thinkingIndex(): number {
    if (currentThinkingId !== null) {
      const idx = indexOf(currentThinkingId);
      const existing = items[idx];
      if (existing && existing.kind === 'thinking') return idx;
    }
    const item: ThinkingItem = { kind: 'thinking', id: nextId('thinking'), text: '' };
    items.push(item);
    currentThinkingId = item.id;
    return items.length - 1;
  }

  function applyMessage(message: Message): void {
    if (message.role === 'user') {
      endTurn();
      items.push({ kind: 'user', id: nextId('user'), text: message.content, timestamp: message.timestamp });
      return;
    }
    // Final assembled assistant message: overwrite the in-progress block (if
    // streaming built one) with the authoritative full text, or create one
    // outright for non-streaming callers that never emitted chunk events.
    const idx = assistantIndex();
    const existing = items[idx];
    if (existing && existing.kind === 'assistant') {
      items[idx] = { ...existing, text: message.content };
    }
    endTurn();
  }

  function applyChunk(chunk: MessageChunk, opts: ApplyOptions | undefined): void {
    switch (chunk.type) {
      case 'content': {
        const idx = assistantIndex();
        const existing = items[idx];
        if (existing && existing.kind === 'assistant') {
          items[idx] = { ...existing, text: existing.text + chunk.content };
        }
        break;
      }
      case 'thinking': {
        const idx = thinkingIndex();
        const existing = items[idx];
        if (existing && existing.kind === 'thinking') {
          items[idx] = { ...existing, text: existing.text + chunk.content };
        }
        break;
      }
      case 'tool_use': {
        // Bare summary line with no toolUseId to correlate against a later
        // tool_result/tool_diff — surfaced as a notice rather than a
        // half-populated tool item we could never complete.
        items.push({ kind: 'notice', id: nextId('notice'), text: chunk.content });
        break;
      }
      case 'tool_use_detail': {
        const idx = indexOf(chunk.toolUseId);
        const existing = items[idx];
        if (isToolCallItem(existing)) {
          items[idx] = { ...existing, name: chunk.toolName, inputPreview: chunk.toolInput };
        } else {
          items.push({
            kind: 'tool',
            id: chunk.toolUseId,
            name: chunk.toolName,
            inputPreview: chunk.toolInput,
            status: 'running',
          });
        }
        break;
      }
      case 'tool_result': {
        const idx = indexOf(chunk.toolUseId);
        const existing = items[idx];
        const isError = chunk.isError === true;
        // LOAD-BEARING: the replayed session ledger never persists
        // successful tool output — only failures. A replayed success must
        // never be shown as an empty result; it must be flagged unavailable.
        const hideOutput = opts?.replay === true && !isError;
        const status: ToolCallStatus = isError ? 'error' : 'ok';
        if (isToolCallItem(existing)) {
          items[idx] = hideOutput
            ? { ...existing, status, outputUnavailable: true, output: undefined }
            : { ...existing, status, output: chunk.content, outputUnavailable: false };
        } else {
          const created: ToolCallItem = {
            kind: 'tool',
            id: chunk.toolUseId,
            name: 'tool',
            inputPreview: '',
            status,
          };
          if (hideOutput) created.outputUnavailable = true;
          else created.output = chunk.content;
          items.push(created);
        }
        break;
      }
      case 'tool_diff': {
        const idx = indexOf(chunk.toolUseId);
        const existing = items[idx];
        // Documented ToolDiffChunk contract: drop silently if no matching
        // tool item exists yet.
        if (isToolCallItem(existing)) {
          items[idx] = { ...existing, diff: chunk.diff };
        }
        break;
      }
      case 'done':
      case 'error':
        // Legacy inline terminal markers on MessageChunk itself; the
        // top-level OutputEvent 'done'/'error' cases carry the richer,
        // structured versions and are handled in `apply`.
        break;
      default:
        break;
    }
  }

  function apply(event: OutputEvent, opts?: ApplyOptions): void {
    switch (event.type) {
      case 'message':
        applyMessage(event.message);
        break;
      case 'chunk':
        applyChunk(event.chunk, opts);
        break;
      case 'error':
        items.push({ kind: 'error', id: nextId('error'), message: event.error.message });
        endTurn();
        break;
      case 'done':
        endTurn();
        break;
      case 'progress':
        items.push({
          kind: 'notice',
          id: nextId('notice'),
          text: event.progress.summary ?? event.progress.description,
        });
        break;
      case 'paused':
        items.push({ kind: 'notice', id: nextId('notice'), text: `paused: ${event.reason}` });
        break;
      case 'resumed':
        items.push({ kind: 'notice', id: nextId('notice'), text: 'resumed' });
        break;
      case 'rate_limit':
        items.push({ kind: 'notice', id: nextId('notice'), text: 'rate limited' });
        break;
      case 'stream_retry': {
        // The provider re-drove the turn from scratch. Discard the
        // in-progress assistant block instead of leaving it for the next
        // content delta to append onto — appending would visibly duplicate
        // the pre-retry text.
        if (currentAssistantId !== null) {
          const idx = indexOf(currentAssistantId);
          if (idx >= 0) items.splice(idx, 1);
          currentAssistantId = null;
        }
        break;
      }
      case 'notice':
        // Display-only harness notice (issue #970). Render alongside other
        // notice-kind items in the web transcript so truncations and refusals
        // are visible in the web frontend.
        items.push({ kind: 'notice', id: nextId('notice'), text: event.text });
        break;
      default:
        // Forward-compatible: OutputEvent has variants outside this model's
        // documented input set (e.g. 'suggestion', 'panel'). Ignored rather
        // than throwing so `apply` stays total over the real union.
        break;
    }
  }

  function getItems(): TranscriptItem[] {
    return items.slice();
  }

  return { apply, getItems };
}
