/**
 * Human-surface store for the operator tool deny list (`tools.disabled`),
 * used by the `/config` → Tools menu and the read-only `/config view`.
 *
 * Contract:
 *   - Reads are RAW entries per tier (group names stay group names), so the
 *     menu can show what the operator actually wrote. Enforcement-side
 *     expansion/validation lives in agent/tools/operator-denied.ts.
 *   - Only the USER tier (`$AFK_HOME/config/afk.config.json`) is ever written.
 *     Project and legacy tiers are additive denies the menu reports but never
 *     edits (tiers are unioned at enforcement, so a project file can only
 *     narrow). Writes go through mutate.ts's atomic write + `.bak` backup.
 *   - This is NOT reachable from the agent's `config_set` tool: that path
 *     resolves keys through CONFIG_KEY_SPECS, where `tools.disabled` is
 *     deliberately absent and refused.
 *
 * @module cli/config/tools-disabled
 */

import { existsSync, readFileSync } from 'node:fs';
import { getJsonConfigPath } from '../../paths.js';
import { readConfigObject, writeConfigObject } from '../../config/mutate.js';
import { jsonConfigTierPaths, TIER_LABELS, type JsonConfigTier } from './json-tier-paths.js';

export interface TierDisabledTools {
  tier: JsonConfigTier;
  /** Human-facing tier label (e.g. "project config"). */
  label: string;
  path: string;
  /** Valid string entries, in file order. Empty when unset or unreadable. */
  entries: readonly string[];
  /** True when the file exists but could not be parsed. */
  unreadable?: boolean;
}

function stringEntries(json: unknown): string[] {
  if (json === null || typeof json !== 'object') return [];
  const tools = (json as { tools?: unknown }).tools;
  if (tools === null || typeof tools !== 'object') return [];
  const disabled = (tools as { disabled?: unknown }).disabled;
  if (!Array.isArray(disabled)) return [];
  return disabled.filter((e): e is string => typeof e === 'string');
}

/** Raw `tools.disabled` entries from every config tier that exists. */
export function readDisabledToolsByTier(): TierDisabledTools[] {
  const out: TierDisabledTools[] = [];
  for (const { tier, path } of jsonConfigTierPaths()) {
    if (!existsSync(path)) continue;
    const label = TIER_LABELS[tier];
    try {
      out.push({ tier, label, path, entries: stringEntries(JSON.parse(readFileSync(path, 'utf8'))) });
    } catch {
      out.push({ tier, label, path, entries: [], unreadable: true });
    }
  }
  return out;
}

/**
 * Replace the user-tier `tools.disabled` list. An empty list removes the key
 * (and an emptied `tools` object) rather than persisting `[]`. Throws
 * MalformedConfigError when the user file exists but is not valid JSON, so a
 * bad file is never silently overwritten.
 */
export function writeUserDisabledTools(entries: readonly string[], file: string = getJsonConfigPath()): void {
  const obj = readConfigObject(file);
  const prior = obj['tools'];
  const tools: Record<string, unknown> =
    prior !== null && typeof prior === 'object' && !Array.isArray(prior) ? { ...(prior as Record<string, unknown>) } : {};
  const unique = [...new Set(entries)];
  if (unique.length > 0) tools['disabled'] = unique;
  else delete tools['disabled'];
  if (Object.keys(tools).length > 0) obj['tools'] = tools;
  else delete obj['tools'];
  writeConfigObject(file, obj);
}
