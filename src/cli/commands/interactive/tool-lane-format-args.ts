import { palette } from '../../palette.js';
import {
  categorizeTool,
  dispatchTagForCategory,
  styleForToolName,
} from '../../tool-category.js';
import { truncateDisplayWidth, displayWidth } from '../../display.js';
import { sanitizeLabel } from './tool-lane-format-sanitize.js';

/**
 * Collapse absolute filesystem paths with 3+ segments to their basename
 * (`/Users/me/proj/src/x.ts` → `x.ts`) while leaving URLs intact.
 *
 * URL-safety matters because tool args frequently carry URLs (`web_scrape`,
 * `browser_open`, `curl …` bash commands). The bare path-collapsing regex
 * eats a URL's host + path — `https://x.com/a/b/c` → `https:/c` — so the
 * user can't tell what was fetched (the "web_scrape shows nothing useful"
 * report). We split `scheme://…` spans out first, emit them verbatim, and
 * only collapse paths in the gaps between them. The URL span deliberately
 * allows RFC-valid path punctuation such as commas and parentheses so a URL
 * like `https://example.com/a,b/c/d/e` is not split and mangled.
 */
export function shortenPaths(text: string): string {
  const urlSpan = /[a-z][a-z0-9+.-]*:\/\/[^\s<>\"`]+/gi;
  let result = '';
  let lastIndex = 0;
  for (const match of text.matchAll(urlSpan)) {
    const url = match[0] ?? '';
    const start = match.index ?? lastIndex;
    result += collapseFsPaths(text.slice(lastIndex, start));
    result += url;
    lastIndex = start + url.length;
  }
  result += collapseFsPaths(text.slice(lastIndex));
  return result;
}

/** Collapse absolute paths with 3+ segments to their basename. */
function collapseFsPaths(text: string): string {
  return text.replace(/\/(?:[^/\s,)]+\/){2,}([^/\s,)]+)/g, '$1');
}

/**
 * Strip a single leading `cd <dir> && ` from a bash command string,
 * surfacing the actual command verb. Common pattern from skill bridges:
 * every `bash` call is wrapped as `cd /path/to/repo && <real-command>`.
 * Without stripping, every line renders as `$ bash cd agent-afk &&…`
 * with the meaningful command truncated off.
 *
 * Conservative rules — fail-open to the original string:
 * - Only strips at the very start (after optional whitespace/paren).
 * - Only strips a single `cd` segment; chained `cd a && cd b && cmd`
 *   keeps everything intact (later `cd`s are probably meaningful).
 * - Only strips when followed by another non-`cd` command on the same line.
 */
function stripBashCdPrefix(args: string): string {
  const match = /^(\s*[("]?\s*)cd\s+\S+\s+&&\s+(?!cd\s)(.+)$/.exec(args);
  if (!match) return args;
  return (match[1] ?? '') + (match[2] ?? '');
}

/**
 * Maximum readable width of the bracketed label produced by
 * {@link summarizeNestingArgs} for `agent` / `Task` / `skill` calls. Picked
 * to fit comfortably alongside the tool name + ` [subagent]` tag in a
 * standard 80-col terminal — `bracketPairAwareTruncate` clamps further on
 * narrower widths.
 */
const NESTING_LABEL_MAX = 60;

/**
 * Extract a short readable label from a JSON args blob for a subagent /
 * skill / DAG dispatch tool. Returns `(label)` (paren-wrapped, suitable
 * for {@link bracketPairAwareTruncate}) on success, or the original `args`
 * unchanged on parse failure or when none of `fields` resolve to a
 * non-empty string.
 *
 * Invariant: callers receive a paren-balanced summary so the downstream
 * truncator preserves the closer; fail-open returns the raw input so
 * existing path-shortening / sanitization still applies.
 *
 * History: prior to this helper, `agent` / `Task` / `skill` toolInput was
 * passed through `summarizeToolArgs` unchanged, leaking the full JSON
 * body (e.g. `{"description":"**BUG 2..."}`) into the topology spine
 * during the addStart→mergeAgentLabel window. See docs/tui-tool-lane.md.
 */
function summarizeNestingArgs(args: string, fields: readonly string[]): string {
  // Mirror the `compose` handler: args may arrive `(...)`-wrapped through
  // the chunk formatter, or raw JSON when arriving as a string. Strip a
  // single outer paren pair before parsing so both shapes work.
  const stripped = args.trim().replace(/^\((.*)\)$/s, '$1');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return args;
  }
  if (!parsed || typeof parsed !== 'object') return args;
  const obj = parsed as Record<string, unknown>;
  for (const field of fields) {
    const value = obj[field];
    if (typeof value === 'string' && value.length > 0) {
      // sanitizeLabel strips ANSI sequences + C0/C1/DEL bytes then collapses
      // whitespace — prevents LLM-controlled prompt/description/arguments
      // values from injecting terminal control sequences through the tool
      // lane display. truncateDisplayWidth clips by display columns to
      // preserve surrogate pairs and wide-character alignment.
      const flat = sanitizeLabel(value);
      if (flat.length === 0) continue;
      const clipped = flat.length > NESTING_LABEL_MAX
        ? truncateDisplayWidth(flat, NESTING_LABEL_MAX, '…')
        : flat;
      return `(${clipped})`;
    }
  }
  return args;
}

/**
 * Per-tool argument summarizer. Some tools emit raw JSON that is unreadable
 * after truncation (e.g. `compose` with `{"nodes":[{...},{...}],"edges":[...]}`
 * truncates to `…` and tells the user nothing). When the args match a
 * recognized shape, replace them with a compact human-readable summary;
 * otherwise return the original unchanged so the existing truncation path
 * runs. Pure, deterministic, fail-open — any parse error returns the input.
 */
export function summarizeToolArgs(name: string, args: string): string {
  if (name === 'bash' || name === 'Bash') {
    return stripBashCdPrefix(args);
  }
  // `compose` input is `(...)`-wrapped JSON when arriving through the chunk
  // formatter, or raw JSON when arriving as a string. Strip a single outer
  // paren pair before parsing so both shapes work.
  if (name === 'compose' || name === 'Compose') {
    const stripped = args.trim().replace(/^\((.*)\)$/s, '$1');
    try {
      const parsed = JSON.parse(stripped);
      if (parsed && typeof parsed === 'object') {
        const nodes = Array.isArray((parsed as { nodes?: unknown }).nodes)
          ? (parsed as { nodes: unknown[] }).nodes.length
          : undefined;
        const edges = Array.isArray((parsed as { edges?: unknown }).edges)
          ? (parsed as { edges: unknown[] }).edges.length
          : 0;
        if (nodes !== undefined) {
          const nodeStr = `${nodes} node${nodes === 1 ? '' : 's'}`;
          const edgeStr = edges > 0 ? `, ${edges} edge${edges === 1 ? '' : 's'}` : '';
          return `(${nodeStr}${edgeStr})`;
        }
      }
    } catch {
      /* fall through to original args */
    }
  }
  // Subagent dispatch: AFK's `agent` tool uses `prompt` (long body) and
  // optional `id_prefix` (short label for log correlation). Prefer the
  // explicit label when set, otherwise fall back to a clip of the prompt.
  if (name === 'agent' || name === 'Agent') {
    return summarizeNestingArgs(args, ['id_prefix', 'prompt']);
  }
  // Anthropic's built-in Task tool uses `description` (short label) and
  // `prompt` (long body). Mirror the same priority.
  if (name === 'Task') {
    return summarizeNestingArgs(args, ['description', 'prompt']);
  }
  // Skill dispatch: `name` is the dominant identifier; `arguments` is a
  // free-form string we surface as a secondary label when present.
  if (name === 'skill' || name === 'Skill') {
    return summarizeNestingArgs(args, ['name', 'arguments']);
  }
  // `ask_question` renders the actual question text inside the elicitation
  // overlay frame (src/cli/elicitation-repl.ts → buildOverlayHeader). If
  // the tool-lane row ALSO prints the question via the raw args, the same
  // string ends up on screen in two places — the "duped" UX users hit.
  // Collapse the args row to a category hint (`(text)`, `(choice: 3 options)`,
  // …) so the audit-trail line stays present and informative but doesn't
  // echo the question content. Fail-open: any parse failure returns the
  // original args so we never silently swallow a malformed tool call.
  if (name === 'ask_question') {
    return summarizeAskQuestionArgs(args);
  }
  return args;
}

/**
 * Produce a compact, category-only summary of an `ask_question` tool
 * input — e.g. `(text)`, `(confirm)`, `(choice: 3 options)`,
 * `(multi_choice: 5 options)`, `(number)`. Avoids echoing the
 * `question` payload, which the elicitation overlay already shows.
 *
 * Accepts both `(...)` paren-wrapped and raw JSON shapes (mirrors the
 * `compose` parser above — both forms reach this function depending
 * on where the chunk formatter intercepts the input).
 *
 * Fail-open: malformed JSON or missing fields return the original args
 * unchanged so the existing path-shortening / truncation still runs and
 * a misshapen tool call is at least somewhat legible.
 */
function summarizeAskQuestionArgs(args: string): string {
  const stripped = args.trim().replace(/^\((.*)\)$/s, '$1');
  try {
    const parsed = JSON.parse(stripped);
    if (!parsed || typeof parsed !== 'object') return args;
    const obj = parsed as Record<string, unknown>;
    const rawType = typeof obj['type'] === 'string' ? (obj['type'] as string) : 'text';
    if (rawType === 'choice' || rawType === 'multi_choice') {
      const choices = obj['choices'];
      const count = Array.isArray(choices) ? choices.length : 0;
      if (count > 0) return `(${rawType}: ${count} option${count === 1 ? '' : 's'})`;
      return `(${rawType})`;
    }
    return `(${rawType})`;
  } catch {
    return args;
  }
}

/** Replace any run of CR/LF characters with a single space. */
function sanitizePrefixString(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

/**
 * Map of bracket-pair openers to their matching closer. Used by
 * {@link bracketPairAwareTruncate} to detect args that were originally
 * balanced (e.g. `(review)`, `{node: 1}`, `[a, b]`) so the closer can be
 * preserved after truncation.
 */
const BRACKET_PAIRS: Record<string, string> = { '(': ')', '{': '}', '[': ']' };

/**
 * Truncate `args` to `maxWidth` columns while preserving a balanced
 * closing bracket if `args` starts and ends with a matching pair.
 *
 * Why this matters: plain {@link truncateDisplayWidth} on `(review)` at
 * width 20 (e.g. deeply-nested Agent dispatch on a narrow terminal)
 * produces `(…`, leaving the user staring at an unmatched opener. The
 * downstream renderer then appends a ` [subagent]` dispatch tag, and the
 * user sees `Agent(… [subagent]` — visually broken bracket pairs that
 * looked like a rendering bug ('what closed that paren?').
 *
 * Fix shape: if args has the form `<open><body><close>` where open/close
 * is one of `()`, `{}`, `[]`, reserve one display column for the closer
 * and append it after truncating the rest, so the output ends `…)` /
 * `…}` / `…]` instead of `…`.
 *
 * Pure, total. Falls back to plain truncate when:
 * - `args` is not bracket-balanced (no matching opener/closer), OR
 * - `displayWidth(args) <= maxWidth` (no truncation needed), OR
 * - `maxWidth < 3` (no room for `<open>…<close>` minimum shape).
 */
export function bracketPairAwareTruncate(
  args: string,
  maxWidth: number,
  ellipsis: string = '…',
): string {
  const opener = args.charAt(0);
  const closer = BRACKET_PAIRS[opener];
  const isBalanced = closer && args.endsWith(closer) && args.length >= 2;

  // Fast path: not bracket-balanced, OR args already fits as-is.
  if (!isBalanced || displayWidth(args) <= maxWidth) {
    return truncateDisplayWidth(args, maxWidth, ellipsis);
  }
  // Narrow-budget path: not enough room for `<open>…<close>` (3 cols). If
  // we can fit `<open><close>` (2 cols), collapse to that so the pair
  // stays balanced; below 2 cols, give up and plain-truncate. This is the
  // case that produced `Agent(…` for `(review)` at argsMaxWidth=2 — the
  // tag-suffix budget was eating the closing-paren column.
  if (maxWidth < 3) {
    if (maxWidth >= 2) return opener + closer;
    return truncateDisplayWidth(args, maxWidth, ellipsis);
  }
  // Common path: reserve 1 col for the closer so the result ends `…<closer>`.
  const truncated = truncateDisplayWidth(args, maxWidth - 1, ellipsis);
  return truncated + closer;
}

/**
 * Format a tool_use summary into `{glyph} {Name}{args} {[tag]}?`.
 *
 * Dispatch-class tools (subagent / skill / dag) get a dim trailing
 * bracketed type tag — `[subagent]`, `[skill]`, `[dag]` — so the class
 * of work is legible as text even when colors or glyphs are hard to
 * distinguish. See `dispatchTagForCategory` in `tool-category.ts`.
 */
export function formatToolLine(content: string, maxWidth?: number): string {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/s.exec(content);
  if (match) {
    const name = match[1]!;
    // Tool-specific summarization runs BEFORE path-shortening / truncation
    // so the summary determines the budget, not the raw JSON.
    let args = shortenPaths(summarizeToolArgs(name, match[2] ?? ''));
    const category = categorizeTool(name);
    const { color, glyph } = styleForToolName(name);
    const dispatchTag = dispatchTagForCategory(category);
    const tagSuffix = dispatchTag ? ` [${dispatchTag}]` : '';
    if (maxWidth !== undefined) {
      // Measure fixed prefix + suffix width in plain chars; budget the
      // remainder for args. args + suffix are plain text here (pre-ANSI
      // colorization) — truncate args before coloring.
      //
      // bracketPairAwareTruncate preserves a balanced closing bracket on
      // truncation so `(review)` at narrow widths renders `(rev…)` not
      // `(rev…`. The fallback inside the helper is plain truncate when
      // args isn't bracket-balanced — leaf tools (bash, read_file, etc.)
      // whose args don't start with a paired bracket behave identically.
      const fixedWidth = (glyph + ' ').length + name.length + tagSuffix.length;
      const argsMaxWidth = Math.max(1, maxWidth - fixedWidth);
      args = bracketPairAwareTruncate(args, argsMaxWidth);
    }
    args = sanitizePrefixString(args);
    const head = color(glyph + ' ') + color.bold(name) + palette.toolArg(args);
    return dispatchTag ? head + palette.dim(tagSuffix) : head;
  }
  // Use `chrome` (slate grey), not `tool` — the bullet here is structural
  // scaffolding when no per-tool category color applies. `palette.tool` is
  // reserved for syntax highlighting (function/class/title) in code blocks.
  return palette.chrome('● ') + palette.toolArg(content);
}
