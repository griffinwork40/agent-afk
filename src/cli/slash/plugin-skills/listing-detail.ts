/**
 * `/skills <name>` detail card rendering.
 *
 * Split out of `listing.ts` to keep that file under the 350-line cap.
 * Renders the enriched per-skill detail view including description,
 * "when to use", flags, source badge, and shadowed alternatives.
 */

import { getSkill, isSkillVisible, listVisibleSkills, type SkillMetadata } from '../../../skills/index.js';
import { palette } from '../../palette.js';
import { wrapToWidth } from '../../wrap.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { harvestAllPluginSkillFlags, extractHintFromDescription } from './flags.js';
import { state, bareName, type DiscoveredSkill } from './state.js';
import type { SlashContext } from '../types.js';
import type { SkillManifestEntry } from '../../../agent/tools/skill-bridge.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';

type SkillSource = SkillManifestEntry['source'];

/** Map a registry skill's `origin` (absent = vendored) to a listing source. */
export function registryOriginToSource(origin: SkillMetadata['origin']): SkillSource {
  if (origin === 'user') return 'user';
  if (origin === 'project') return 'project';
  if (origin?.startsWith('imported:')) return 'imported';
  return 'builtin';
}

/** Human-friendly source label. */
export function friendlySource(source: SkillSource): string {
  switch (source) {
    case 'builtin': return 'built-in';
    case 'user': return 'user';
    case 'project': return 'project';
    case 'plugin': return 'plugin';
    case 'imported': return 'imported';
    case 'command': return 'command';
  }
}

export function tryGetRegistrySkill(
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
 * registry collisions (`user:`/`project:`) plus shadowed plugin entries.
 */
function collectAlternatives(
  bare: string,
  internalUnlocked: boolean,
): Array<{ slash: string; source: SkillSource }> {
  const alternatives: Array<{ slash: string; source: SkillSource }> = [];
  for (const name of listVisibleSkills(internalUnlocked)) {
    if (name.includes(':') && bareName(name) === bare) {
      alternatives.push({ slash: `/${name}`, source: registryOriginToSource(getSkill(name).origin) });
    }
  }
  for (const collision of state.collisions) {
    if (collision.bare === bare) {
      alternatives.push({ slash: collision.altSlash, source: collision.source ?? 'plugin' });
    }
  }
  return alternatives;
}

export function renderSkillDetail(
  ctx: SlashContext,
  query: string,
  plugins: DiscoveredSkill[],
  internalUnlocked: boolean,
): void {
  const cleaned = query.replace(/^\//, '').trim();
  const registrySkill = tryGetRegistrySkill(cleaned, internalUnlocked);
  const pluginSkill = plugins.find((p) => bareName(p.name) === cleaned || p.name === cleaned);

  if (!registrySkill && !pluginSkill) {
    ctx.out.line();
    ctx.out.line(palette.dim(`  No skill found matching "${sanitizeForDisplay(cleaned)}".`));
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
    : (pluginSkill?.source ?? 'plugin');

  const termW = Math.max(20, getTerminalWidth());
  const bodyW = Math.max(20, Math.min(termW - 2, 100));

  ctx.out.line();
  ctx.out.line(`  ${palette.warning(displayName)}`);
  ctx.out.line();
  for (const line of wrapToWidth(description, bodyW).split('\n')) {
    ctx.out.line(`  ${line}`);
  }

  const whenToUse = registrySkill?.whenToUse ?? pluginSkill?.whenToUse ?? extractHintFromDescription(description);
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
