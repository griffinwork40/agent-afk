/**
 * Unified `/skills` listing + per-skill detail rendering.
 *
 * Split out of `plugin-skills.ts` (#366) — the rendering pipeline for the
 * canonical skill listing (vendored + user + project + plugin under one
 * header) and the two `/skills` command variants (boot placeholder and the
 * post-init dynamic version).
 *
 * Detail rendering lives in `listing-detail.ts`; fuzzy search rendering lives
 * in `search-render.ts` — both are split siblings kept under 350 lines.
 */

import { getSkill, listVisibleSkills, SKILL_CATEGORIES, UNCATEGORIZED_LABEL } from '../../../skills/index.js';
import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { wrapToWidth } from '../../wrap.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { padDisplayRight, displayWidth } from '../../display.js';
import { env } from '../../../config/env.js';
import type { SlashCommand, SlashContext } from '../types.js';
import { state, bareName, type DiscoveredSkill } from './state.js';
import type { SkillManifestEntry } from '../../../agent/tools/skill-bridge.js';
import { renderSkillDetail, registryOriginToSource, friendlySource, tryGetRegistrySkill } from './listing-detail.js';
import { renderSkillSearch, buildSearchUniverse } from './search-render.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';

/**
 * Where a listing row's skill came from. Drives the friendly source label.
 *
 * Invariant: derived from the canonical union rather than restated, so a new
 * member added to `SkillManifestEntry['source']` is a compile error in
 * `friendlySource` (which stays exhaustive, with no `default` arm) instead of
 * a silent `undefined` label at runtime.
 */
type SkillSource = SkillManifestEntry['source'];

// Invariant: keyed by SkillSource, so adding a union member is a compile error
// here rather than a source silently missing from the legend — which is how
// `imported` rows came to render with no legend entry explaining them.
const LEGEND_RANK: Record<SkillSource, number> = {
  builtin: 0,
  user: 1,
  project: 2,
  plugin: 3,
  command: 4,
  imported: 5,
};
const LEGEND_ORDER = (Object.keys(LEGEND_RANK) as SkillSource[]).sort(
  (a, b) => LEGEND_RANK[a] - LEGEND_RANK[b],
);

/** A row in the unified `/skills` listing. */
interface ListingRow {
  /** Slash form for tab-completion / invocation, e.g. `/mint` or `/example-plugin:mint`. */
  slashName: string;
  /** Display form preferred when present, e.g. `/mint <idea>` or `/forge [--brief]`. */
  display: string;
  description: string;
  /** Origin of the skill — surfaced as a friendly source label, never a raw badge. */
  source: SkillSource;
}

interface ListingGroup {
  main: ListingRow;
  alts: ListingRow[];
  /** Authored category (from SkillMetadata or DiscoveredSkill). Absent = uncategorised. */
  category?: string;
}

function buildListingGroups(plugins: DiscoveredSkill[], internalUnlocked: boolean): Map<string, ListingGroup> {
  const groups = new Map<string, ListingGroup>();

  const addRow = (row: ListingRow, category?: string): void => {
    const key = bareName(row.slashName.replace(/^\//, ''));
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { main: row, alts: [], ...(category ? { category } : {}) });
    } else {
      existing.alts.push(row);
      // F3: Only adopt the alt's category when the existing main is NOT a
      // builtin — a plugin alt must not contaminate an unannotated built-in
      // skill with the plugin's own category.
      if (!existing.category && category && existing.main.source !== 'builtin') existing.category = category;
    }
  };

  // Pass 1: registry skills (vendored + user + project). Names already account
  // for collision (user-skills.ts shifts colliding names to `<origin>:<name>`),
  // so a `user:mint` lands as an alt under the vendored `mint` via addRow's
  // bare-name keying.
  for (const name of listVisibleSkills(internalUnlocked)) {
    const skill = getSkill(name);
    const slashName = `/${name}`;
    const display = skill.argumentHint ? `${slashName} ${skill.argumentHint}` : slashName;
    addRow(
      { slashName, display, description: skill.description, source: registryOriginToSource(skill.origin) },
      skill.category,
    );
  }

  // Pass 2: plugin skills. Group by bare name so a colliding plugin entry
  // becomes an alt under the vendored/user winner. For shadowed plugins,
  // surface the namespaced fallback slash (e.g. `/plugin:mint`) — that's the
  // actually-invokable form, not the bare `/mint` (which now points at the
  // vendored handler).
  const altSlashByBare = new Map(state.collisions.map((c) => [c.bare, c.altSlash]));

  for (const skill of plugins) {
    const bare = bareName(skill.name);
    const altSlash = altSlashByBare.get(bare);
    const slashName = altSlash ?? `/${skill.name}`;
    const display = skill.argumentHint ? `${slashName} ${skill.argumentHint}` : slashName;
    addRow(
      { slashName, display, description: skill.description, source: skill.source ?? 'plugin' },
      skill.category,
    );
  }

  return groups;
}

/** Sort comparator: alphabetical by bare skill name. */
function byBareName(a: ListingGroup, b: ListingGroup): number {
  const an = bareName(a.main.slashName.replace(/^\//, ''));
  const bn = bareName(b.main.slashName.replace(/^\//, ''));
  return an.localeCompare(bn);
}

/**
 * Render one skill as a wrapped two-column row: padded name on the left, the
 * word-wrapped description on the right (continuation lines hang under the
 * description column). When a name is too wide for the gutter it takes its own
 * line. Shadowed/alternative forms render as a dim `↳ also:` continuation line
 * — visible by default, never hidden behind a flag.
 */
function renderGroupRows(
  ctx: SlashContext,
  group: ListingGroup,
  nameW: number,
  descW: number,
): void {
  const { main, alts } = group;
  const wrapped = wrapToWidth(main.description, descW).split('\n');

  if (displayWidth(main.display) > nameW - 1) {
    // Name too wide for the gutter — give it its own line, hang the description.
    ctx.out.line('  ' + palette.warning(main.display));
    for (const line of wrapped) {
      ctx.out.line('  ' + ' '.repeat(nameW) + palette.dim(line));
    }
  } else {
    const paddedName = padDisplayRight(palette.warning(main.display), nameW);
    ctx.out.line('  ' + paddedName + palette.dim(wrapped[0] ?? ''));
    for (const extra of wrapped.slice(1)) {
      ctx.out.line('  ' + ' '.repeat(nameW) + palette.dim(extra));
    }
  }

  if (alts.length > 0) {
    const altForms = alts.map((a) => a.slashName).join(', ');
    for (const altLine of wrapToWidth(`↳ also: ${altForms}`, descW).split('\n')) {
      ctx.out.line('  ' + ' '.repeat(nameW) + palette.dim(altLine));
    }
  }
}

function renderUnifiedListing(ctx: SlashContext, plugins: DiscoveredSkill[], internalUnlocked: boolean): void {
  const groups = buildListingGroups(plugins, internalUnlocked);

  ctx.out.line();
  if (groups.size === 0) {
    ctx.out.line(palette.dim('  No skills available. Built-in skills should always load — check your install.'));
    ctx.out.line();
    return;
  }

  const allGroups = Array.from(groups.values());
  const altCount = allGroups.reduce((n, g) => n + g.alts.length, 0);

  // Column widths mirror the help-table layout: name column capped at ~45% of
  // the terminal, the rest for the wrapped description. Width-aware so narrow
  // terminals stay readable.
  const termW = Math.max(20, getTerminalWidth());
  const maxDisplay = allGroups.reduce((m, g) => Math.max(m, displayWidth(g.main.display)), 0);
  const nameW = Math.min(maxDisplay + 2, Math.max(10, Math.floor((termW - 2) * 0.45)));
  const descW = Math.max(12, termW - 2 - nameW);

  // Header + a one-line source legend listing only the sources actually present.
  ctx.out.line(palette.bold('Skills') + palette.dim(`  (${allGroups.length})`));
  const present = new Set(allGroups.map((g) => g.main.source));
  const legend = LEGEND_ORDER.filter((s) => present.has(s)).map(friendlySource).join(' · ');
  ctx.out.line(palette.dim(`  ${legend} — /skills <name> for details`));

  // Determine whether any skill carries a category. When none do, fall back
  // to the legacy two-block layout (Built-in / Plugins & user skills) so the
  // listing is unchanged for sessions with no authored categories.
  const hasCategoryAnnotations = allGroups.some((g) => g.category);

  if (!hasCategoryAnnotations) {
    // Legacy layout: built-in block + other block.
    const builtinGroups = allGroups.filter((g) => g.main.source === 'builtin').sort(byBareName);
    const otherGroups = allGroups.filter((g) => g.main.source !== 'builtin').sort(byBareName);

    if (builtinGroups.length > 0) {
      ctx.out.line();
      ctx.out.line(divider('Built-in'));
      for (const g of builtinGroups) renderGroupRows(ctx, g, nameW, descW);
    }
    if (otherGroups.length > 0) {
      ctx.out.line();
      ctx.out.line(builtinGroups.length > 0 ? divider('Plugins & user skills') : divider());
      for (const g of otherGroups) renderGroupRows(ctx, g, nameW, descW);
    }
  } else {
    // Category layout: skills grouped by job-to-be-done in canonical order;
    // skills without a category land in "More skills" at the end.
    // Preserve canonical render order from SKILL_CATEGORIES, skip empties.
    const byCategory = new Map<string, ListingGroup[]>();
    for (const g of allGroups) {
      // F1: Clamp OOV category strings to UNCATEGORIZED_LABEL so skills with
      // a misspelled or future category are not silently dropped from the
      // listing (they would land in a bucket that renderOrder never visits).
      const isCanonical = (SKILL_CATEGORIES as readonly string[]).includes(g.category ?? '');
      const bucket = isCanonical ? g.category! : UNCATEGORIZED_LABEL;
      const existing = byCategory.get(bucket) ?? [];
      existing.push(g);
      byCategory.set(bucket, existing);
    }

    // Emit in canonical order, then "More skills" last.
    const renderOrder: string[] = [
      ...SKILL_CATEGORIES.filter((c) => byCategory.has(c)),
      ...(byCategory.has(UNCATEGORIZED_LABEL) ? [UNCATEGORIZED_LABEL] : []),
    ];

    for (const cat of renderOrder) {
      const catGroups = (byCategory.get(cat) ?? []).sort(byBareName);
      if (catGroups.length === 0) continue;
      ctx.out.line();
      ctx.out.line(divider(sanitizeForDisplay(cat)));
      for (const g of catGroups) renderGroupRows(ctx, g, nameW, descW);
    }
  }

  ctx.out.line();
  ctx.out.line(
    palette.dim(
      altCount > 0
        ? '  Tip: ↳ also lines show alternative (shadowed) forms · /skills <name> for full details'
        : '  Tip: /skills <name> for full details on a skill',
    ),
  );
  ctx.out.line();
}

/**
 * True when `query` resolves to an exact skill by name — registry (bare or
 * namespaced) or discovered plugins. Routes to the detail card; non-matches
 * fall through to fuzzy search.
 */
function isExactSkillName(
  query: string,
  plugins: DiscoveredSkill[],
  internalUnlocked: boolean,
): boolean {
  const cleaned = query.replace(/^\//, '').trim();
  if (tryGetRegistrySkill(cleaned, internalUnlocked) !== undefined) return true;
  return plugins.some((p) => bareName(p.name) === cleaned || p.name === cleaned);
}

/**
 * Placeholder `/skills` installed at REPL boot — before the SDK session is
 * up, plugin discovery hasn't run, so we render only registry skills (which
 * are populated synchronously at module load + `registerBuiltinSkillCommands`).
 * The listing replaces this once `registerPluginSkills()` runs after init.
 */
export const initialSkillsCmd: SlashCommand = {
  name: '/skills',
  aliases: ['/builtin-skills'],
  summary: 'List all skills available in this session — vendored, user, and plugin',
  usage: '/skills [name | query]',
  hint: 'Browse every skill the session can dispatch — pass a name for full details, or a search query to find skills by intent.',
  async handler(ctx, args) {
    const internalUnlocked = env.AFK_INTERNAL === '1';
    const trimmed = args.trim();
    // A leading-dash token (e.g. `--all`) is reserved for future verbose modes;
    // for now it just renders the full listing rather than 404 as a skill name.
    if (trimmed && !trimmed.startsWith('-')) {
      if (isExactSkillName(trimmed, [], internalUnlocked)) {
        renderSkillDetail(ctx, trimmed, [], internalUnlocked);
      } else {
        renderSkillSearch(ctx, buildSearchUniverse([], internalUnlocked), trimmed);
      }
    } else {
      renderUnifiedListing(ctx, [], internalUnlocked);
    }
    return 'continue';
  },
};

/** Render the live `/skills` listing once plugin skills have been discovered. */
export function makeDynamicSkillsCmd(plugins: DiscoveredSkill[]): SlashCommand {
  return {
    name: '/skills',
    aliases: ['/builtin-skills'],
    summary: 'List all skills available in this session — vendored, user, and plugin',
    usage: '/skills [name | query]',
    hint: 'Browse every skill the session can dispatch — pass a name for full details, or a search query to find skills by intent.',
    async handler(ctx, args) {
      const internalUnlocked = env.AFK_INTERNAL === '1';
      const trimmed = args.trim();
      // A leading-dash token (e.g. `--all`) is reserved for future verbose
      // modes; for now it renders the full listing rather than 404 as a name.
      if (trimmed && !trimmed.startsWith('-')) {
        if (isExactSkillName(trimmed, plugins, internalUnlocked)) {
          renderSkillDetail(ctx, trimmed, plugins, internalUnlocked);
        } else {
          renderSkillSearch(ctx, buildSearchUniverse(plugins, internalUnlocked), trimmed);
        }
      } else {
        renderUnifiedListing(ctx, plugins, internalUnlocked);
      }
      return 'continue';
    },
  };
}
