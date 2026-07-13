/**
 * Flag + hint harvesting from plugin SKILL.md files.
 *
 * Split out of `plugin-skills.ts` (#366) — the extraction layer that walks
 * plugin directories on disk and plucks flags / "when to use" hints, with no
 * knowledge of the slash registry or rendering.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getMarketplaceCacheDir, getBundledPluginsDir } from '../../../paths.js';
import { harvestFlagsFromSkillMd } from '../_lib/flag-harvest.js';

/**
 * Walk the plugin cache directory tree and harvest flags from SKILL.md files.
 *
 * Kept as a public export because tests and other callers import it directly.
 * Internally delegates to the shared parser in `_lib/flag-harvest.ts` so the
 * user surface and plugin surface use identical extraction rules.
 *
 * @returns A map from skill name (directory name) to sorted array of flags.
 */
export function harvestPluginSkillFlags(cacheRoot?: string): Map<string, string[]> {
  const root = cacheRoot ?? getMarketplaceCacheDir();
  const result = new Map<string, string[]>();

  try {
    statSync(root);
  } catch {
    return result;
  }

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;

    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      if (entry !== 'SKILL.md' || !stat.isFile()) continue;

      let content;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const pathParts = fullPath.split('/');
      const skillName = pathParts[pathParts.length - 2];
      if (!skillName) continue;

      const flags = harvestFlagsFromSkillMd(content);

      if (flags.length === 0) continue;

      const existing = result.get(skillName) ?? [];
      const merged = new Set([...existing, ...flags]);
      result.set(skillName, Array.from(merged).sort());
    }
  };

  walk(root, 0);
  return result;
}

/**
 * Harvest flags from BOTH the marketplace cache AND the bundled-plugins dir,
 * merging per-skill (union, deduped, sorted).
 *
 * Why both: `session.supportedCommands()` surfaces bundled skills (e.g. the
 * `awa-bundled` /review), but a plugin skill's flags live only in its SKILL.md
 * and the plain `harvestPluginSkillFlags()` walks only the cache. Without the
 * bundled-dir pass, a bundled-only skill gets NO flag completion in the
 * dropdown even though its argument-hint declares flags. Walking both keeps the
 * completion set consistent regardless of whether a skill is installed
 * (cache) or shipped (bundled).
 */
export function harvestAllPluginSkillFlags(): Map<string, string[]> {
  const merged = harvestPluginSkillFlags();
  for (const [name, flags] of harvestPluginSkillFlags(getBundledPluginsDir())) {
    const existing = merged.get(name) ?? [];
    merged.set(name, Array.from(new Set([...existing, ...flags])).sort());
  }
  return merged;
}

/**
 * Best-effort "when to use" extraction from a plugin SKILL.md description.
 *
 * Plugin skills don't carry a structured `whenToUse` field — the convention
 * encoded in nearly every shipped SKILL.md is to embed a "Use when …" /
 * "When to use …" sentence inside the description. Pluck it out so the
 * dropdown tooltip can surface real guidance instead of repeating the
 * one-liner the dropdown summary already shows.
 *
 * Falls back to `undefined` when no such sentence is detectable. The tooltip
 * row collapses cleanly in that case.
 */
export function extractHintFromDescription(description: string): string | undefined {
  if (!description) return undefined;
  // Split on sentence terminators (`. `, `! `, `? `) while keeping the
  // sentences. Simple — descriptions are short, and any false-positive split
  // just truncates the hint, never breaks the tooltip.
  const sentences = description.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const m = /^(Use(?:d)? when\b.*|When\s+(?:the\s+user\s+|to\s+)?\b.*)$/i.exec(sentence.trim());
    if (m && m[1]) {
      const hint = m[1].trim();
      // Discard pathological short matches like "When." that survive splitting.
      if (hint.length >= 12) return hint;
    }
  }
  return undefined;
}
