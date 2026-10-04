/**
 * `afk trace show` rendering for event kinds formatted outside `trace.ts`
 * (which is grandfathered over the file-size ceiling and may not grow).
 * Currently: `peer_message` (cross-session messaging, docs/peer-messaging.md).
 *
 * Contract: returns the rendered detail line for a known kind, or the
 * forward-compatible "(unrecognized event kind)" line for anything else, so
 * an unknown future kind is still shown rather than dropped.
 *
 * @module cli/commands/trace-peer-format
 */

import type { TraceEvent } from '../../agent/trace/index.js';
import { fmtBytes } from './trace-format.js';

/** Render `event` with the caller's `line(kind, detail)` formatter. */
export function renderSecondaryEvent(
  event: TraceEvent,
  line: (kind: string, detail: string) => string,
): string {
  if (event.kind === 'peer_message') {
    const p = event.payload;
    const id = p.messageId !== undefined ? `  msg=${p.messageId.slice(0, 8)}` : '';
    const reason = p.reason !== undefined ? `  (${p.reason})` : '';
    const dir = p.action === 'sent' || p.action === 'refused' ? 'to' : 'from';
    return line('peer', `${p.action} ${dir} ${p.peer.slice(0, 8)}  ${fmtBytes(p.bytes)}${id}${reason}`);
  }
  return line((event as { kind: string }).kind, '(unrecognized event kind)');
}
