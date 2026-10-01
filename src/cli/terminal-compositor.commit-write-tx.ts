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
 * Re-entrant calls are absorbed into the same buffer. The `depth` counter
 * tracks nesting; only the outermost `end()` flushes.
 *
 * Invariant (DEC 2026 does not nest): mode 2026 is a plain set/reset, not a
 * counter, so the first `\x1b[?2026l` inside the buffer would end the
 * synchronized update early and expose the rest of the commit. The frame
 * batcher emits its own SYNC_START/SYNC_END pairs, so the flush strips every
 * inner marker and wraps the whole buffer in exactly one pair.
 *
 * Invariant (restore identity): the stream's own `write` is restored by
 * identity (own property put back, or deleted so the prototype method shows
 * through again). Restoring a wrapper instead would silently drop the
 * `(chunk, encoding, cb)` arguments for every later writer. Callbacks passed
 * during the transaction are invoked from the single flush write's callback.
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

/**
 * A write-transaction handle.  Obtained via {@link CommitWriteTx.begin} and
 * released via `end()`.
 */
export interface WriteTxHandle {
  /** Complete the transaction: flush the buffered bytes (wrapped in one SYNC
   *  START/END pair on TTY) and restore `stream.write`. Safe to call multiple
   *  times; only the first call has any effect. */
  end(): void;
}

type WriteCb = (err?: Error | null) => void;

interface TxState {
  depth: number;
  buf: string;
  cbs: WriteCb[];
  hadOwnWrite: boolean;
  ownWrite: unknown;
}

const active = new WeakMap<object, TxState>();

function toText(chunk: unknown, encoding: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  }
  return String(chunk);
}

function restore(stream: TxStream, st: TxState): void {
  const target = stream as unknown as Record<string, unknown>;
  if (st.hadOwnWrite) target['write'] = st.ownWrite;
  else delete target['write'];
}

/** Strip nested sync markers; the flush adds exactly one outer pair. */
function unwrapSync(buf: string): string {
  return buf.split(SYNC_START).join('').split(SYNC_END).join('');
}

/**
 * CommitWriteTx — stream-level write transaction for `commitAbove`.
 *
 * Usage (inside commitAbove):
 *   const tx = CommitWriteTx.begin(self.stdout);
 *   try { ... all commit phases ... } finally { tx.end(); }
 */
export class CommitWriteTx {
  static begin(stream: TxStream): WriteTxHandle {
    if (!stream.isTTY) return { end: () => undefined };
    let st = active.get(stream);
    if (st) {
      st.depth++;
    } else {
      const hadOwnWrite = Object.prototype.hasOwnProperty.call(stream, 'write');
      const created: TxState = { depth: 1, buf: '', cbs: [], hadOwnWrite, ownWrite: hadOwnWrite ? stream.write : undefined };
      st = created;
      active.set(stream, created);
      (stream as unknown as Record<string, unknown>)['write'] = function txWrite(chunk: unknown, a?: unknown, b?: unknown): boolean {
        created.buf += toText(chunk, typeof a === 'function' ? undefined : a);
        const cb = typeof a === 'function' ? a : typeof b === 'function' ? b : undefined;
        if (cb) created.cbs.push(cb as WriteCb);
        return true;
      };
    }
    const state = st;
    let ended = false;
    return {
      end(): void {
        if (ended) return;
        ended = true;
        state.depth--;
        if (state.depth > 0) return;
        active.delete(stream);
        restore(stream, state);
        const cbs = state.cbs;
        const body = unwrapSync(state.buf);
        if (body.length === 0) {
          for (const cb of cbs) cb(null);
          return;
        }
        stream.write(SYNC_START + body + SYNC_END, (err?: Error | null) => {
          for (const cb of cbs) cb(err ?? null);
        });
      },
    };
  }
}
