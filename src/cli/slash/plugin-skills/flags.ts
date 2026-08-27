/**
 * Flag + hint harvesting from plugin SKILL.md files.
 *
 * Split out of `plugin-skills.ts` (#366) — the extraction layer that walks
 * plugin directories on disk and plucks flags / "when to use" hints, with no
 * knowledge of the slash registry or rendering.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { getMarketplaceCacheDir, getBundledPluginsDir } from '../../../paths.js';
import { parseSkillMd, extractFlagsFromBody } from '../_lib/flag-harvest.js';

/** Result of a full SKILL.md harvest pass (flags + category). */
export interface PluginSkillHarvest {
  flags: Map<string, string[]>;
  categories: Map<string, string>;
}

/**
 * Walk the plugin cache directory tree and harvest flags AND categories from
 * SKILL.md files.
 *
 * Kept as a public export because tests and other callers import it directly.
 * Internally delegates to the shared parser in `_lib/flag-harvest.ts` so the
 * user surface and plugin surface use identical extraction rules.
 *
 * @returns A map from skill name (directory name) to sorted array of flags.
 */
export function harvestPluginSkillFlags(cacheRoot?: string): Map<string, string[]> {
  return harvestPluginSkillMetadata(cacheRoot).flags;
}

/**
 * Walk the plugin cache directory tree and harvest flags + categories from
 * SKILL.md files in a single pass.
 *
 * Category is read from `category:` frontmatter and passed through verbatim —
 * no inference, no validation. A skill without a category frontmatter field
 * simply won't appear in the categories map, and the listing puts it under
 * "More skills".
 *
 * @returns `{ flags, categories }` — both keyed by skill name.
 */
export function harvestPluginSkillMetadata(cacheRoot?: string): PluginSkillHarvest {
  const root = cacheRoot ?? getMarketplaceCacheDir();
  const flags = new Map<string, string[]>();
  const categories = new Map<string, string>();

  try {
    statSync(root);
  } catch {
    return { flags, categories };
  }

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;

    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      // Contract: fail-soft — an unreadable plugin directory (missing, permissions)
      // must not abort the walk; data from other dirs still applies.
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        // Contract: fail-soft — a stat error on a single entry (race, symlink
        // dangling) skips that entry; the rest of the directory still walks.
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
        // Contract: fail-soft — an unreadable SKILL.md (permissions, race) skips
        // that skill's data; the walk continues for all other SKILL.md files.
        continue;
      }

      const skillName = basename(dirname(fullPath));
      if (!skillName) continue;

      // F5: Parse once; derive both flags and category from the single result.
      // Previously called harvestFlagsFromSkillMd(content) — which internally
      // calls parseSkillMd — then called parseSkillMd(content) again separately.
      const parsed = parseSkillMd(content);

      // Flag extraction mirrors harvestFlagsFromSkillMd's precedence rules:
      // frontmatter flags win; fall back to argument-hint + body scan.
      const skillFlags: string[] =
        parsed.frontmatterFlags && parsed.frontmatterFlags.length > 0
          ? parsed.frontmatterFlags
          : extractFlagsFromBody(`${parsed.frontmatter?.['argument-hint'] ?? ''}\n${parsed.body}`);

      if (skillFlags.length > 0) {
        const existing = flags.get(skillName) ?? [];
        const merged = new Set([...existing, ...skillFlags]);
        flags.set(skillName, Array.from(merged).sort());
      }

      // Harvest category — no merge (last-write-wins across plugins with same skill name).
      const cat = parsed.frontmatter?.['category'];
      if (cat && cat.length > 0) {
        categories.set(skillName, cat);
      }
    }
  };

  walk(root, 0);
  return { flags, categories };
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
