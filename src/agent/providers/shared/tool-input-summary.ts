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
    // Flatten multi-line commands to a single line rather than keeping only
    // the first physical line. Models routinely emit `cd <dir> && …` split
    // across a `\`-continuation, or multi-statement scripts with the real
    // work on lines 2+. The old first-line-only slice discarded that work,
    // rendering a useless `$ bash cd <dir>` (or even `$ bash \`) — the user
    // could not tell what actually ran. Drop line-continuation backslashes,
    // then collapse every whitespace run (including newlines) to one space so
    // the meaningful verb survives into the tool-lane / progress-banner label.
    // Full fidelity is preserved separately in toolInputRaw for facet
    // derivation, so this summary is display-only and safe to flatten.
    const flat = cmd.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
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
