import { SYNC_START, SYNC_END } from './cup-frame-renderer.escapes.js';

type WriteCallback = (error?: Error | null) => void;

interface TransactionState {
  depth: number;
  chunks: Buffer[];
  callbacks: WriteCallback[];
  originalWrite: NodeJS.WriteStream['write'];
  ownDescriptor: PropertyDescriptor | undefined;
}

export interface WriteTxHandle {
  /** Idempotent; only the outermost end restores and flushes the stream. */
  end(): void;
}

// Invariant: all painters retain the same process.stdout object in interactive
// wiring, not a bound write method. Intercept the object so footer self-heal,
// scroll guards and CupWriteBatcher join the synchronous commit in call order.
// DECSTBM reset must precede the LF and the re-arm must follow it; batching
// changes only write boundaries, never that ordering.
const active = new WeakMap<NodeJS.WriteStream, TransactionState>();

function captureChunk(chunk: string | Uint8Array, encoding?: BufferEncoding): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
}

/** DEC 2026 does not nest: strip inner set/reset pairs, including split ones. */
function unwrapSync(chunks: Buffer[]): Buffer {
  // latin1 is a reversible byte mapping, including partial UTF-8 chunks.
  const bytes = Buffer.concat(chunks).toString('latin1');
  return Buffer.from(bytes.split(SYNC_START).join('').split(SYNC_END).join(''), 'latin1');
}

function flush(stream: NodeJS.WriteStream, state: TransactionState): void {
  active.delete(stream);
  // Restore BEFORE calling any external code, including the physical write or
  // its callback. A throwing flush must never strand the interception layer.
  if (state.ownDescriptor) Object.defineProperty(stream, 'write', state.ownDescriptor);
  else Reflect.deleteProperty(stream, 'write');
  let completed = false;
  const complete: WriteCallback = error => {
    if (completed) return;
    completed = true;
    for (const callback of state.callbacks) callback(error ?? null);
  };
  // A transaction that captured one write gains nothing from batching, so
  // forward those bytes untouched: single-write commits (the disarmed raw
  // path) stay byte-identical, and that write's own sync pair is balanced.
  const single = state.chunks.length === 1 ? state.chunks[0] : undefined;
  const body = single ?? unwrapSync(state.chunks);
  if (body.length === 0) {
    queueMicrotask(() => complete(null));
    return;
  }
  const payload = single ?? Buffer.concat([Buffer.from(SYNC_START), body, Buffer.from(SYNC_END)]);
  try {
    state.originalWrite.call(stream, payload, undefined, complete);
  } catch (error) {
    complete(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Synchronous shared-stream transaction. Buffered writes return true: bytes
 * are accepted into memory, not submitted to the underlying high-water mark.
 * Callbacks complete with the single physical flush's result. Never span await.
 */
export class CommitWriteTx {
  static begin(stream: NodeJS.WriteStream): WriteTxHandle {
    if (!stream.isTTY) return { end: () => undefined };
    let state = active.get(stream);
    if (state) {
      state.depth++;
    } else {
      const created: TransactionState = {
        depth: 1, chunks: [], callbacks: [], originalWrite: stream.write,
        ownDescriptor: Object.getOwnPropertyDescriptor(stream, 'write'),
      };
      const intercept = (chunk: string | Uint8Array, a?: BufferEncoding | WriteCallback, b?: WriteCallback): boolean => {
        created.chunks.push(captureChunk(chunk, typeof a === 'string' ? a : undefined));
        const callback = typeof a === 'function' ? a : b;
        if (callback) created.callbacks.push(callback);
        return true;
      };
      stream.write = intercept as NodeJS.WriteStream['write'];
      active.set(stream, created);
      state = created;
    }
    const current = state;
    let ended = false;
    return {
      end(): void {
        if (ended) return;
        ended = true;
        if (--current.depth === 0) flush(stream, current);
      },
    };
  }
}
