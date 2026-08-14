/**
 * XML tag constants and breadcrumb formatter for command input metadata.
 */

import { escapeRegExp } from '../../../utils/regexp.js';

export const COMMAND_NAME_TAG = 'command-name';
export const COMMAND_MESSAGE_TAG = 'command-message';
export const COMMAND_ARGS_TAG = 'command-args';

export function formatCommandBreadcrumb(
  name: string,
  args: string,
): string {
  return `<${COMMAND_NAME_TAG}>/${name}</${COMMAND_NAME_TAG}>
            <${COMMAND_MESSAGE_TAG}>${name}</${COMMAND_MESSAGE_TAG}>
            <${COMMAND_ARGS_TAG}>${args}</${COMMAND_ARGS_TAG}>`;
}

// Matches a command tag that occupies its own line (possibly with leading
// horizontal whitespace), capturing the preceding newline (or ^ at start)
// so we can restore it without the blank line the tag line would otherwise leave.
// The trailing \n? eats the newline that terminates the tag line.
//
// Why not a simple global /^\n+/ trim? Because stripCommandTags is called
// per-delta in the streaming orchestrator. Local OpenAI-compatible servers
// (e.g. mlx_lm.server / Qwen3) emit tokens char-by-char, so a lone '\n' delta
// is common. A whole-string trim would turn '\n' → '' and the orchestrator's
// `if (!cleaned) return` guard would discard it, collapsing all paragraph
// breaks into one block. Anthropic bundles tokens so this rarely surfaced
// there; local model streams hit it constantly.
//
// The fix: clean up newlines scoped to tag neighbourhoods, not the full string.
// Leading/trailing \n trims are re-applied ONLY when a tag was actually removed.
const COMMAND_TAG_PAT = `<(?:${COMMAND_NAME_TAG}|${COMMAND_MESSAGE_TAG}|${COMMAND_ARGS_TAG})[\\s\\S]*?</(?:${COMMAND_NAME_TAG}|${COMMAND_MESSAGE_TAG}|${COMMAND_ARGS_TAG})>`;
const COMMAND_LINE_TAG_RE = new RegExp(`(\\n|^)[ \\t]*${COMMAND_TAG_PAT}[ \\t]*\\n?`, 'gm');
const COMMAND_INLINE_TAG_RE = new RegExp(COMMAND_TAG_PAT, 'g');

/**
 * Invariant (line-scoped, never string-scoped): normalize a whitespace-only
 * LINE to empty so `\n   \n` still reads as a paragraph break ('\n\n') to
 * findBlockBoundary — but ONLY when the input actually contains a line boundary.
 *
 * `^`/`$` under /m also match the STRING's own ends, so a bare `/^[ \t]+$/gm`
 * matched an input consisting solely of spaces. Both callers run PER DELTA in
 * the streaming orchestrator, where a lone ' ' delta is an ordinary word
 * separator, not a blank line. Annihilating it there — the empty result is then
 * discarded outright by the orchestrator's `if (!cleaned) return` guard — fused
 * the neighbouring words on screen: "The" + " " + "6 lint errors" rendered as
 * "The6 lint errors", and "branch," + " " + "as requested." as "branch,as
 * requested.". Requiring a newline preserves the blank-line normalization
 * (which by definition needs a line boundary to exist) while letting a
 * separator-only delta through verbatim. Same reasoning as each caller's
 * `tagsRemoved` guard on the leading/trailing newline trim, for spaces.
 */
function normalizeWhitespaceOnlyLines(text: string): string {
  if (!text.includes('\n')) return text;
  return text.replace(/^[ \t]+$/gm, '');
}

export function stripCommandTags(text: string): string {
  let tagsRemoved = false;
  // Pass 1 — line-level tags: restore the preceding \n but eat the tag line
  let result = text.replace(COMMAND_LINE_TAG_RE, (_, pre: string) => {
    tagsRemoved = true;
    return pre;
  });
  // Pass 2 — inline tags (tag embedded in a line with surrounding prose)
  result = result.replace(COMMAND_INLINE_TAG_RE, () => {
    tagsRemoved = true;
    return '';
  });
  result = normalizeWhitespaceOnlyLines(result);
  result = result.replace(/\n{3,}/g, '\n\n');
  // Only trim string-level leading/trailing newlines when we removed a tag —
  // a delta that is purely '\n' with no tags must survive unchanged.
  if (tagsRemoved) {
    result = result.replace(/^\n+/, '').replace(/\n+$/, '');
  }
  return result;
}


/**
 * Detect and strip `<skillName>` / `</skillName>` tags from content.
 * Returns the cleaned text and whether an opening tag was found (so
 * the caller can emit a styled badge once).
 */
export function extractSkillTag(
  text: string,
  skillName: string,
): { text: string; found: boolean } {
  const escaped = escapeRegExp(skillName);
  // Detect presence before any mutation
  const openInlineRe = new RegExp(`<${escaped}>`, 'g');
  const found = openInlineRe.test(text);
  openInlineRe.lastIndex = 0;

  // Same two-pass + conditional-trim strategy as stripCommandTags.
  const openLineRe = new RegExp(`(\\n|^)[ \\t]*<${escaped}>[ \\t]*\\n?`, 'gm');
  const closeLineRe = new RegExp(`(\\n|^)[ \\t]*</${escaped}>[ \\t]*\\n?`, 'gm');
  const closeInlineRe = new RegExp(`</${escaped}>`, 'g');

  let tagsRemoved = false;
  let result = text;
  result = result.replace(openLineRe, (_, pre: string) => { tagsRemoved = true; return pre; });
  result = result.replace(closeLineRe, (_, pre: string) => { tagsRemoved = true; return pre; });
  result = result.replace(openInlineRe, () => { tagsRemoved = true; return ''; });
  result = result.replace(closeInlineRe, () => { tagsRemoved = true; return ''; });
  result = normalizeWhitespaceOnlyLines(result);
  result = result.replace(/\n{3,}/g, '\n\n');
  if (tagsRemoved) {
    result = result.replace(/^\n+/, '').replace(/\n+$/, '');
  }
  return { text: result, found };
}
