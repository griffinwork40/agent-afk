// Contract: the AFK.md auto-discovery tier of the CLI config loader (#368
// split). This module is the SINGLE home of `afkMdCache`. Sibling modules and
// the `config.ts` facade must never duplicate it — the facade resets it only
// through `resetAfkMdCache()` exported here, because ESM importers cannot
// reassign an imported binding (same pattern as `setState()` in the #366
// plugin-skills split).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getAfkHome } from '../../paths.js';

let afkMdCache: { value: { content: string; path: string } | null } | undefined;

/**
 * Clear this tier's memoized AFK.md read. Called (only) by
 * `_resetConfigCache()` in the `config.ts` facade — the cache binding lives
 * here and cannot be reassigned by importers under ESM live-binding rules.
 */
export function resetAfkMdCache(): void {
  afkMdCache = undefined;
}

/**
 * Try to load a system prompt from `AFK.md`.
 *
 * Search order (first non-empty file wins):
 *   1. `<cwd>/AFK.md`   — project-scope
 *   2. `$AFK_HOME/AFK.md` (default `~/.afk/AFK.md`) — user-scope
 *
 * Returns `{ content, path }` with trimmed content, or `null` when no
 * readable non-empty `AFK.md` exists. Empty / whitespace-only files are
 * treated as absent so an accidental blank file doesn't silently wipe the
 * system prompt.
 *
 * Memoized via `afkMdCache` — see the cache block above `loadJsonConfig`
 * for the invalidation contract.
 */
export function loadAfkMd(): { content: string; path: string } | null {
  if (afkMdCache !== undefined) return afkMdCache.value;
  const candidates = [
    join(process.cwd(), 'AFK.md'),
    join(getAfkHome(), 'AFK.md'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf-8').trim();
      if (content.length > 0) {
        afkMdCache = { value: { content, path: p } };
        return afkMdCache.value;
      }
    } catch {
      // skip unreadable files
    }
  }
  afkMdCache = { value: null };
  return afkMdCache.value;
}
