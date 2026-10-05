import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { join, basename, relative, sep } from 'path';
import { z } from 'zod';
import type { DetectedAsset } from './import-sources.js';

const MAX_PLUGIN_SCAN_DEPTH = 5;
const installedRegistry = z.object({
  version: z.literal(2),
  plugins: z.record(z.string(), z.array(z.object({
    scope: z.string(),
    installPath: z.string(),
  }))),
});

function installedPlugins(root: string): DetectedAsset[] | undefined {
  const file = join(root, 'installed_plugins.json');
  if (!existsSync(file)) return undefined;
  try {
    const registry = installedRegistry.parse(JSON.parse(readFileSync(file, 'utf-8')));
    const assets: DetectedAsset[] = [];
    const seen = new Set<string>();
    for (const entries of Object.values(registry.plugins)) {
      for (const entry of entries) {
        if (entry.scope !== 'user' && entry.scope !== 'managed') continue;
        // Resolve realpath BEFORE manifestName so that a dangling symlink or
        // deleted installPath is caught and skipped — otherwise manifestName()
        // would fail first (returning null) and the realpathSync guard would
        // never be reached for that entry.
        let realPath: string;
        try {
          realPath = realpathSync(entry.installPath);
        } catch {
          continue; // dangling symlink or deleted path — skip this entry, keep processing others
        }
        if (seen.has(realPath)) continue;
        const name = manifestName(realPath);
        if (name === null) continue;
        seen.add(realPath);
        assets.push({ name, path: realPath });
        break;
      }
    }
    return assets;
  } catch {
    return [];
  }
}

/** Read a plugin manifest's `name` field. Inlined to avoid an agent-layer import. */
export function pluginManifestPath(dir: string): string {
  const native = join(dir, '.codex-plugin', 'plugin.json');
  return existsSync(native) ? native : join(dir, '.claude-plugin', 'plugin.json');
}

function manifestName(dir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(pluginManifestPath(dir), 'utf-8')) as {
      name?: unknown;
    };
    return typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null;
  } catch {
    return null;
  }
}

export function findPluginDirs(root: string): DetectedAsset[] {
  if (!existsSync(root)) return [];
  const installed = installedPlugins(root);
  if (installed !== undefined) return installed;
  const out: DetectedAsset[] = [];
  walkPlugins(root, 0, out, new Set<string>());
  const unique = new Map<string, DetectedAsset>();
  for (const asset of out) {
    const parts = relative(root, asset.path).split(sep);
    const key = parts[0] === 'cache' && parts.length >= 3
      ? `${parts[1]}:${parts[2]}`
      : parts[0] === 'marketplaces' && parts.length >= 2
        ? `${parts[1]}:${asset.name}`
        : asset.name;
    if (!unique.has(key)) unique.set(key, asset);
  }
  return [...unique.values()];
}

function walkPlugins(dir: string, depth: number, out: DetectedAsset[], seen: Set<string>): void {
  let canonical: string;
  try {
    canonical = realpathSync(dir);
  } catch {
    canonical = dir;
  }
  if (depth > MAX_PLUGIN_SCAN_DEPTH || seen.has(canonical)) return;
  seen.add(canonical);
  if (existsSync(pluginManifestPath(dir))) {
    const name = manifestName(dir) ?? basename(dir) ?? dir;
    out.push({ name, path: dir });
    return; // plugins do not nest
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) walkPlugins(full, depth + 1, out, seen);
    } catch {
      // unreadable entry — skip
    }
  }
}

