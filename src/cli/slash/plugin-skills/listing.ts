/**
 * Unified `/skills` listing + per-skill detail rendering.
 *
 * Split out of `plugin-skills.ts` (#366) — the rendering pipeline for the
 * canonical skill listing (vendored + user + project + plugin under one
 * header) and the two `/skills` command variants (boot placeholder and the
 * post-init dynamic version).
 */

import { getSkill, isSkillVisible, listVisibleSkills, type SkillMetadata } from '../../../skills/index.js';
import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { wrapToWidth } from '../../wrap.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { padDisplayRight, displayWidth } from '../../display.js';
import { env } from '../../../config/env.js';
import type { SlashCommand, SlashContext } from '../types.js';
import { harvestAllPluginSkillFlags, extractHintFromDescription } from './flags.js';
import { state, bareName, type DiscoveredSkill } from './state.js';

/** Where a listing row's skill came from. Drives the friendly source label. */
type SkillSource = 'builtin' | 'user' | 'project' | 'plugin' | 'imported';

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
}

/** Map a registry skill's `origin` (absent = vendored) to a listing source. */
function registryOriginToSource(origin: SkillMetadata['origin']): SkillSource {
  if (origin === 'user') return 'user';
  if (origin === 'project') return 'project';
  // `imported:<binary>` skills are live-read from a trusted source binary
  // (Claude Code, Codex) via `importFrom`. Surface that provenance instead of
  // mislabelling them as built-in (mirrors collectSkillEntries in skill-bridge).
  if (origin?.startsWith('imported:')) return 'imported';
  return 'builtin';
}

function buildListingGroups(plugins: DiscoveredSkill[], internalUnlocked: boolean): Map<string, ListingGroup> {
  const groups = new Map<string, ListingGroup>();

  const addRow = (row: ListingRow): void => {
    const key = bareName(row.slashName.replace(/^\//, ''));
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { main: row, alts: [] });
    } else {
      existing.alts.push(row);
    }
  };

  // Pass 1: registry skills (vendored + user + project). Names already account
  // for collision (user-skills.ts shifts colliding names to `<origin>:<name>`),
  // so a `user:mint` lands as an alt under the vendored `mint` via addRow's
  // bare-name keying.
  for (const name of listVisibleSkills(internalUnlocked)) {
    const skill = getSkill(name);
    const slashName = `/${name}`;
    const display = skill.argumentHint
      ? `${slashName} ${skill.argumentHint}`
      : slashName;
    addRow({
      slashName,
      display,
      description: skill.description,
      source: registryOriginToSource(skill.origin),
    });
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
    const display = skill.argumentHint
      ? `${slashName} ${skill.argumentHint}`
      : slashName;
    addRow({
      slashName,
      display,
      description: skill.description,
      source: 'plugin',
    });
  }

  return groups;
}

/** Human-friendly source label — replaces the old raw `(user)`/`(plugin)` badges. */
function friendlySource(source: SkillSource): string {
  switch (source) {
    case 'builtin':
      return 'built-in';
    case 'user':
      return 'user';
    case 'project':
      return 'project';
    case 'plugin':
      return 'plugin';
    case 'imported':
      return 'imported';
  }
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

  // Built-in skills carry the richest metadata and are the modal starting
  // point, so they get their own block at the top. Everything else (user,
  // project, plugin) follows in a second block. Within each, alphabetical.
  const builtinGroups = allGroups.filter((g) => g.main.source === 'builtin').sort(byBareName);
  const otherGroups = allGroups.filter((g) => g.main.source !== 'builtin').sort(byBareName);

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
  const legend = (['builtin', 'user', 'project', 'plugin'] as const)
    .filter((s) => present.has(s))
    .map(friendlySource)
    .join(' · ');
  ctx.out.line(palette.dim(`  ${legend} — /skills <name> for details`));

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

function tryGetRegistrySkill(
  name: string,
  internalUnlocked: boolean,
): SkillMetadata | undefined {
  try {
    const skill = getSkill(name);
    return isSkillVisible(skill, internalUnlocked) ? skill : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collect the shadowed/alternative forms of a bare skill name — namespaced
 * registry collisions (`user:`/`project:`) plus shadowed plugin entries. These
 * are surfaced (not hidden) so a user always knows an alternative exists.
 */
function collectAlternatives(
  bare: string,
  internalUnlocked: boolean,
): Array<{ slash: string; source: SkillSource }> {
  const alternatives: Array<{ slash: string; source: SkillSource }> = [];

  for (const name of listVisibleSkills(internalUnlocked)) {
    if (name.includes(':') && bareName(name) === bare) {
      const source = registryOriginToSource(getSkill(name).origin);
      alternatives.push({ slash: `/${name}`, source });
    }
  }
  for (const collision of state.collisions) {
    if (collision.bare === bare) {
      alternatives.push({ slash: collision.altSlash, source: 'plugin' });
    }
  }
  return alternatives;
}

function renderSkillDetail(
  ctx: SlashContext,
  query: string,
  plugins: DiscoveredSkill[],
  internalUnlocked: boolean,
): void {
  const cleaned = query.replace(/^\//, '').trim();

  const registrySkill = tryGetRegistrySkill(cleaned, internalUnlocked);
  const pluginSkill = plugins.find(
    (p) => bareName(p.name) === cleaned || p.name === cleaned,
  );

  if (!registrySkill && !pluginSkill) {
    ctx.out.line();
    ctx.out.line(palette.dim(`  No skill found matching "${cleaned}".`));
    ctx.out.line(palette.dim('  Run /skills to see everything available.'));
    ctx.out.line();
    return;
  }

  const name = registrySkill?.name ?? bareName(pluginSkill!.name);
  const description = registrySkill?.description ?? pluginSkill!.description;
  const hint = registrySkill?.argumentHint ?? pluginSkill?.argumentHint;
  const displayName = hint ? `/${name} ${hint}` : `/${name}`;
  const source: SkillSource = registrySkill
    ? registryOriginToSource(registrySkill.origin)
    : 'plugin';

  // Wrap the body to the terminal width (capped) so long descriptions read as
  // paragraphs instead of one runaway line.
  const termW = Math.max(20, getTerminalWidth());
  const bodyW = Math.max(20, Math.min(termW - 2, 100));

  ctx.out.line();
  ctx.out.line(`  ${palette.warning(displayName)}`);
  ctx.out.line();
  for (const line of wrapToWidth(description, bodyW).split('\n')) {
    ctx.out.line(`  ${line}`);
  }

  // "When to use": structured field for vendored skills; for plugin/user skills
  // fall back to plucking a "Use when…" sentence out of the description. Skip
  // when it would merely echo the description verbatim.
  const whenToUse = registrySkill?.whenToUse ?? extractHintFromDescription(description);
  if (whenToUse && whenToUse !== description.trim()) {
    ctx.out.line();
    ctx.out.line(`  ${palette.bold('When to use')}`);
    for (const line of wrapToWidth(whenToUse, bodyW).split('\n')) {
      ctx.out.line(`  ${palette.dim(line)}`);
    }
  }

  const flags = registrySkill?.flags ?? harvestAllPluginSkillFlags().get(cleaned);
  if (flags && flags.length > 0) {
    ctx.out.line();
    ctx.out.line(`  ${palette.bold('Flags')}  ${palette.dim(flags.join(', '))}`);
  }

  ctx.out.line();
  ctx.out.line(`  ${palette.bold('Source')}  ${palette.dim(friendlySource(source))}`);

  const alternatives = collectAlternatives(name, internalUnlocked);
  if (alternatives.length > 0) {
    ctx.out.line();
    ctx.out.line(`  ${palette.bold('Alternatives')}`);
    for (const alt of alternatives) {
      ctx.out.line(
        `  ${palette.dim('↳')} ${palette.warning(alt.slash)} ${palette.dim(
          `(${friendlySource(alt.source)} — shadowed by /${name})`,
        )}`,
      );
    }
  }

  ctx.out.line();
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
  usage: '/skills [name]',
  hint: 'When you want to browse every skill the session can dispatch — pass a name for full details on one.',
  async handler(ctx, args) {
    const internalUnlocked = env.AFK_INTERNAL === '1';
    const trimmed = args.trim();
    // A leading-dash token (e.g. `--all`) is reserved for future verbose modes;
    // for now it just renders the full listing rather than 404 as a skill name.
    if (trimmed && !trimmed.startsWith('-')) {
      renderSkillDetail(ctx, trimmed, [], internalUnlocked);
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
    usage: '/skills [name]',
    hint: 'When you want to browse every skill the session can dispatch — pass a name for full details on one.',
    async handler(ctx, args) {
      const internalUnlocked = env.AFK_INTERNAL === '1';
      const trimmed = args.trim();
      // A leading-dash token (e.g. `--all`) is reserved for future verbose
      // modes; for now it renders the full listing rather than 404 as a name.
      if (trimmed && !trimmed.startsWith('-')) {
        renderSkillDetail(ctx, trimmed, plugins, internalUnlocked);
      } else {
        renderUnifiedListing(ctx, plugins, internalUnlocked);
      }
      return 'continue';
    },
  };
}
