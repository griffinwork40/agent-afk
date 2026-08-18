import type { ToolEvent } from './slash/types.js';

/**
 * Summarize tool events for a single turn into a compact one-line string
 * suitable for appending to the assistant text on resume replay.
 *
 * Returns empty string when there are no events (no-op on append).
 */
export function summarizeToolEvents(events: ToolEvent[] | undefined): string {
  if (!events || events.length === 0) return '';
  const parts = events.map((ev) => {
    const status = ev.isError ? '✗' : '✓';
    // Prefer the display-truncated input; fall back to first 80 chars of inputRaw
    const raw = ev.input || (ev.inputRaw ? ev.inputRaw.slice(0, 80) : '');
    // Truncate to keep the summary compact
    const input = raw.length > 80 ? raw.slice(0, 77) + '…' : raw;
    return `${ev.toolName}(${input})${status}`;
  });
  return `\n[Tools used: ${parts.join(', ')}]`;
}
