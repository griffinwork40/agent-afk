/**
 * Provenance for journal adapters (#2464, docs/message-journal.md).
 *
 * `fromJournalMessages` converts journal messages into a provider's native
 * form, and that form can be lossy (OpenAI's native message cannot carry a
 * thinking signature) or re-grouped (OpenAI fans one journal user message out
 * to N `tool` messages; Anthropic merges consecutive same-role messages).
 * Converting back with `toJournal` then produces DIFFERENT journal messages,
 * so a provider switch used to rewrite the whole journal in the new, lossier
 * shape.
 *
 * This helper remembers, per native object, the SPAN it was built in: the
 * contiguous native messages produced together and the journal messages they
 * came from. {@link JournalProvenance.adopt} hands the ORIGINAL journal
 * messages back when the span is still present, in order, and unedited.
 *
 * Invariant: keyed by object identity in a `WeakMap`, so records die with
 * the native messages and a cloned message simply has no provenance (it maps
 * fresh, which is correct, only lossier).
 *
 * Contract (edit detection): each member's shape is captured at record time
 * as its own properties plus, for array-valued properties (`content`,
 * `tool_calls`), each element and that element's own properties. Values are
 * compared by `===`, never stringified, so the check costs O(blocks) and does
 * not scale with tool-result size. It catches replaced or appended blocks and
 * reassigned block fields (microcompaction); an edit nested deeper than that
 * is not seen here, and callers that make one use `JournalSync.invalidateFrom`.
 *
 * @module agent/journal/provenance
 */

import type { JournalAdoption, JournalMessage } from './types.js';

interface Span<T> {
  readonly sources: readonly JournalMessage[];
  readonly members: readonly T[];
  readonly shapes: readonly unknown[][];
}

interface Origin<T> {
  readonly span: Span<T>;
  readonly index: number;
}

function pushOwn(out: unknown[], value: object): void {
  for (const [key, v] of Object.entries(value)) out.push(key, v);
}

/**
 * Two-level shallow shape of a native message; see the module Contract.
 *
 * Comparison is intentionally by reference equality (`===`), not deep-equal or
 * JSON serialization. This means two re-allocated objects with identical
 * content will fail the shape check and fall through to `toJournal` — which is
 * the correct and safe behaviour: we hand back provenance ONLY when we can
 * confirm the object is the exact same one we built, bit for bit. The cost is
 * O(blocks), bounded by the number of content elements, not by their size.
 */
function shapeOf(message: object): unknown[] {
  const out: unknown[] = [];
  for (const [key, v] of Object.entries(message)) {
    out.push(key, v);
    if (!Array.isArray(v)) continue;
    out.push(v.length);
    for (const el of v as unknown[]) {
      out.push(el);
      if (el !== null && typeof el === 'object') pushOwn(out, el);
    }
  }
  return out;
}

function sameShape(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class JournalProvenance<T extends object> {
  private readonly origins = new WeakMap<T, Origin<T>>();

  /**
   * Record that `members` (contiguous and in this order in the native array)
   * were built from `sources`. Call AFTER the members are final (after any
   * merge into them), since their shape is captured here.
   */
  record(sources: readonly JournalMessage[], members: readonly T[]): void {
    if (members.length === 0) return;
    const span: Span<T> = { sources: [...sources], members: [...members], shapes: members.map(shapeOf) };
    members.forEach((m, index) => this.origins.set(m, { span, index }));
  }

  /**
   * When a recorded span STARTS at `messages[at]` and every member follows
   * it by identity and is unedited, return the span's original journal
   * messages. Otherwise `undefined` and the caller maps fresh.
   */
  adopt(messages: readonly T[], at: number): JournalAdoption | undefined {
    const first = messages[at];
    const origin = first === undefined ? undefined : this.origins.get(first);
    if (!origin || origin.index !== 0) return undefined;
    const { members, shapes, sources } = origin.span;
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      if (messages[at + i] !== m || !sameShape(shapeOf(m), shapes[i]!)) return undefined;
    }
    return { entries: sources, count: members.length };
  }
}
