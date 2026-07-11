/**
 * `/reload-plugins` command + its reload-summary helpers.
 *
 * Split out of `plugin-skills.ts` (#366) — re-runs the plugin-skill query
 * after the user edits SKILL.md files on disk, and reports what changed
 * (source breakdown, skill delta, installed-plugin versions).
 */

import { _resetPluginScanCache } from '../../../agent/plugins-scanner.js';
import { collectSkillEntries, type SkillManifestEntry } from '../../../agent/tools/skill-bridge.js';
import {
  listInstalledPlugins,
  formatPluginVersion,
  type InstalledPlugin,
} from '../../../agent/plugins/inventory.js';
import { palette } from '../../palette.js';
import { registerPluginAgents } from '../plugin-agents.js';
import type { SlashCommand, SlashContext } from '../types.js';
import { registerPluginSkills } from './dispatch.js';
import { state } from './state.js';

/**
 * Build the dim "source breakdown" segment for the reload summary, e.g.
 * `38 built-in · 12 plugin · 2 user`. Only non-zero sources appear, in a fixed
 * order. Returns '' when there are no skills to break down.
 */
export function buildSourceBreakdown(entries: SkillManifestEntry[]): string {
  const counts: Record<SkillManifestEntry['source'], number> = {
    builtin: 0,
    plugin: 0,
    user: 0,
    project: 0,
    imported: 0,
  };
  for (const e of entries) counts[e.source]++;
  const labels: Array<[SkillManifestEntry['source'], string]> = [
    ['builtin', 'built-in'],
    ['plugin', 'plugin'],
    ['user', 'user'],
    ['project', 'project'],
    ['imported', 'imported'],
  ];
  return labels
    .filter(([k]) => counts[k] > 0)
    .map(([k, label]) => `${counts[k]} ${label}`)
    .join(' · ');
}

/**
 * Compute the change in registered skill names between the previous snapshot
 * and the current one. Returns null when there is no baseline (first
 * registration) so callers can omit the delta entirely.
 */
export function computeSkillDelta(
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
): { added: string[]; removed: string[] } | null {
  if (prev.size === 0) return null;
  return {
    added: [...next].filter((n) => !prev.has(n)).sort(),
    removed: [...prev].filter((n) => !next.has(n)).sort(),
  };
}

/** Render a skill delta as a compact suffix, or '' when nothing changed. */
export function formatSkillDelta(delta: { added: string[]; removed: string[] }): string {
  const { added, removed } = delta;
  if (added.length === 0 && removed.length === 0) return '';
  const counts: string[] = [];
  if (added.length) counts.push(`+${added.length}`);
  if (removed.length) counts.push(`−${removed.length}`);
  let suffix = `${counts.join(' ')} since last reload`;
  // Name the skills when each side's change is small enough to stay scannable.
  const named: string[] = [];
  if (added.length > 0 && added.length <= 3) named.push(`new: ${added.map((n) => `/${n}`).join(', ')}`);
  if (removed.length > 0 && removed.length <= 3) {
    named.push(`gone: ${removed.map((n) => `/${n}`).join(', ')}`);
  }
  if (named.length > 0) suffix += ` (${named.join('; ')})`;
  return suffix;
}

/**
 * Render installed-plugin rows as dim, name-aligned lines (one per plugin):
 * `    example-plugin   v1.9.0`. Caps at 8 rows; extra plugins collapse into a
 * trailing `…and N more`. Returns [] when none are installed.
 */
export function buildPluginRows(plugins: InstalledPlugin[]): string[] {
  if (plugins.length === 0) return [];
  const MAX = 8;
  const shown = plugins.slice(0, MAX);
  const width = Math.min(24, shown.reduce((m, p) => Math.max(m, p.name.length), 0));
  const rows = shown.map((p) =>
    palette.dim(`    ${p.name.padEnd(width)}  ${formatPluginVersion(p)}`),
  );
  if (plugins.length > MAX) {
    rows.push(palette.dim(`    …and ${plugins.length - MAX} more`));
  }
  return rows;
}

/**
 * `/reload-plugins` — ask the session query to re-scan plugin dirs, then re-register
 * the passthrough commands. Useful after editing SKILL.md files on disk.
 */
export const reloadPluginsCmd: SlashCommand = {
  name: '/reload-plugins',
  summary: 'Reload plugin skills from disk and refresh the slash registry',
  async handler(ctx: SlashContext) {
    ctx.out.line();
    ctx.out.info('Reloading plugins…');
    // Snapshot the pre-reload skill set so we can report what changed on disk
    // (the common reason to reload is editing a SKILL.md). Captured before the
    // re-registration that reassigns `state.discovered`.
    const prevSkillNames = new Set(state.discovered.map((d) => d.name));
    // Invalidate the in-process scan cache so the next manifest build
    // (triggered by registerPluginSkills → session.supportedCommands)
    // reads fresh data from `~/.afk/plugins/` instead of stale results
    // memoized at session start. Without this, /reload-plugins would only
    // refresh the SDK's view; AFK's own scan would still serve the
    // pre-edit manifest.
    _resetPluginScanCache();
    try {
      // AgentSession re-exports the session query handle via
      // getQuery(); reloadPlugins() lives on that surface (the narrower
      // ProviderQuery shape omits it). Cleaner than reaching into private
      // internals and survives any future tightening of the provider boundary.
      const q = ctx.session.current.getQuery() as unknown as {
        reloadPlugins?: () => Promise<unknown>;
      };
      if (typeof q.reloadPlugins === 'function') {
        await q.reloadPlugins();
      }
    } catch (err) {
      ctx.out.warn(`Plugin reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Refresh skills + agents in parallel — neither depends on the other.
    const [skillCount, agentCount] = await Promise.all([
      registerPluginSkills(ctx.session.current),
      registerPluginAgents(ctx.session.current),
    ]);
    if (skillCount === null && agentCount === null) {
      ctx.out.error('Could not refresh plugin skills or agents.');
      ctx.out.line();
      return 'continue';
    }

    const installed = listInstalledPlugins();

    // Headline: the counts, plus how many plugin dirs are actually loaded.
    const parts: string[] = [];
    if (skillCount !== null) parts.push(`${skillCount} skill${skillCount === 1 ? '' : 's'}`);
    if (agentCount !== null) parts.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`);
    const fromPlugins =
      installed.length > 0
        ? ` from ${installed.length} plugin${installed.length === 1 ? '' : 's'}`
        : '';
    ctx.out.success(`Reloaded ${parts.join(' + ')}${fromPlugins}.`);

    // Dim breakdown + delta — explains what the bare skill count is made of
    // (the registry spans built-in + plugin + user skills, so the total moves
    // little on reload) and what changed since the last registration.
    if (skillCount !== null) {
      const breakdown = buildSourceBreakdown(collectSkillEntries());
      const delta = computeSkillDelta(
        prevSkillNames,
        new Set(state.discovered.map((d) => d.name)),
      );
      const deltaStr = delta ? formatSkillDelta(delta) : '';
      const segs = [breakdown, deltaStr].filter((s) => s.length > 0);
      if (segs.length > 0) ctx.out.line(palette.dim(`  ${segs.join(' · ')}`));
    }

    // Dim per-plugin version rows — the answer to "which versions are loaded?".
    for (const row of buildPluginRows(installed)) ctx.out.line(row);

    ctx.out.line();
    return 'continue';
  },
};
