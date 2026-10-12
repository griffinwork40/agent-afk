/**
 * Flag + hint harvesting from plugin SKILL.md files.
 *
 * Split out of `plugin-skills.ts` (#366) — the extraction layer that walks
 * plugin directories on disk and plucks flags / "when to use" hints, with no
 * knowledge of the slash registry or rendering.
 *
 * Since #3332, registered plugin skills get flags + category from discovery
 * itself (`PluginSkillMetadata` → `SkillManifestEntry` → `ProviderCommandInfo`),
 * so `registerPluginSkills` no longer walks disk. The walkers below remain as
 * the `/skills <name>` detail-card fallback for skills not in the session's
 * command list, and as a public API for existing callers/tests.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { getMarketplaceCacheDir, getBundledPluginsDir } from '../../../paths.js';
import { scanAllPluginRoots } from '../../../agent/tools/skill-bridge.js';
import { _registerScanCacheResetHook } from '../../../agent/plugins-scanner.js';
import { parseSkillMd, resolveSkillFlags } from '../_lib/flag-harvest.js';

/**
 * Module-level cache for the full discovered-metadata harvest.
 * Populated lazily on first call to `harvestDiscoveredPluginSkillMetadata`
 * and invalidated by `_resetPluginScanCache` via the hook registered below.
 * This avoids a disk re-walk on every `/skills <name>` detail-card call.
 */
let _discoveredMetadataCache: PluginSkillHarvest | undefined;

_registerScanCacheResetHook(() => {
  _discoveredMetadataCache = undefined;
});

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
      // Match the skill loader: hidden entries and dependencies are not skills.
      if (entry.startsWith('.') || entry === 'node_modules') continue;
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

      // Shared precedence (same helper discovery uses): frontmatter flags win;
      // fall back to argument-hint + body scan.
      const skillFlags = resolveSkillFlags(
        parsed.frontmatterFlags,
        parsed.frontmatter?.['argument-hint'],
        parsed.body,
      );

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
  return harvestDiscoveredPluginSkillMetadata().flags;
}

/**
 * Harvest flags + categories from every plugin root AFK actually loads skills
 * from: the marketplace cache, the bundled-plugins dir, AND each plugin path
 * returned by `scanAllPluginRoots()` (flat `~/.afk/plugins/<name>/`,
 * project-scope `<cwd>/.afk/plugins/`, imported roots).
 *
 * History: the harvest used to walk only the cache + bundled dirs, so a skill
 * from a flat-installed plugin (e.g. `software-factory`'s /pr-triage) was
 * registered as a slash command with NO flags and the `--` completion menu
 * never opened for it. Reusing the bridge's root list keeps the flag set in
 * lockstep with the set of discovered skills.
 *
 * Merge rules: flags union (deduped, sorted); categories first-write-wins in
 * walk order (cache, then bundled, then discovered roots).
 */
export function harvestDiscoveredPluginSkillMetadata(): PluginSkillHarvest {
  if (_discoveredMetadataCache) return _discoveredMetadataCache;

  const roots: string[] = [getMarketplaceCacheDir(), getBundledPluginsDir()];
  try {
    for (const plugin of scanAllPluginRoots()) roots.push(plugin.path);
  } catch {
    // Contract: fail-soft, matching the walker. Discovery failure falls back to
    // the cache + bundled harvest instead of dropping every flag.
  }
  const flags = new Map<string, string[]>();
  const categories = new Map<string, string>();
  for (const root of new Set(roots)) {
    const harvest = harvestPluginSkillMetadata(root);
    for (const [name, skillFlags] of harvest.flags) {
      const existing = flags.get(name) ?? [];
      flags.set(name, Array.from(new Set([...existing, ...skillFlags])).sort());
    }
    for (const [name, cat] of harvest.categories) {
      if (!categories.has(name)) categories.set(name, cat);
    }
  }
  _discoveredMetadataCache = { flags, categories };
  return _discoveredMetadataCache;
}

/**
 * Best-effort "when to use" extraction from a plugin SKILL.md description.
 *
 * `whenToUse` is now a structured field on `DiscoveredSkill` when available
 * from SKILL.md frontmatter; `extractHintFromDescription` serves as the
 * fallback for older plugins that embed the hint in the description body.
 * Pluck it out so the dropdown tooltip can surface real guidance instead of
 * repeating the one-liner the dropdown summary already shows.
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
