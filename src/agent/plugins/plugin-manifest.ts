/**
 * Reader for a single plugin's `.claude-plugin/plugin.json` manifest.
 *
 * Plugins carry a `name` + semver `version` in their manifest. Several
 * surfaces need just those two fields without pulling in the full scanner:
 *   - the installed-plugin inventory (`/reload-plugins`, version labels);
 *   - the plugin / marketplace updaters, which surface the post-update
 *     `version` in their outcome so a branch-tracked bump is visible.
 *
 * Best-effort: a missing file or malformed JSON yields `{ name: null,
 * version: null }` rather than throwing — callers render mixed valid/invalid
 * plugins without blowing up the whole list.
 *
 * @module agent/plugins/plugin-manifest
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface PluginManifestFields {
  /** Manifest `name` when present and non-empty, else `null`. */
  name: string | null;
  /** Manifest `version` (semver string) when present and non-empty, else `null`. */
  version: string | null;
}

/**
 * Read `<dir>/.claude-plugin/plugin.json` and extract `name` + `version`.
 * Returns nulls for a missing file, unreadable file, or malformed JSON.
 */
export function readPluginManifest(dir: string): PluginManifestFields {
  const path = join(dir, '.claude-plugin', 'plugin.json');
  if (!existsSync(path)) return { name: null, version: null };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
      version:
        typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null,
    };
  } catch {
    return { name: null, version: null };
  }
}
