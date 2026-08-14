/**
 * Telegram activity label formatting
 *
 * Pure helper functions that convert internal tool names and sub-agent ids
 * into short, human-readable Telegram preview labels. Extracted from
 * streaming.ts — the public surface is unchanged (re-exported there).
 * @module telegram/streaming.activity
 */

import { sanitizeLabel } from '../cli/commands/interactive/tool-lane-format-sanitize.js';

/** Max sub-agent progress lines retained in the bounded live-preview footer. */
export const MAX_SUBAGENT_PREVIEW_LINES = 4;

// Invariant: categorize a tool name by WHOLE TOKEN, and test DOMAIN tokens
// (what the tool acts on) before VERB tokens (what it does to it). Both halves
// are load-bearing, because the category vocabulary is not partitioned: `open`
// belongs to file reads AND to browser navigation, `memory` to a search AND to
// a write. Flattening the name into one string made every keyword a substring
// match across segment boundaries, and first-match-wins let a generic verb
// preempt the specific domain — so real registered tools were labeled with
// confident, wrong copy: `browser_open` → "Reading files" (verb `open` beat
// domain `browser`), `memory_update` → "Searching" (domain `memory` matched
// without its `search` verb), `terminal_font_size` → "Running a command"
// (an editor setting matched the shell keyword `terminal`).
// A name whose tokens carry no known keyword deliberately falls through to the
// readable `Using …` form: a generic label is honest, a wrong category is not.
const ACTIVITY_DOMAIN_TOKENS: readonly (readonly [readonly string[], string])[] = [
  [['browser', 'web', 'fetch', 'scrape'], 'Researching'],
  [['test', 'vitest', 'jest'], 'Running tests'],
  [['bash', 'shell', 'exec', 'command'], 'Running a command'],
];

const ACTIVITY_VERB_TOKENS: readonly (readonly [readonly string[], string])[] = [
  [['search', 'grep', 'glob', 'find'], 'Searching'],
  [['read', 'open', 'view', 'inspect'], 'Reading files'],
  [['edit', 'write', 'patch', 'replace'], 'Editing files'],
];

export function humanizeToolActivity(toolName: string): string {
  const safeName = sanitizeLabel(toolName);
  // Split on separators AND camelCase boundaries so `WebSearch`, `web_search`,
  // and `mcp__chrome-devtools__take_screenshot` all yield comparable tokens.
  const tokens = new Set(
    safeName
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  for (const [keywords, label] of [...ACTIVITY_DOMAIN_TOKENS, ...ACTIVITY_VERB_TOKENS]) {
    if (keywords.some((keyword) => tokens.has(keyword))) return label;
  }

  const readable = safeName
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return readable ? `Using ${readable}` : 'Working';
}

/**
 * Convert model/provider progress into short Telegram-facing activity copy.
 * Generic descriptions use the tool category; meaningful descriptions remain
 * available when no better structured signal exists. Tool summaries and input
 * are deliberately excluded because they commonly contain commands and paths.
 */
export function formatTelegramActivity(description?: string, toolName?: string): string {
  const safeDescription = sanitizeLabel(description ?? '').replace(/\s+/g, ' ').trim();
  const genericDescription =
    /^(working|processing|in progress|running)(?:\s*\([^)]*\))?$/i.test(safeDescription);
  if (toolName && (!safeDescription || genericDescription)) {
    return humanizeToolActivity(toolName);
  }
  return safeDescription || (toolName ? humanizeToolActivity(toolName) : 'Working');
}

/** Make internal sub-agent identifiers readable without exposing opaque UUIDs. */
export function formatTelegramAgentLabel(label: string): string {
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(label)) return 'Sub-agent';
  const readable = sanitizeLabel(label).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return readable
    ? readable.charAt(0).toUpperCase() + readable.slice(1)
    : 'Sub-agent';
}

/**
 * Render a compact, BOUNDED footer summarizing sub-agent tool activity for the
 * live preview. Returns '' when there is no activity. Pure + exported for unit
 * tests. `recent` is the rolling tail (most recent last); only the last
 * MAX_SUBAGENT_PREVIEW_LINES are shown regardless of how many are passed.
 *
 * Replaces the old behavior where the sink appended one line to the message
 * buffer per child tool call (unbounded) — a fan-out produced dozens of lines
 * and a Telegram edit per line, which also tripped Telegram's flood-control 429.
 */
export function renderSubagentFooter(steps: number, recent: readonly string[]): string {
  if (steps <= 0) return '';
  const shown = recent.slice(-MAX_SUBAGENT_PREVIEW_LINES);
  const head = `🤖 Sub-agents · ${steps} ${steps === 1 ? 'step' : 'steps'}`;
  return shown.length > 0 ? `\n${head}\n  ${shown.join('\n  ')}` : `\n${head}`;
}
