import { emitKeypressEvents, type Interface } from 'readline';

/**
 * Sets `escapeCodeTimeout` to 50ms (see {@link LONE_ESC_TIMEOUT_MS}) for
 * `readline.emitKeypressEvents`, so a lone ESC fires on the FIRST press
 * without misreading split escape sequences. 50ms is the ONLY value AFK ships;
 * the 500ms mentioned below is Node's DEFAULT, which this module overrides.
 *
 * History: ESC is the soft-stop / cancel affordance across AFK's TTY surfaces
 * (compositor stream-stop, reader, elicitation prompts). Node's readline
 * buffers a chunk-trailing `\x1b` for `escapeCodeTimeout` — whose default is
 * 500ms (the GNU readline keyseq-timeout) — to disambiguate a lone ESC from
 * the start of an escape sequence (arrows, alt-keys): the `escape` keypress
 * fires only after that timeout OR when the next key arrives. Under Node's
 * 500ms default ESC "needs two presses" (the second press flushes the first
 * buffered ESC); overriding it to 50ms below is what makes a single ESC
 * register.
 *
 * Why a small NONZERO timeout (not 0): the disambiguation window only needs
 * to drop below human perception (~100ms) to fix the double-press bug — it
 * does NOT need to be 0. Multi-byte sequences usually arrive in a single read
 * chunk (the local-TTY norm: ESC[A → up, ESC+a → alt+a) and decode
 * synchronously, but a slow/remote PTY (e.g. `ssh -t`) can deliver a sequence
 * across multiple `data` events — a TCP-fragmented bracketed-paste start
 * (`\x1b[200~`, which AFK enables via `\x1b[?2004h`) or an arrow `\x1b[A`. At
 * `escapeCodeTimeout: 0` Node flushes the lone leading `\x1b` after one
 * event-loop tick, before the remaining bytes land, so it surfaces as a bare
 * `escape` keypress — which `handleEscape`/the elicitation prompts fire
 * soft-stop/cancel on (no `sequence` guard). 50ms keeps lone-ESC well below
 * perceptible latency while leaving enough of a reassembly window for a
 * fragmented sequence to coalesce into its real keypress. (Codex review
 * #626.)
 *
 * The timeout rides on the second arg, which Node reads as
 * `iface.escapeCodeTimeout`. @types/node types that arg as a full
 * `readline.Interface` (it never modelled the documented `escapeCodeTimeout`
 * option on a bare object), so we cast the minimal shape Node actually
 * dereferences. The cast is the single auditable point of that unsoundness
 * for every keypress surface in the CLI.
 */
const LONE_ESC_TIMEOUT_MS = 50;

export function emitKeypressEventsImmediateEscape(stream: NodeJS.ReadableStream): void {
  emitKeypressEvents(stream, { escapeCodeTimeout: LONE_ESC_TIMEOUT_MS } as unknown as Interface);
}
