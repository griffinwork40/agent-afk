// Invariant: this module is the SINGLE definition of the afk.config.json tier
// precedence order. Two consumers walk it and they must never disagree:
//   - `loadJsonConfig()` (json-tier.ts) — resolves the effective config at load.
//   - `resolveConfigProvenance()` (provenance.ts) — reports WHICH tier supplied
//     the effective value, so `/config` can warn that a write landed beneath a
//     higher-priority file.
// If these two walked separate lists, the menu would confidently attribute a
// value to the wrong file — the exact class of silent-wrong-answer bug the
// provenance feature exists to remove. Add a tier here, never at a call site.

import { join } from 'path';
import { getJsonConfigPath, getLegacyJsonConfigPath } from '../../paths.js';

/** Which config file supplied a value, in descending precedence. */
export type JsonConfigTier = 'project' | 'user' | 'legacy';

export interface JsonConfigTierPath {
  readonly tier: JsonConfigTier;
  readonly path: string;
}

/** Human-facing label for a tier, used in `/config` provenance badges. */
export const TIER_LABELS: Readonly<Record<JsonConfigTier, string>> = {
  project: 'project afk.config.json',
  user: 'user afk.config.json',
  legacy: 'legacy config',
};

/**
 * The afk.config.json files consulted at load, highest precedence first.
 *
 * Not memoized: `getJsonConfigPath()` honors `$AFK_HOME` and the project entry
 * is relative to `process.cwd()`, both of which tests mutate between cases.
 * Callers that need stability across a single operation should capture the
 * result once rather than re-invoking.
 */
export function jsonConfigTierPaths(): readonly JsonConfigTierPath[] {
  return [
    { tier: 'project', path: join(process.cwd(), 'afk.config.json') },
    { tier: 'user', path: getJsonConfigPath() },
    { tier: 'legacy', path: getLegacyJsonConfigPath() },
  ];
}
