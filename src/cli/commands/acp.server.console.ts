import { Console } from 'node:console';
import type { Writable } from 'node:stream';

type Redirected = Pick<Console, 'log' | 'info' | 'debug'>;

/** Console methods captured by the first live install; restored when the last is released. */
let saved: Redirected | undefined;
let installs = 0;

/**
 * Keep shared code and plugin console diagnostics off the ACP protocol stream.
 * Installs nest: the originals are captured on the first install and restored
 * only when the last one is released, in any order. Each release is idempotent.
 */
export function installAcpConsoleRedirect(stderr: Writable = process.stderr): () => void {
  if (installs === 0) saved = { log: console.log, info: console.info, debug: console.debug };
  installs++;
  const diagnostics = new Console({ stdout: stderr, stderr });
  console.log = diagnostics.log.bind(diagnostics);
  console.info = diagnostics.info.bind(diagnostics);
  console.debug = diagnostics.debug.bind(diagnostics);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installs--;
    if (installs === 0 && saved !== undefined) {
      Object.assign(console, saved);
      saved = undefined;
    }
  };
}
