/**
 * Tool-category CLI styling layer.
 *
 * Pure classification logic — `categorizeTool`, `dispatchTagForCategory`,
 * the `ToolCategory` type, and the `SUBAGENT_TOOLS` / `SKILL_TOOLS` /
 * `DAG_TOOLS` / `NESTING_TOOLS` sets — lives in `src/agent/tool-category.ts`
 * so it can be consumed from the agent layer without an upward import into
 * the CLI module. This file re-exports those symbols for backward compat
 * with existing CLI import sites, and adds the chalk-backed color + glyph
 * metadata the terminal renderer needs.
 *
 * Colors are tuned to avoid colliding with the existing status palette in
 * src/cli/render.ts (green/yellow/red ● for ok/warn/error). Glyphs are all
 * single-cell Unicode that renders in macOS Terminal, iTerm2, Alacritty,
 * Kitty, and Windows Terminal without custom fonts.
 *
 * NOTE: this file is a SANCTIONED chalk owner. The per-category hues live here
 * (not in palette.ts) so each category's color stays colocated with its glyph
 * in `CATEGORY_GLYPH` below — splitting color from glyph would scatter one
 * concept across two files. `subagent`/`planning`/`other` still borrow semantic
 * palette roles. The chalk-discipline guard (scripts/audit-chalk-usage.ts)
 * allowlists this file for that reason; new raw-chalk owners should be rare and
 * carry a documented justification like this one.
 *
 * @module cli/tool-category
 */

import chalk, { type ChalkInstance } from 'chalk';
import { palette } from './palette.js';
import {
  categorizeTool,
  dispatchTagForCategory,
  SUBAGENT_TOOLS,
  SKILL_TOOLS,
  DAG_TOOLS,
  NESTING_TOOLS,
  type ToolCategory,
} from '../agent/tool-category.js';

export {
  categorizeTool,
  dispatchTagForCategory,
  SUBAGENT_TOOLS,
  SKILL_TOOLS,
  DAG_TOOLS,
  NESTING_TOOLS,
  type ToolCategory,
};

/**
 * Resolve the color for a tool category.
 *
 * Invariant: this MUST be a function, not a module-level const lookup.
 * `palette` is a live view over the active theme (see palette.ts) —
 * capturing `palette.plan` / `palette.meta` into a const at import time
 * would freeze those entries to whatever theme was active at module load,
 * so a `light` swap would leave them showing stale dark-theme hues. The
 * `chalk.hex(...)` entries are theme-agnostic literals and stay as-is.
 * Resolving per call (mirrors `buildSyntaxTheme()` in syntax-theme.ts)
 * keeps the palette-sourced entries in lock-step with `applyTheme()`.
 */
function categoryColor(cat: ToolCategory): ChalkInstance {
  switch (cat) {
    // Read — soft sand. Reads are the highest-frequency tool category (every
    // turn involves grep/read/glob), so they need a distinct hue that isn't
    // in the blue family (which is already crowded by info/tool/fileRef).
    // Sand = "data at rest," warm and earthy.
    case 'read': return chalk.hex('#C9B584');
    case 'write': return chalk.hex('#E8A33D');
    case 'shell': return chalk.hex('#A8E060');
    case 'subagent': return palette.plan;
    case 'skill': return chalk.hex('#F08AC4');
    // dag — teal. Distinct from skill pink, subagent purple, mcp cyan, and web sage.
    case 'dag': return chalk.hex('#4EC9B0');
    // mcp — cyan. Shifted off the original mint #5FE0C0, which sat only ~7° in hue
    // from dag's teal (both glyphs ⬡/⊡ are low-contrast too) and was hard to tell
    // apart from it in a dense tool lane. Cyan pulls mcp ~24° clear of dag while
    // reading as "external protocol / server," and never collides with user-cyan
    // (palette.user), which never renders in the tool lane.
    case 'mcp': return chalk.hex('#49C2E0');
    // Web — desaturated sage. Shifted from the original #7FCDC0 so that
    // dag/mcp/web/fileRef (four teal-adjacent hues) remain perceptually
    // separable in dense tool turns.
    case 'web': return chalk.hex('#A0C4C0');
    // Browser — bright coral/orange. Distinct from web (sage) because browser
    // tools drive a stateful headed session, not a one-shot HTTP request —
    // operators reading the tool lane should see "this is a different class of
    // I/O than web_scrape" at a glance.
    case 'browser': return chalk.hex('#FF8A65');
    case 'planning': return palette.meta;
    // Schedule — daemon-management tools. Amber-adjacent to distinguish from
    // write (orange) without clashing with planning (meta-grey).
    case 'schedule': return chalk.hex('#D4A84B');
    // "Other" — unknown/uncategorized tools. Routed to meta-grey rather
    // than info-sky so that an unrecognized tool name doesn't visually
    // assert the same salience as an ℹ ambient notice.
    case 'other': return palette.meta;
  }
}

const CATEGORY_GLYPH: Record<ToolCategory, string> = {
  read: '●',
  write: '✎',
  shell: '▸',
  subagent: '→',
  skill: '◆',
  // hexagon evokes the "node graph" / DAG shape; distinct from ◆ (skill)
  // and ⊡ (mcp). Single-cell width in standard monospace fonts.
  dag: '⬡',
  mcp: '⊡',
  web: '⌖',
  // globe glyph — evokes browsing; single-cell in standard monospace fonts.
  browser: '◉',
  planning: '▱',
  // calendar icon — evokes cron scheduling; single-cell in standard fonts.
  schedule: '⏲',
  other: '◌',
};

/**
 * Plain-language in-progress phrase per category, used for in-flight rows
 * (`inProgressVerb` in tool-lane-format.ts delegates here).
 *
 * Invariant: every phrase is an everyday-English present-progressive verb a
 * non-technical observer can parse — never an internal term (`forking`,
 * `dispatching a DAG`). The scrollback transcript doubles as the record shown
 * to non-engineers, so this map is the single owner of the human vocabulary;
 * add new categories here rather than hardcoding verbs at render sites.
 */
export const CATEGORY_HUMAN_VERB: Record<ToolCategory, string> = {
  read: 'Reading…',
  write: 'Writing…',
  shell: 'Running…',
  subagent: 'Delegating…',
  skill: 'Running skill…',
  dag: 'Coordinating…',
  mcp: 'Calling plugin…',
  web: 'Fetching…',
  browser: 'Browsing…',
  planning: 'Planning…',
  schedule: 'Scheduling…',
  other: 'Working…',
};

/**
 * Tool-specific verb overrides for tools whose action conflicts with their
 * category's default verb. `cancel_background_job` is categorized `subagent`
 * (it targets subagent handles) but the action is a cancellation, not a
 * delegation. Similarly, `list_schedules` / `get_schedule_history` are reads
 * and `cancel_schedule` is a removal, not scheduling. The override is checked
 * first by `humanVerbForTool`; missing entries fall through to the category.
 */
const TOOL_VERB_OVERRIDES: Partial<Record<string, string>> = {
  cancel_background_job: 'Cancelling…',
  list_schedules: 'Reading…',
  get_schedule_history: 'Reading…',
  cancel_schedule: 'Cancelling…',
};

/**
 * Resolve the plain-language in-progress verb for a tool, checking
 * tool-specific overrides before falling back to the category default.
 */
export function humanVerbForTool(toolName: string): string {
  return TOOL_VERB_OVERRIDES[toolName] ?? CATEGORY_HUMAN_VERB[categorizeTool(toolName)];
}

export interface CategoryStyle {
  color: ChalkInstance;
  glyph: string;
}

export function styleForCategory(cat: ToolCategory): CategoryStyle {
  return { color: categoryColor(cat), glyph: CATEGORY_GLYPH[cat] };
}

export function styleForToolName(name: string): CategoryStyle {
  return styleForCategory(categorizeTool(name));
}
