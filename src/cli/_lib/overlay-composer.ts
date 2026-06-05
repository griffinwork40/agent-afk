/**
 * OverlayComposer — the single owner of the live overlay region.
 *
 * History (root cause this fixes): the interactive REPL corrupted because the
 * compositor's overlay was a single mutable string slot written from 15+ sites
 * with no composition — orchestrator `setComposedOverlay`, eight per-subagent
 * `setOverlay(toolLane.getOverlay())` calls, and the markdown renderer's 33ms
 * `setTimeout` repaint. Whichever wrote last won; the markdown timer firing
 * between two synchronous tool-lane events clobbered the tree (or vice-versa),
 * producing the interleaved/scrambled overlay.
 *
 * Fix: every producer (stage rail, live thinking tail, pending markdown, tool
 * lane tree, progress banner) registers a keyed view-model and signals dirty;
 * the composer concatenates the active slots in a FIXED z-order and pushes the
 * result to the sink with exactly one `setOverlay` call. Because JS is
 * single-threaded, each `flush()` runs to completion before the next event or
 * timer — so the streamed paragraph and the tree coexist in one composed frame
 * instead of racing one slot. This is the ONLY thing that should call
 * `compositor.setOverlay` while a turn is live.
 */

/** A single overlay producer. `key` is both its identity and its z-order key. */
export interface OverlaySlot {
  readonly key: string;
  /** Current content for this slot; return '' when the slot is inactive. */
  render(): string;
}

/** The minimal compositor surface the composer drives. */
export interface OverlaySink {
  setOverlay(text: string): void;
}

export class OverlayComposer {
  private readonly sink: OverlaySink;
  /**
   * Fixed top→bottom render order. Only slots whose key appears here are
   * composed; a registered slot whose key is absent from `order` is never
   * shown (makes the z-order explicit and intentional rather than incidental
   * to registration order).
   */
  private readonly order: readonly string[];
  private readonly slots = new Map<string, OverlaySlot>();
  private dirty = false;

  constructor(sink: OverlaySink, order: readonly string[]) {
    this.sink = sink;
    this.order = [...order];
  }

  /** Register (or replace) a slot. Marks dirty so the next flush includes it. */
  register(slot: OverlaySlot): void {
    this.slots.set(slot.key, slot);
    this.dirty = true;
  }

  /**
   * Signal that a slot's content may have changed. Unknown keys are ignored so
   * a stale caller can't force a needless recomposition. Does not render — call
   * `flush()` once after all of an event's `markDirty` calls.
   */
  markDirty(key: string): void {
    if (this.slots.has(key)) this.dirty = true;
  }

  /**
   * Recompose all active slots (in `order`) and push to the sink exactly once,
   * iff something has been marked dirty since the last flush. No-ops otherwise
   * so a flush on an unchanged overlay never triggers a repaint.
   *
   * Invariant: a single `setOverlay` call per flush. Empty slots are dropped
   * (no blank line) so an inactive producer leaves no vertical gap.
   */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;

    const parts: string[] = [];
    for (const key of this.order) {
      const slot = this.slots.get(key);
      if (slot === undefined) continue;
      const text = slot.render();
      if (text.length > 0) parts.push(text);
    }
    this.sink.setOverlay(parts.join('\n'));
  }

  /** Force the next `flush()` to recompose even if nothing was marked dirty. */
  invalidate(): void {
    this.dirty = true;
  }
}
