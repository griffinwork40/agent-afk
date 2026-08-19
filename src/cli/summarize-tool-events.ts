import type { ToolEvent } from './slash/types.js';

/**
 * Deduplicate tool events by toolUseId (last-write-wins).
 *
 * The turn-handler persists two entries per tool call: a pending placeholder
 * (from translate.ts at content_block_start) and the real completed entry
 * (from loop.ts post-stream). Both share the same toolUseId; the real entry
 * is always written last, so last-write-wins keeps the correct one.
 * Events without a toolUseId are preserved as-is.
 */
function dedupeToolEvents(events: ToolEvent[]): ToolEvent[] {
  const byId = new Map<string, ToolEvent>();
  const noId: ToolEvent[] = [];
  for (const ev of events) {
    if (ev.toolUseId === undefined) noId.push(ev);
    else byId.set(ev.toolUseId, ev); // last write wins → real entry supersedes placeholder
  }
  return [...byId.values(), ...noId];
}

/**
 * Summarize tool events for a single turn into a compact one-line string
 * suitable for appending to the assistant text on resume replay.
 *
 * Returns empty string when there are no events (no-op on append).
 */
export function summarizeToolEvents(events: ToolEvent[] | undefined): string {
  if (!events || events.length === 0) return '';
  const deduped = dedupeToolEvents(events);
  const parts = deduped.map((ev) => {
    const status = ev.isError ? '✗' : '✓';
    // Prefer the display-truncated input; fall back to inputRaw
    const raw = ev.input || ev.inputRaw || '';
    // Truncate to keep the summary compact
    const input = raw.length > 80 ? raw.slice(0, 77) + '…' : raw;
    return `${ev.toolName}(${input})${status}`;
  });
  return `\n[Tools used: ${parts.join(', ')}]`;
}
