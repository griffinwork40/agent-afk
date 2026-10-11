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

import { pluginManifestPath } from '../../config/plugin-discovery.js';
import { readJsonFileLoose } from '../../utils/json-file.js';

export interface PluginManifestFields {
  /** Manifest `name` when present and non-empty, else `null`. */
  name: string | null;
  /** Manifest `version` (semver string) when present and non-empty, else `null`. */
  version: string | null;
}

/**
 * Read `<dir>/.claude-plugin/plugin.json` and extract `name` + `version`.
 * Returns nulls for a missing file, unreadable file, or malformed JSON.
 *
 * Uses readJsonFileLoose: both ENOENT and parse errors return the default null
 * record — the manifest is best-effort metadata for display purposes and a
 * corrupt or absent file must never block the caller.
 */
export function readPluginManifest(dir: string): PluginManifestFields {
  const path = pluginManifestPath(dir);
  const raw = readJsonFileLoose<{ name?: unknown; version?: unknown }>(path);
  if (raw == null) return { name: null, version: null };
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
    version:
      typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null,
  };
}
