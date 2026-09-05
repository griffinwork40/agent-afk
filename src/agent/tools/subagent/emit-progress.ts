/**
 * Child-to-parent progress event tool.
 *
 * Provides the `emit_progress` tool available on opted-in child subagents.
 * When a parent dispatches a child with `progress_events: true`, the child's
 * tool surface gains this tool. Calling it pushes a structured progress event
 * to a ring buffer on the handle and delivers it to the parent's next user-turn
 * via `queueFrameworkContext`.
 *
 * This is the reverse direction of the `send_message_to_agent` steering tool
 * (Item 1 / PR #1494): parent→child is steering; child→parent is progress.
 *
 * @module agent/tools/subagent/emit-progress
 */

import type { SubagentHandleImpl } from '../../subagent/handle.js';
import type { ToolResult } from '../types.js';

/** Shape of a single progress event payload from the child. */
export interface ProgressEventPayload {
  message: string;
  phase?: string;
  metadata?: Record<string, unknown>;
}

/** Ring buffer capacity per handle. */
export const PROGRESS_RING_CAPACITY = 20;

/** Maximum UTF-8 byte length of the `message` field. */
export const PROGRESS_MAX_MESSAGE_BYTES = 2048;

/**
 * Format a progress event as a `<child-progress>` XML envelope for delivery
 * to the parent's next turn via `queueFrameworkContext`.
 */
export function formatProgressEvent(
  payload: ProgressEventPayload,
  subagentId: string,
): string {
  const timestamp = new Date().toISOString();
  const phaseAttr = payload.phase !== undefined ? ` phase="${escapeAttr(payload.phase)}"` : '';
  return (
    `<child-progress subagentId="${escapeAttr(subagentId)}"${phaseAttr} timestamp="${timestamp}">` +
    payload.message +
    `</child-progress>`
  );
}

/** Escape XML attribute values (double-quotes and ampersands). */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Factory that returns an `emit_progress` tool handler bound to a specific
 * child handle and the parent's queue function.
 *
 * The returned handler:
 * 1. Validates message byte length (hard truncation at PROGRESS_MAX_MESSAGE_BYTES).
 * 2. Pushes the payload to the handle's progress ring buffer (evicts oldest on overflow).
 * 3. Calls `parentQueueFn` to deliver the formatted envelope to the parent's next turn.
 * 4. Returns `{ delivered: true }` to the child.
 *
 * The handler is a no-op (returns `{ delivered: false }`) when the parent abort
 * signal is already fired — the parent will not consume the delivery anyway.
 */
export function createEmitProgressHandler(
  handle: SubagentHandleImpl<unknown>,
  parentQueueFn: (text: string) => void,
  parentAbortSignal: AbortSignal | undefined,
): (input: unknown, signal: AbortSignal) => Promise<ToolResult> {
  return async (input: unknown): Promise<ToolResult> => {
    // Guard: parent is gone — skip delivery silently.
    if (parentAbortSignal?.aborted) {
      return { content: JSON.stringify({ delivered: false, reason: 'parent_aborted' }) };
    }

    if (typeof input !== 'object' || input === null) {
      return { content: 'emit_progress: input must be an object.', isError: true };
    }

    const raw = input as Record<string, unknown>;

    const messageRaw = raw['message'];
    if (typeof messageRaw !== 'string' || messageRaw.trim().length === 0) {
      return {
        content: 'emit_progress: "message" must be a non-empty string.',
        isError: true,
      };
    }

    // Enforce byte cap — truncate at the UTF-8 byte boundary.
    let message = messageRaw;
    if (Buffer.byteLength(message, 'utf8') > PROGRESS_MAX_MESSAGE_BYTES) {
      message = truncateToBytes(message, PROGRESS_MAX_MESSAGE_BYTES);
    }

    const phase =
      typeof raw['phase'] === 'string' && raw['phase'].trim().length > 0
        ? raw['phase'].trim()
        : undefined;

    const metadata =
      typeof raw['metadata'] === 'object' &&
      raw['metadata'] !== null &&
      !Array.isArray(raw['metadata'])
        ? (raw['metadata'] as Record<string, unknown>)
        : undefined;

    const payload: ProgressEventPayload = { message, ...(phase !== undefined ? { phase } : {}), ...(metadata !== undefined ? { metadata } : {}) };

    // Push to ring buffer with oldest-first eviction.
    handle.emitProgress(payload);

    // Deliver to parent's next turn.
    try {
      const envelope = formatProgressEvent(payload, handle.id);
      parentQueueFn(envelope);
    } catch {
      // Delivery failure is non-fatal to the child.
    }

    return { content: JSON.stringify({ delivered: true }) };
  };
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes without splitting
 * multi-byte codepoints or surrogate pairs.
 */
function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf8');
  if (buf.byteLength <= maxBytes) return str;
  // Slice to maxBytes then decode, which drops any incomplete multi-byte
  // sequence at the boundary.
  return buf.subarray(0, maxBytes).toString('utf8');
}
