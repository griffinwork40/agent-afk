/**
 * Shared formatter for disk-replayed OutputEvent values.
 *
 * Extracted from src/cli/slash/commands/bgsub.ts so other surfaces
 * (task-view, future replay commands) can share the same rendering without
 * importing the entire bgsub slash-command module.
 *
 * Contract: returns `null` for event types that carry no meaningful text
 * (e.g. `done`, `progress`). Callers should filter nulls before joining.
 *
 * ANSI codes are stripped from user-generated content (chunk/message) so
 * replayed output does not corrupt the terminal with double-rendered escapes.
 * Newlines are preserved — this is a replay, not a single-line badge.
 *
 * @module cli/output-event-format
 */

import { palette } from './palette.js';
import { stripEscapeSequences } from '../utils/terminal-sanitize.js';
import type { OutputEvent } from '../agent/types/session-types.js';

/**
 * Format a single OutputEvent for terminal display during disk replay.
 * Returns null for event types with no meaningful text representation.
 *
 * Exported as both `formatOutputEvent` (canonical public name) and
 * `formatDiskEvent` (legacy alias, used by bgsub.ts on this branch).
 */
export function formatOutputEvent(event: OutputEvent): string | null {
  if (event.type === 'chunk') {
    const chunk = event.chunk;
    if (chunk.type === 'content') return stripEscapeSequences(chunk.content);
    if (chunk.type === 'tool_use_detail') {
      return palette.dim(`  [tool: ${chunk.toolName}]`);
    }
    return null;
  }
  if (event.type === 'error') {
    return palette.dim(`  [error: ${event.error.message}]`);
  }
  if (event.type === 'message') {
    const c = event.message.content;
    const text = typeof c === 'string' ? c : JSON.stringify(c);
    return stripEscapeSequences(text);
  }
  return null;
}


/**
 * Legacy alias — `bgsub.ts` imported this name when the function lived there.
 * Preserved so the import in that file does not need to be updated in the same
 * wave as this extraction.
 */
export const formatDiskEvent = formatOutputEvent;
