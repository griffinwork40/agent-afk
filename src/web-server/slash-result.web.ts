/**
 * Maps SlashResult control variants to CommandControl wire shapes for the web
 * surface. Moved here from routes.commands.ts to keep that file lean and to
 * give the mapping a named home that can be unit-tested independently.
 *
 * `navigate` is a web-only control kind that carries a target session id;
 * it has no REPL equivalent (the REPL performs the swap synchronously inside
 * requestResume, then returns 'continue').
 *
 * `exit` maps to { kind: 'exit' } — the dashboard shows an inline "session
 * ended" notice but does NOT close the browser tab. This is intentional: the
 * user may still read the transcript and start a new session from the sidebar.
 */

import type { SlashResult } from '../cli/slash/types.js';
import type { CommandControl } from './shared/command-wire.js';

/** Normalise any SlashResult variant into the wire CommandControl shape. */
export function normalizeSlashResult(result: SlashResult): CommandControl {
  if (result === 'continue') return { kind: 'continue' };
  if (result === 'exit') return { kind: 'exit' };
  if (result === 'forward') return { kind: 'forward' };
  if (typeof result === 'object' && result !== null) {
    if ('rerun' in result) return { kind: 'rerun', input: result.rerun };
    if ('kind' in result && result.kind === 'submit') return { kind: 'submit', message: result.message };
    if ('kind' in result && result.kind === 'prefill') return { kind: 'prefill', message: result.message };
  }
  return { kind: 'continue' };
}
