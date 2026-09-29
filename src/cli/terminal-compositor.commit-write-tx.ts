/**
 * terminal-compositor.commit-write-tx.ts
 *
 * CommitWriteTx — a write-transaction primitive that makes each `commitAbove`
 * visually atomic at the terminal level.
 *
 * Problem: a block commit touches the stream through at least four independent
 * write sites — `logUpdate.clear()` (CupFrameRenderer batcher), the DECSTBM
 * reset/re-arm pairs from `StatusLine.withFullScrollRegion`, the Phase-1
 * archive/LF writes, the Phase-2 repaint (CupFrameRenderer batcher again), and
 * the Phase-3 band-paint. Each `stream.write()` call is a separate syscall that
 * a multiplexer (tmux, screen) can render as an intermediate state, causing
 * erased rows, DECSTBM transitions, and half-painted frames to be visible.
 *
 * Solution: intercept `stream.write` for the duration of the commit, buffer
 * every byte in call order, then flush once wrapped in DEC 2026 synchronized-
 * output escapes (`SYNC_START` / `SYNC_END`). Because all commit code is
 * synchronous (zero microtask yields inside commitAbove), the call-order
 * invariant is maintained: every writer executes on the same JS stack and its
 * bytes land in the buffer at the moment it calls `write`, preserving the exact
 * interleave that was already correct for TTY display — only the chunking
 * changes (many writes → one write).
 *
 * Invariant (DEC 2026 / DECSTBM ordering): a DECSTBM reset (`\x1b[r`) that
 * wipes the scroll-region marker MUST reach the terminal before the LF that
 * triggers a full-screen scroll, and the DECSTBM re-arm MUST follow that LF.
 * Buffering preserves this order because `withFullScrollRegion` writes the reset
 * before calling its inner function (which emits the LF), and the re-arm in the
 * finally block writes after. Buffer flush is a single write that delivers all
 * three in the exact same order; no interleaving is possible.
 *
 * Nested transactions: `commitAbove` may trigger a synchronous re-entrant
 * repaint (Phase 2) which calls `stream.write` via the CupFrameRenderer batcher.
 * Re-entrant calls are absorbed into the same buffer — there is no double-wrap.
 * The `depth` counter tracks nesting; only the outermost `end()` flushes.
 *
 * Non-TTY: on non-TTY streams `stream.isTTY` is falsy. In that case the tx is a
 * no-op: the original `write` method is not replaced and no sync escapes are
 * emitted, matching the existing non-TTY behaviour of `CupWriteBatcher`.
 *
 * Throw safety: if a write throws mid-commit (e.g. EPIPE), the finally block in
 * `commitAbove` still calls `end()`. `end()` attempts to flush whatever was
 * buffered, restores `stream.write` unconditionally, then re-throws. The stream
 * is NEVER left patched after `end()` returns — whether or not the flush
 * succeeded.
 */

import type { Writable } from 'node:stream';
import { SYNC_START, SYNC_END } from './cup-frame-renderer.escapes.js';

/** Minimal stream shape required by CommitWriteTx. */
export type TxStream = NodeJS.WriteStream & Writable;
/** Simplified write function type used for the stored original and the flush. */
type WriteStr = (data: string) => boolean;

/**
 * A write-transaction handle.  Obtained via {@link CommitWriteTx.begin} and
 * released via {@link CommitWriteTx.end}.
 */
export interface WriteTxHandle {
  /** Complete the transaction: flush the buffered bytes (wrapped in SYNC
   *  START/END on TTY) and restore `stream.write`. Safe to call multiple times;
   *  only the first call flushes — subsequent calls are no-ops. */
  end(): void;
}

/**
 * CommitWriteTx — stream-level write transaction for `commitAbove`.
 *
 * Usage (inside commitAbove):
 *   const tx = CommitWriteTx.begin(self.stdout);
 *   try {
 *     // ... all commit phases ...
 *   } finally {
 *     tx.end();
 *   }
 */
export class CommitWriteTx {
  // Depth counter for nested transactions on the same stream.
  // Tagged on the stream object itself so sibling modules can nest without a
  // shared singleton reference.
  static readonly DEPTH_KEY = '__commitTxDepth__' as const;
  static readonly BUF_KEY   = '__commitTxBuf__'   as const;
  static readonly ORIG_KEY  = '__commitTxOrig__'  as const;

  /**
   * Begin a write transaction on `stream`.
   *
   * On TTY streams: replaces `stream.write` with a buffer accumulator.
   * On non-TTY streams: returns a no-op handle immediately (no patching).
   */
  static begin(stream: TxStream): WriteTxHandle {
    // Invariant (non-TTY): synchronized-output escapes are a TTY-only feature.
    // On non-TTY streams (pipes, files, test passthrough without isTTY) the
    // write sites are never patched; the handle's end() is a true no-op.
    if (!stream.isTTY) {
      return { end: () => undefined };
    }

    const s = stream as TxStream & {
      [CommitWriteTx.DEPTH_KEY]?: number;
      [CommitWriteTx.BUF_KEY]?: string;
      [CommitWriteTx.ORIG_KEY]?: WriteStr;
    };

    const depth: number = (s[CommitWriteTx.DEPTH_KEY] ?? 0) + 1;
    s[CommitWriteTx.DEPTH_KEY] = depth;

    // Invariant (nested tx): only the outermost begin() patches the write method.
    // Inner begins just increment the depth counter; their writes are already
    // routed to the buffer by the outer patch.
    if (depth === 1) {
      s[CommitWriteTx.BUF_KEY]  = '';
      // Capture the current write method BEFORE patching so the stored
      // original never routes through the interceptor (infinite recursion guard).
      const rawWrite = stream.write as unknown as WriteStr;
      s[CommitWriteTx.ORIG_KEY] = (data: string) => rawWrite.call(stream, data);

      // Patch: intercept every stream.write() call; accumulate into buffer.
      // Invariant (ordering): because commitAbove is fully synchronous, calls
      // arrive in the same order they would reach the terminal. The buffer
      // faithfully preserves that order.
      (stream as unknown as Record<string, unknown>)['write'] = function txWrite(
        chunk: string | Buffer | Uint8Array,
        ...rest: unknown[]
      ): boolean {
        s[CommitWriteTx.BUF_KEY] += typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString()
            : String(chunk);
        // Mirror the return convention of the real write(): return true to
        // signal the buffer has not reached the highWaterMark (it never
        // does — we are in a simple string buffer). Callers that check the
        // return value (stream backpressure) will not see a false here.
        void rest;
        return true;
      };
    }

    let ended = false;

    return {
      end(): void {
        if (ended) return;
        ended = true;

        const currentDepth = (s[CommitWriteTx.DEPTH_KEY] ?? 1) - 1;
        s[CommitWriteTx.DEPTH_KEY] = currentDepth;

        // Invariant (nested tx): only the outermost end() flushes and restores.
        // Inner ends decrement the counter but leave the buffer open for the
        // outer transaction to drain.
        if (currentDepth > 0) return;

        const buf    = s[CommitWriteTx.BUF_KEY] ?? '';
        const orig   = s[CommitWriteTx.ORIG_KEY];

        // Restore stream.write unconditionally before the flush so that if
        // the flush throws, the stream is left in a clean state. The stream
        // property is a plain enumerable own property set by the patch above;
        // deletion restores the prototype chain's original write.
        // (We assign orig back rather than delete to avoid any prototype
        // weirdness with exotic stream implementations.)
        if (orig) {
          (stream as unknown as Record<string, unknown>)['write'] = orig;
        }
        delete s[CommitWriteTx.BUF_KEY];
        delete s[CommitWriteTx.ORIG_KEY];

        if (buf.length === 0) return;

        // Single atomic write: SYNC_START + all buffered bytes + SYNC_END.
        // Invariant (DEC 2026 nesting): the CupWriteBatcher's own SYNC_START/
        // SYNC_END for the Phase-2 repaint land INSIDE this outer pair. Per
        // the DEC 2026 spec, terminals implement synchronized output as a
        // reference-counted hold: SYNC_START increments, SYNC_END decrements,
        // and the repaint is suppressed until the count reaches zero. Nested
        // pairs are therefore well-defined and do not cause double-display.
        orig?.(SYNC_START + buf + SYNC_END);
      },
    };
  }
}
