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

const CATEGORY_COLOR: Record<ToolCategory, ChalkInstance> = {
  // Read — soft sand. Reads are the highest-frequency tool category (every
  // turn involves grep/read/glob), so they need a distinct hue that isn't
  // in the blue family (which is already crowded by info/tool/fileRef).
  // Sand = "data at rest," warm and earthy.
  read: chalk.hex('#C9B584'),
  write: chalk.hex('#E8A33D'),
  shell: chalk.hex('#A8E060'),
  subagent: palette.plan,
  skill: chalk.hex('#F08AC4'),
  // teal — distinct from skill pink, subagent purple, mcp mint, and web sage.
  dag: chalk.hex('#4EC9B0'),
  mcp: chalk.hex('#5FE0C0'),
  // Web — desaturated sage. Shifted from the original #7FCDC0 so that
  // dag/mcp/web/fileRef (four teal-adjacent hues) remain perceptually
  // separable in dense tool turns.
  web: chalk.hex('#A0C4C0'),
  // Browser — bright coral/orange. Distinct from web (sage) because browser
  // tools drive a stateful headed session, not a one-shot HTTP request —
  // operators reading the tool lane should see "this is a different class of
  // I/O than web_scrape" at a glance.
  browser: chalk.hex('#FF8A65'),
  planning: palette.meta,
  // Schedule — daemon-management tools. Amber-adjacent to distinguish from
  // write (orange) without clashing with planning (meta-grey).
  schedule: chalk.hex('#D4A84B'),
  // "Other" — unknown/uncategorized tools. Routed to meta-grey rather
  // than info-sky so that an unrecognized tool name doesn't visually
  // assert the same salience as an ℹ ambient notice.
  other: palette.meta,
};

const CATEGORY_GLYPH: Record<ToolCategory, string> = {
  read: '●',
  write: '✎',
  shell: '$',
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
  other: '●',
};

export interface CategoryStyle {
  color: ChalkInstance;
  glyph: string;
}

export function styleForCategory(cat: ToolCategory): CategoryStyle {
  return { color: CATEGORY_COLOR[cat], glyph: CATEGORY_GLYPH[cat] };
}

export function styleForToolName(name: string): CategoryStyle {
  return styleForCategory(categorizeTool(name));
}
