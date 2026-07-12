/**
 * Provider-neutral tool-input summary helper.
 *
 * Produces a one-line annotation appended to `tool.use.start` event labels so
 * the interactive tool lane renders `read_file /foo/bar.ts` rather than a bare
 * `read_file [read_file]`. Intentionally pure — no I/O, no SDK imports.
 *
 * Previously duplicated verbatim in:
 *   - `anthropic-direct/loop.ts`   (`summarizeToolInput`)
 *   - `openai-compatible/query.ts` (`summarizeToolInput`)
 *
 * Both copies have been replaced with an import from this module.
 *
 * @module agent/providers/shared/tool-input-summary
 */

import { redactSecrets } from '../../redact-secrets.js';

/**
 * Backstop cap on the flattened `command`/`cmd` summary length (display
 * columns are approximated by characters here). This is NOT the primary
 * width bound — the tool lane and progress banner each truncate to the live
 * terminal width downstream. The cap only guards the event-stream / telegram
 * label against a pathological multi-KB one-liner (base64 blob, giant `sed`
 * script). Set well above a typical terminal width so that on normal displays
 * the terminal — not this cap — decides where the command is elided; the old
 * 80-char cap truncated "too early" on wide terminals even for short commands.
 */
const COMMAND_SUMMARY_MAX = 160;

/**
 * Best-effort one-line summary of a tool input, appended to the tool-lane
 * label in the interactive REPL.
 *
 * Skill dispatch: the `name` field IS the skill being invoked (diagnose,
 * review, mint, …). Surface it as a paren-wrapped label so the tool lane
 * renders `skill(diagnose)` instead of a bare `skill [skill]` — matching the
 * `Agent(<label>)` dispatch convention and the paren-wrap signal the overflow
 * renderer keys on (cli/commands/interactive/tool-lane-render-grouping-overflow.ts).
 * Unlike `agent`, a skill's label is fully known from the tool input, so it
 * needs no deferred mergeAgentLabel promotion — and it MUST be surfaced here
 * because load-mode skills never fork a child Agent row to carry the name.
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  if (toolName === 'skill' || toolName === 'Skill') {
    const skillName = obj['name'];
    if (typeof skillName === 'string' && skillName.length > 0) {
      return `(${skillName.length > 60 ? skillName.slice(0, 59) + '…' : skillName})`;
    }
    return '';
  }
  const path = obj['file_path'] ?? obj['path'] ?? obj['filePath'];
  if (typeof path === 'string') return ' ' + path;
  const cmd = obj['command'] ?? obj['cmd'];
  if (typeof cmd === 'string') {
    // Invariant: this summary is NOT display-only — it becomes the tool-use
    // event's `toolInput`, which is externalized to at-rest storage (the
    // session sidecar via saveSession; events.jsonl via session-ledger) AND
    // over the network (telegram streaming). Two steps happen here, in order:
    //   1. Flatten the whole command to one line — drop `\`-continuations,
    //      collapse whitespace/newline runs. Models emit `cd <dir> && …` split
    //      across continuations, or multi-statement scripts with the real work
    //      on lines 2+; the old first-line-only slice discarded it, rendering a
    //      useless `$ bash cd <dir>` (or even `$ bash \`).
    //   2. Redact inline secrets. The raw-input whitelist (raw-input.ts) keeps
    //      the raw `command` out of `inputRaw`, but this flattened summary would
    //      otherwise carry secrets on lines 2+ (`export TOKEN=…`,
    //      `Authorization: Bearer …`) into every sink above. Redacting at this
    //      single source closes them all at once; command structure is
    //      preserved for the operator (verbs and `git commit -m "msg"` survive)
    //      — only opaque ≥32-char tokens and key/bearer/JWT patterns become
    //      [REDACTED]. Redact BEFORE the length cap so a token is never split
    //      below the detector threshold.
    const flat = redactSecrets(cmd.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim());
    return (
      ' ' +
      (flat.length > COMMAND_SUMMARY_MAX
        ? flat.slice(0, COMMAND_SUMMARY_MAX - 1) + '…'
        : flat)
    );
  }
  const query = obj['query'] ?? obj['pattern'] ?? obj['url'] ?? obj['description'];
  if (typeof query === 'string') return ' ' + query;
  return '';
}
