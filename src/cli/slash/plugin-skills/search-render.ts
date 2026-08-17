/**
 * Render layer for `/skills <query>` intent-based fuzzy search results.
 *
 * Called from `listing.ts` when the user passes a non-empty, non-flag,
 * non-exact-name query. Displays a ranked table of matches (best first)
 * and emits a tip pointing to `/skills <name>` for full details.
 *
 * Split into a sibling file so `listing.ts` stays under the 350-line cap.
 */

import { getSkill, listVisibleSkills } from '../../../skills/index.js';
import { palette } from '../../palette.js';
import { wrapToWidth } from '../../wrap.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { padDisplayRight, displayWidth } from '../../display.js';
import type { SlashContext } from '../types.js';
import { searchSkills, type SearchableSkill, type SearchResult } from './search.js';
import { extractHintFromDescription } from './flags.js';
import { state, bareName, type DiscoveredSkill } from './state.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';

/**
 * Build a flat universe of searchable skills from the registry + discovered
 * plugins. Each entry carries the bare name (without leading `/`), description,
 * and an optional hint drawn from `argumentHint` or `whenToUse` fallback.
 */
export function buildSearchUniverse(
  plugins: DiscoveredSkill[],
  internalUnlocked: boolean,
): SearchableSkill[] {
  const universe: SearchableSkill[] = [];

  // Track names already added from the registry to prevent plugin duplicates.
  const registryNames = new Set<string>();

  for (const name of listVisibleSkills(internalUnlocked)) {
    const skill = getSkill(name);
    const hintText = skill.argumentHint ?? extractHintFromDescription(skill.description);
    universe.push({
      name,
      description: skill.description,
      ...(hintText !== undefined ? { hint: hintText } : {}),
    });
    registryNames.add(name);
    // Also track the bare name so a namespaced registry entry like `user:mint`
    // prevents a plugin `mint` from being added again.
    registryNames.add(bareName(name));
  }

  for (const plugin of plugins) {
    const bare = bareName(plugin.name);
    // Skip if this name (full or bare) is already represented by a registry entry.
    if (registryNames.has(plugin.name) || registryNames.has(bare)) continue;

    // For colliding entries, advertise the alt slash name so search results
    // reflect the actual slash the user must type, not the shadowed bare name.
    const collision = state.collisions.find((c) => c.bare === bare);
    const advertisedName = collision
      ? collision.altSlash.replace(/^\//, '')
      : plugin.name;

    const hintText = plugin.argumentHint ?? extractHintFromDescription(plugin.description);
    universe.push({
      name: advertisedName,
      description: plugin.description,
      ...(hintText !== undefined ? { hint: hintText } : {}),
    });
  }

  return universe;
}

// Re-export SearchableSkill so callers can type the universe without importing from search.ts.
export type { SearchableSkill };

/**
 * Render a search result row identical in style to the main listing:
 * padded display name on the left, wrapped description on the right.
 * Uses `palette.warning` to visually distinguish search results from the
 * regular listing rows.
 */
function renderSearchRow(
  ctx: SlashContext,
  result: SearchResult,
  nameW: number,
  descW: number,
): void {
  const { skill } = result;
  const slash = `/${skill.name}`;
  const displayName = skill.hint ? `${slash} ${skill.hint}` : slash;
  const wrapped = wrapToWidth(skill.description, descW).split('\n');

  if (displayWidth(displayName) > nameW - 1) {
    ctx.out.line('  ' + palette.warning(displayName));
    for (const line of wrapped) {
      ctx.out.line('  ' + ' '.repeat(nameW) + palette.dim(line));
    }
  } else {
    const paddedName = padDisplayRight(palette.warning(displayName), nameW);
    ctx.out.line('  ' + paddedName + palette.dim(wrapped[0] ?? ''));
    for (const extra of wrapped.slice(1)) {
      ctx.out.line('  ' + ' '.repeat(nameW) + palette.dim(extra));
    }
  }
}

/**
 * Execute a fuzzy search over `universe` for `query` and render the results
 * into `ctx`. Renders a "no results" hint when nothing matches.
 *
 * `query` must be pre-trimmed (non-empty, non-flag, non-exact-name). The
 * caller is responsible for routing: only call this when the query does NOT
 * match any skill by exact name (exact-name lookups keep the detail-card path).
 */
export function renderSkillSearch(
  ctx: SlashContext,
  universe: readonly SearchableSkill[],
  query: string,
): void {
  const results = searchSkills(universe, query);

  ctx.out.line();

  if (results.length === 0) {
    ctx.out.line(palette.dim(`  No skills matched "${sanitizeForDisplay(query)}".`));
    ctx.out.line(palette.dim('  Try a shorter term, or run /skills to browse everything.'));
    ctx.out.line();
    return;
  }

  // Column widths — mirror the main listing layout.
  const termW = Math.max(20, getTerminalWidth());
  const maxDisplay = results.reduce(
    (m, r) => Math.max(m, displayWidth(r.skill.hint ? `/${r.skill.name} ${r.skill.hint}` : `/${r.skill.name}`)),
    0,
  );
  const nameW = Math.min(maxDisplay + 2, Math.max(10, Math.floor((termW - 2) * 0.45)));
  const descW = Math.max(12, termW - 2 - nameW);

  ctx.out.line(
    palette.bold('Skills matching') + palette.dim(`  "${sanitizeForDisplay(query)}"`) +
    palette.dim(`  (${results.length} result${results.length === 1 ? '' : 's'})`),
  );
  ctx.out.line();

  for (const result of results) {
    renderSearchRow(ctx, result, nameW, descW);
  }

  ctx.out.line();
  ctx.out.line(palette.dim('  Tip: /skills <name> for full details · /skills to browse everything'));
  ctx.out.line();
}
