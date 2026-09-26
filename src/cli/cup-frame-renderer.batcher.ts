/**
 * cup-frame-renderer.batcher.ts
 *
 * CupWriteBatcher — collects escape sequences and frame content into a single
 * string buffer, then flushes everything with one `stream.write()` call.
 *
 * Rationale: batching all writes for a frame into one syscall eliminates the
 * partial-frame flicker that occurs when individual line writes race with the
 * terminal's repaint cycle. The optional synchronized-output wrapper
 * (`SYNC_START` / `SYNC_END`) further suppresses tearing on terminals that
 * support it (xterm, iTerm2, Apple Terminal).
 *
 * Usage pattern:
 *   const b = new CupWriteBatcher(stream);
 *   b.beginFrame();          // opens sync block + CURSOR_HIDE on TTY
 *   b.append(cup(row, 1) + ERASE_LINE + line);
 *   b.endFrame();            // closes sync block, then stream.write(buffer)
 *   b.flush();               // (flush is called internally by endFrame)
 */

import type { Writable } from 'node:stream';
import { SYNC_START, SYNC_END, CURSOR_HIDE, CURSOR_SHOW } from './cup-frame-renderer.escapes.js';

export class CupWriteBatcher {
  private readonly stream: NodeJS.WriteStream & Writable;
  private buffer = '';

  constructor(stream: NodeJS.WriteStream & Writable) {
    this.stream = stream;
  }

  /** Whether the stream supports synchronized output and cursor control. */
  get isTTY(): boolean {
    return this.stream.isTTY === true;
  }

  /**
   * Append `seq` to the current frame buffer. All appends between
   * `beginFrame()` and `flush()` are coalesced into a single write.
   */
  append(seq: string): void {
    this.buffer += seq;
  }

  /**
   * Open the frame: prepend `SYNC_START + CURSOR_HIDE` on TTY streams.
   * Must be paired with a `flush()` call to close and emit.
   *
   * CURSOR_HIDE is placed inside the sync block (after SYNC_START) so that
   * the hide and the frame content land in a single write() call. This is
   * safe for sync-unaware terminals: they process SYNC_START as a no-op and
   * see CURSOR_HIDE immediately followed by the frame — identical visible
   * behaviour to a separate pre-frame write, without the extra syscall.
   */
  beginFrame(): void {
    this.buffer = '';
    if (this.isTTY) {
      this.buffer += SYNC_START + CURSOR_HIDE;
    }
  }

  /**
   * Close the frame (append `SYNC_END` on TTY), then emit and clear the
   * buffer via a single `stream.write()`.
   *
   * If the write throws (e.g. EPIPE), a best-effort cursor-restore write
   * is attempted on TTY streams so a partial teardown does not strand a
   * phantom-hidden cursor.
   */
  flush(): void {
    if (this.isTTY) {
      this.buffer += SYNC_END;
    }
    try {
      this.stream.write(this.buffer);
    } catch {
      // Invariant: if the frame write fails after CURSOR_HIDE was emitted
      // inside the sync block, the cursor is left invisible on the host
      // terminal. Restore visibility best-effort so a partial teardown
      // doesn't strand a phantom-hidden cursor. Matches the silent-swallow
      // pattern used in done() in the main renderer.
      try {
        if (this.stream.isTTY) this.stream.write(SYNC_START + CURSOR_SHOW + SYNC_END);
      } catch {
        // Terminal fully gone — nothing more we can do.
      }
    } finally {
      this.buffer = '';
    }
  }

  /**
   * Emit `seq` as a standalone atomic write — not part of the frame buffer.
   * Used by clear() and done() which have their own sync-block framing.
   * Swallows write errors silently (matches the historical noop pattern).
   */
  writeAtomic(seq: string): void {
    try {
      this.stream.write(seq);
    } catch {
      // noop
    }
  }
}
