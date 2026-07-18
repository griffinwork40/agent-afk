/**
 * /search — search the CURRENT session's conversation turns.
 *
 * Two modes:
 *   • `/search <term>`      — case-insensitive substring match over each turn's
 *                             user prompt AND assistant response. Prints one
 *                             block per matching turn (ordinal, role tag, and a
 *                             trimmed snippet around the first match with the
 *                             match emphasized), capped at the 20 most recent
 *                             matches with a "…and N more" tail.
 *   • `/search --error`/`-e` — locate the LAST tool event with `isError` across
 *                             all turns and print its turn ordinal, tool name,
 *                             and error snippet.
 *
 * Read-only: reads `ctx.stats.turns` and writes via `ctx.out` only. It never
 * mutates session state, files, or history.
 *
 * Emphasis tone: the matched substring is highlighted with `palette.warning`
 * (yellow). Cyan (`palette.user`) is reserved for user identity, so it is
 * deliberately NOT used for structural emphasis here.
 */

import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import type { SlashCommand, SlashContext, TurnRecord } from '../types.js';

/** How many characters of context to show around the first match. */
const SNIPPET_RADIUS = 90;
/** Maximum matching turns rendered before the "…and N more" tail. */
const MAX_MATCHES = 20;
/** Longest error snippet shown for `--error`. */
const ERROR_SNIPPET_MAX = 300;

/** Which side of a turn a match was found on — drives the printed role tag. */
type Role = 'user' | 'assistant';

interface Match {
  /** 1-based turn ordinal, matching /history's `#N` numbering. */
  ordinal: number;
  role: Role;
  /** Rendered snippet with the match emphasized (already colorized). */
  snippet: string;
}

/**
 * Build a colorized snippet: a window of `SNIPPET_RADIUS` characters on each
 * side of the first (case-insensitive) occurrence of `term` in `text`, with
 * the matched substring wrapped in `palette.warning`. Leading/trailing
 * ellipses mark where text was elided. Newlines are collapsed to spaces so a
 * multi-line turn renders as a single scannable line.
 *
 * Precondition: `term` occurs in `text` (callers gate on `indexOf(...) >= 0`).
 * Returns the whitespace-collapsed original if, defensively, it does not.
 */
function buildSnippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lowerFlat = flat.toLowerCase();
  const idx = lowerFlat.indexOf(term.toLowerCase());
  if (idx < 0) return flat;

  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(flat.length, idx + term.length + SNIPPET_RADIUS);

  const before = flat.slice(start, idx);
  const hit = flat.slice(idx, idx + term.length);
  const after = flat.slice(idx + term.length, end);

  const lead = start > 0 ? '…' : '';
  const trail = end < flat.length ? '…' : '';

  return `${lead}${before}${palette.warning(hit)}${after}${trail}`;
}

/**
 * Scan `turns` for a case-insensitive substring `term`. A turn matches if the
 * term appears in its user prompt OR its assistant response; the role tag
 * reflects where the FIRST match was found (user side preferred when both
 * match, since the user prompt is the more common search anchor). Returns
 * matches in turn order (oldest first) — callers slice the most recent.
 */
function findMatches(turns: readonly TurnRecord[], term: string): Match[] {
  const needle = term.toLowerCase();
  const out: Match[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const userHit = (t.user ?? '').toLowerCase().includes(needle);
    const asstHit = (t.assistant ?? '').toLowerCase().includes(needle);
    if (!userHit && !asstHit) continue;
    const role: Role = userHit ? 'user' : 'assistant';
    const source = userHit ? t.user : t.assistant;
    out.push({ ordinal: i + 1, role, snippet: buildSnippet(source, term) });
  }
  return out;
}

interface LastError {
  ordinal: number;
  toolName: string;
  snippet: string;
}

/**
 * Find the LAST tool event flagged `isError` across all turns, scanning turns
 * newest-first and, within a turn, its `toolEvents` last-first so the returned
 * event is the most recent failure in the session. Returns null when no error
 * event exists.
 */
function findLastError(turns: readonly TurnRecord[]): LastError | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const events = turns[i]!.toolEvents;
    if (!events || events.length === 0) continue;
    for (let j = events.length - 1; j >= 0; j--) {
      const ev = events[j]!;
      if (ev.isError !== true) continue;
      const raw = (ev.result ?? '').replace(/\s+/g, ' ').trim();
      const snippet = raw.length > ERROR_SNIPPET_MAX ? raw.slice(0, ERROR_SNIPPET_MAX - 1) + '…' : raw;
      return { ordinal: i + 1, toolName: ev.toolName, snippet };
    }
  }
  return null;
}

/** Colored role tag for a match block. Neither branch uses cyan (user identity). */
function roleTag(role: Role): string {
  return role === 'user'
    ? `${palette.brand('▶')} ${palette.meta('user')}`
    : `${palette.brand('◆')} ${palette.meta('assistant')}`;
}

/** Render the `--error` path: last failing tool event, or a friendly miss. */
function printLastError(ctx: SlashContext): void {
  const { stats, out } = ctx;
  const found = findLastError(stats.turns);
  if (!found) {
    out.info('No tool errors recorded in this session.');
    return;
  }
  out.line();
  out.line(palette.bold('Last tool error'));
  out.line(divider());
  const header = `  ${palette.meta(`#${found.ordinal}`)}  ${palette.warning(found.toolName)}`;
  out.line(header);
  out.line(`  ${found.snippet ? palette.dim(found.snippet) : palette.dim('(no error output captured)')}`);
  out.line();
}

/** Render the `<term>` search path. */
function printSearch(ctx: SlashContext, term: string): void {
  const { stats, out } = ctx;
  if (stats.turns.length === 0) {
    out.info('No turns yet in this session.');
    return;
  }

  const all = findMatches(stats.turns, term);
  if (all.length === 0) {
    out.info(`No matches for "${term}".`);
    return;
  }

  // Show the MOST RECENT matches: matches come back oldest-first, so the tail
  // slice is the newest MAX_MATCHES. The remainder count reflects the elided
  // (older) matches.
  const shown = all.slice(-MAX_MATCHES);
  const remainder = all.length - shown.length;

  out.line();
  out.line(palette.bold(`Search: "${term}"  (${all.length} match${all.length === 1 ? '' : 'es'})`));
  out.line(divider());
  for (const m of shown) {
    out.line(`  ${palette.meta(`#${m.ordinal}`)}  ${roleTag(m.role)}`);
    out.line(`     ${m.snippet}`);
  }
  if (remainder > 0) {
    out.line();
    out.line(palette.dim(`  …and ${remainder} more (showing the ${shown.length} most recent)`));
  }
  out.line();
}

export const searchCmd: SlashCommand = {
  name: '/search',
  usage: '/search <term> | /search --error',
  summary: 'Search this session\'s turns (or --error to jump to the last tool error)',
  hint: 'Find where something was said this session: /search <term> matches your prompts and the assistant\'s replies; /search --error jumps to the most recent tool failure.',
  flags: ['--error'],
  async handler(ctx, args) {
    const trimmed = args.trim();
    if (trimmed === '--error' || trimmed === '-e') {
      printLastError(ctx);
      return 'continue';
    }
    if (trimmed === '') {
      ctx.out.info('Usage: /search <term>   (or /search --error to jump to the last tool error)');
      return 'continue';
    }
    printSearch(ctx, trimmed);
    return 'continue';
  },
};
