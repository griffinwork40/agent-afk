import { Console } from 'node:console';
import type { Writable } from 'node:stream';

/** Keep shared code and plugin console diagnostics off the ACP protocol stream. */
export function installAcpConsoleRedirect(stderr: Writable = process.stderr): () => void {
  const originals = { log: console.log, info: console.info, debug: console.debug };
  const diagnostics = new Console({ stdout: stderr, stderr });
  console.log = diagnostics.log.bind(diagnostics);
  console.info = diagnostics.info.bind(diagnostics);
  console.debug = diagnostics.debug.bind(diagnostics);
  return () => { Object.assign(console, originals); };
}
