/**
 * Stdin reading and backpressure-aware stream writing helpers for `afk chat`.
 *
 * Extracted from chat.ts to stay under the 350-code-line ceiling (#832).
 * Exports: `readStdin`, `writeAndDrain`, `STDIN_MAX_BYTES`.
 */

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

/** Maximum bytes accepted from stdin before the stream is destroyed. */
export const STDIN_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Read all of stdin until EOF and return the result trimmed of trailing
 * newlines. Resolves immediately when `process.stdin` has already ended.
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    // Invariant: if stdin already reached EOF before this call, `once('end')`
    // will never re-fire and `resume()` is a no-op. Resolve synchronously with
    // an empty payload rather than hanging the caller forever.
    if (process.stdin.readableEnded) {
      resolve('');
      return;
    }
    // Capture the handler so end/error paths can remove it. Without the
    // removeListener calls, repeated readStdin invocations leak listeners on
    // the shared process.stdin object and trigger MaxListenersExceededWarning.
    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.length;
      if (totalBytes > STDIN_MAX_BYTES) {
        process.stdin.destroy(new Error(`stdin exceeds ${STDIN_MAX_BYTES}-byte limit`));
        return;
      }
      chunks.push(chunk);
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', () => {
      process.stdin.removeListener('data', onData);
      resolve(Buffer.concat(chunks).toString('utf-8').replace(/\n+$/, ''));
    });
    process.stdin.once('error', (err) => {
      process.stdin.removeListener('data', onData);
      reject(err);
    });
    // Resume the stream in case it is paused (common in tests).
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------------------
// Backpressure-aware write
// ---------------------------------------------------------------------------

/**
 * Write `chunk` to `stream`, honouring backpressure: if `write()` returns
 * false (buffer full) the returned Promise resolves only after the `drain`
 * event fires, pausing the caller until the consumer catches up.
 */
export function writeAndDrain(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Invariant: settle exclusively via the write callback when `ok === true`.
    // Resolving synchronously after stream.write() races the callback — when
    // an EPIPE/stream-destroyed error fires on the callback, the Promise is
    // already settled and `reject(err)` becomes a silent no-op, masking
    // truncated NDJSON output with exit code 0.
    const ok = stream.write(chunk, (err) => {
      if (err) reject(err);
      else if (ok) resolve();
    });
    if (!ok) {
      // Backpressure path: pair drain + error listeners so a stream error
      // before drain doesn't orphan the drain listener on process.stdout —
      // orphans accumulate, eventually triggering MaxListenersExceededWarning
      // and a process crash when an unhandled `error` event fires.
      const onDrain = (): void => {
        stream.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        stream.removeListener('drain', onDrain);
        reject(err);
      };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    }
  });
}
