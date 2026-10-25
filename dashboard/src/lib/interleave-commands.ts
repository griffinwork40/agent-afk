/**
 * Interleave client-local command outputs into the SSE transcript.
 *
 * Contract: a command output with `afterCount = n` renders after the first
 * `n` transcript items. Outputs sharing an anchor keep insertion order. Each
 * returned transcript segment is a contiguous slice of the input, so
 * concatenating the transcript segments reproduces `items` exactly.
 *
 * Invariant: the server refuses commands while a turn is running (409
 * session_busy), so anchors land on turn boundaries and a split never cuts
 * an execution block in half.
 */

export type Segment<T, C> =
  | { kind: 'transcript'; items: T[] }
  | { kind: 'command'; item: C };

export function interleaveCommands<T, C extends { afterCount: number; key: number }>(
  items: readonly T[],
  commands: readonly C[],
): Segment<T, C>[] {
  const sorted = [...commands].sort((a, b) => a.afterCount - b.afterCount || a.key - b.key);
  const out: Segment<T, C>[] = [];
  let cursor = 0;
  for (const cmd of sorted) {
    const anchor = Math.min(Math.max(cmd.afterCount, 0), items.length);
    if (anchor > cursor) {
      out.push({ kind: 'transcript', items: items.slice(cursor, anchor) });
      cursor = anchor;
    }
    out.push({ kind: 'command', item: cmd });
  }
  if (cursor < items.length) out.push({ kind: 'transcript', items: items.slice(cursor) });
  return out;
}
