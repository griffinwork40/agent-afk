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
    const firstLine = cmd.split('\n')[0]!;
    return ' ' + (firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine);
  }
  const query = obj['query'] ?? obj['pattern'] ?? obj['url'] ?? obj['description'];
  if (typeof query === 'string') return ' ' + query;
  return '';
}
