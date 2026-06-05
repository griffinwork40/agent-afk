/**
 * Filesystem discovery helpers for /audit-fit.
 *
 * Returns lists of artifact paths split by source. The audit-fit handler
 * runs these in-process and templates the results into inspector prompts,
 * so the inspectors don't need to (and shouldn't) duplicate `scanLocalPlugins`
 * by Globbing the tree themselves.
 *
 * @module skills/audit-fit/discover
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAfkHome, getPluginsDir } from '../../paths.js';
import {
  scanLocalPlugins,
  indexKeyForPath,
} from '../../agent/plugins-scanner.js';

export type ArtifactType = 'skill' | 'command' | 'agent';

export interface DiscoveredArtifact {
  path: string;
  type: ArtifactType;
  source: 'user' | 'plugin';
  plugin_key?: string;
}

const FILE_ARTIFACT_TYPES: ReadonlyArray<ArtifactType> = ['command', 'agent'];

/**
 * Walk top-level user-scope artifact dirs under `afkHome` (default `~/.afk/`).
 * Layout:
 *   - skills:   `<afk>/skills/<name>/SKILL.md`
 *   - commands: `<afk>/commands/<name>.md`
 *   - agents:   `<afk>/agents/<name>.md`
 *
 * Returns `[]` for any dir that doesn't exist; never throws.
 */
export function discoverUserScope(
  afkHome: string = getAfkHome(),
): DiscoveredArtifact[] {
  const out: DiscoveredArtifact[] = [];

  const skillsDir = join(afkHome, 'skills');
  if (existsSync(skillsDir)) {
    for (const name of safeReaddir(skillsDir)) {
      const skillMd = join(skillsDir, name, 'SKILL.md');
      if (existsSync(skillMd)) {
        out.push({ path: skillMd, type: 'skill', source: 'user' });
      }
    }
  }

  for (const type of FILE_ARTIFACT_TYPES) {
    const dir = join(afkHome, `${type}s`);
    if (!existsSync(dir)) continue;
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith('.md')) continue;
      out.push({ path: join(dir, name), type, source: 'user' });
    }
  }

  return out;
}

/**
 * Walk every plugin install under `pluginsRoot` (default `~/.afk/plugins/`)
 * and enumerate the artifacts each plugin ships. Plugin discovery delegates
 * to `scanLocalPlugins`, so the audit cannot drift from what the SDK loads.
 *
 * `plugin_key` is derived via `indexKeyForPath` and follows the
 * `<name>` (flat layout) or `<marketplace>:<plugin>` (cache layout) shape.
 */
export function discoverPluginScope(
  pluginsRoot: string = getPluginsDir(),
): DiscoveredArtifact[] {
  if (!existsSync(pluginsRoot)) return [];
  const out: DiscoveredArtifact[] = [];
  const plugins = scanLocalPlugins(pluginsRoot);

  for (const p of plugins) {
    const keyInfo = indexKeyForPath(pluginsRoot, p.path);
    const pluginKey = keyInfo?.key;

    const skillsDir = join(p.path, 'skills');
    if (existsSync(skillsDir)) {
      for (const name of safeReaddir(skillsDir)) {
        const skillMd = join(skillsDir, name, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        const artifact: DiscoveredArtifact = {
          path: skillMd,
          type: 'skill',
          source: 'plugin',
        };
        if (pluginKey) artifact.plugin_key = pluginKey;
        out.push(artifact);
      }
    }

    for (const type of FILE_ARTIFACT_TYPES) {
      const dir = join(p.path, `${type}s`);
      if (!existsSync(dir)) continue;
      for (const name of safeReaddir(dir)) {
        if (!name.endsWith('.md')) continue;
        const artifact: DiscoveredArtifact = {
          path: join(dir, name),
          type,
          source: 'plugin',
        };
        if (pluginKey) artifact.plugin_key = pluginKey;
        out.push(artifact);
      }
    }
  }

  return out;
}

/**
 * One discovered hook entry from settings.json. `event` is the lifecycle event
 * key (e.g., `SubagentStop`), `index` is its 0-based position within that
 * event's array, and `raw` is the verbatim entry shape (typically a matcher
 * group with a nested `hooks` array of commands). The hook inspector reads
 * this list directly from its prompt — it is pre-resolved here so the
 * inspector never has to expand `~/.afk` itself, which is brittle when the
 * subagent's $HOME is unknown.
 */
export interface DiscoveredHook {
  event: string;
  index: number;
  raw: unknown;
}

/**
 * Read every hook entry out of the AFK settings.json. Returns `[]` when the
 * file is absent or malformed; never throws.
 */
export function discoverHooks(
  settingsPath: string = join(getAfkHome(), 'settings.json'),
): DiscoveredHook[] {
  if (!existsSync(settingsPath)) return [];
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    const hooks = parsed.hooks;
    if (!hooks || typeof hooks !== 'object') return [];
    const out: DiscoveredHook[] = [];
    for (const [event, arr] of Object.entries(hooks)) {
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        out.push({ event, index: i, raw: arr[i] });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Count hooks in the AFK settings.json. Returns 0 when the file is absent
 * or malformed. Used for inventory totals; the hook inspector subagent still
 * does the per-hook reasoning.
 */
export function discoverHookCount(
  settingsPath: string = join(getAfkHome(), 'settings.json'),
): number {
  return discoverHooks(settingsPath).length;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}
