// Contract: the afk.config.json tier of the CLI config loader (#368 split).
// This module owns the tier WALK — precedence, fall-through on a bad file, and
// caching. The per-file parse/validation concern lives in `json-tier-parse.ts`
// so `/config` provenance can reuse the identical semantics instead of
// re-deriving them (see the invariant note there).
//
// This module is also the SINGLE home of `jsonConfigCache`. Sibling modules and
// the `config.ts` facade must never duplicate it — the facade resets it only
// through `resetJsonConfigCache()` exported here, because ESM importers
// cannot reassign an imported binding (same pattern as `setState()` in the
// #366 plugin-skills split).

import { jsonConfigTierPaths } from './json-tier-paths.js';
import { parseJsonConfigFile } from './json-tier-parse.js';
import type { ModelSlotBinding, SlotName } from '../../agent/session/model-slots.js';
import type { CliConfig } from './types.js';

/**
 * Process-lifetime caches for the disk-backed config tiers. `afk chat` calls
 * `loadConfig()` 2× per invocation (CLI bootstrap reads `updatePolicy`, then
 * the command handler reads `systemPromptSource`) and `loadConfigSystemPrompt()`
 * walks the same JSON + AFK.md tiers a third time. The disk layout doesn't
 * change between those calls in normal operation, so we memoize the file
 * reads and serve subsequent calls in O(1).
 *
 * Tests that mutate `HOME` / `process.cwd()` / fs mocks between cases must
 * call `_resetConfigCache()` in `beforeEach` — the cache is keyed on
 * neither, so stale entries would survive otherwise. Future plugin-install
 * style hooks that mutate config files should call this too.
 */
let jsonConfigCache:
  | {
      config: Partial<CliConfig>;
      sourcePath: string | undefined;
      modelsPartial: Partial<Record<SlotName, ModelSlotBinding>>;
    }
  | undefined;

/**
 * Clear this tier's memoized JSON config. Called (only) by
 * `_resetConfigCache()` in the `config.ts` facade — the cache binding lives
 * here and cannot be reassigned by importers under ESM live-binding rules.
 */
export function resetJsonConfigCache(): void {
  jsonConfigCache = undefined;
}

/**
 * Load configuration from afk.config.json.
 *
 * Selection is FILE-level, not per-key: the walk stops at the first EXISTING
 * tier that parses and validates, and that file alone supplies the config. A
 * key absent from the winning file resolves to its default — it does NOT fall
 * through to a lower tier. Only a file that is missing, malformed, or rejected
 * by a throwing validator is skipped.
 *
 * Returns `{ config, sourcePath }` where `sourcePath` is the absolute path
 * of the file that was actually read, or `undefined` when no config file
 * was found. Used by `loadConfig()` to populate `systemPromptSource`.
 *
 * Memoized via `jsonConfigCache` — see the cache block above for the
 * invalidation contract.
 */
export function loadJsonConfig(): {
  config: Partial<CliConfig>;
  sourcePath: string | undefined;
  modelsPartial: Partial<Record<SlotName, ModelSlotBinding>>;
} {
  if (jsonConfigCache !== undefined) return jsonConfigCache;
  // Tier order lives in json-tier-paths.ts so `/config` provenance reporting
  // walks the identical list — see the invariant note there.
  const configPaths = jsonConfigTierPaths().map((t) => t.path);

  // Invariant: a parse failure in an earlier tier must NOT permanently
  // memoize the fallen-through result (#501-F2). If a malformed
  // `<cwd>/afk.config.json` falls through to the user-global file and we
  // cached THAT, a later fix to the cwd file would stay invisible until
  // `_resetConfigCache()`/process restart — which bites long-lived
  // daemon/telegram processes (one-shot CLI self-heals on the next spawn).
  // So when any file in the walk fails to parse, we return the resolved
  // result transiently (uncached) and re-read disk on the next call.
  let sawParseError = false;

  for (const configPath of configPaths) {
    let parsed: ReturnType<typeof parseJsonConfigFile>;
    try {
      parsed = parseJsonConfigFile(configPath);
    } catch (error) {
      console.error(`Warning: Failed to parse ${configPath}:`, error);
      sawParseError = true;
      continue;
    }
    if (parsed === undefined) continue; // file absent — not an error

    const result = { ...parsed, sourcePath: configPath };
    // Only memoize when the walk was clean — see the sawParseError
    // invariant above (a fall-through past a malformed earlier tier is
    // returned but not cached, so a later fix is picked up on re-read).
    if (!sawParseError) jsonConfigCache = result;
    return result;
  }

  const emptyResult = { config: {}, sourcePath: undefined, modelsPartial: {} };
  if (!sawParseError) jsonConfigCache = emptyResult;
  return emptyResult;
}
