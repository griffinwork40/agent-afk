/**
 * Marketplace manifest parser.
 *
 * Reads `.claude-plugin/marketplace.json` and validates its shape. Marketplaces
 * are catalogs that list plugins; the SDK does not consume them directly. AFK
 * uses them to clone a marketplace into `~/.afk/plugins/cache/<name>/`, then
 * resolves individual plugins on demand via `afk plugin install <mp>:<plugin>`.
 *
 * @module agent/marketplaces/manifest
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface MarketplacePluginEntry {
  /** Plugin name as it appears in `afk plugin install <mp>:<plugin>`. */
  name: string;
  /** Where to fetch the plugin: relative path (`./plugins/foo`), git URL, or `owner/repo`. */
  source: string;
  /** Free-text description for list rendering. */
  description?: string;
}

export interface MarketplaceManifest {
  /** Canonical marketplace name. The on-disk dir is renamed to match this. */
  name: string;
  metadata?: {
    description?: string;
  };
  owner?: {
    name?: string;
    email?: string;
  };
  plugins: MarketplacePluginEntry[];
}

export const MARKETPLACE_MANIFEST_RELPATH = '.claude-plugin/marketplace.json';

/** Absolute path to a marketplace's manifest given its install dir. */
export function manifestPath(marketplaceDir: string): string {
  return join(marketplaceDir, MARKETPLACE_MANIFEST_RELPATH);
}

/** Whether `dir` looks like a marketplace (has the manifest). */
export function isMarketplaceDir(dir: string): boolean {
  return existsSync(manifestPath(dir));
}

/**
 * Read and validate the marketplace manifest at `<dir>/.claude-plugin/marketplace.json`.
 * Throws on missing file, malformed JSON, or invalid shape.
 */
export function readManifest(dir: string): MarketplaceManifest {
  const path = manifestPath(dir);
  if (!existsSync(path)) {
    throw new Error(`marketplace manifest not found: ${path}`);
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `could not read marketplace manifest at ${path}: ${errorMsg(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `marketplace manifest at ${path} is not valid JSON: ${errorMsg(err)}`,
    );
  }
  return validate(parsed, path);
}

/**
 * Best-effort read that returns `null` instead of throwing. Useful for status
 * commands that need to render mixed valid/invalid marketplaces without
 * blowing up the whole list.
 */
export function tryReadManifest(dir: string): MarketplaceManifest | null {
  try {
    return readManifest(dir);
  } catch {
    return null;
  }
}

function validate(raw: unknown, path: string): MarketplaceManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`marketplace manifest at ${path} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  const name = obj['name'];
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`marketplace manifest at ${path} is missing required "name" field`);
  }

  const pluginsRaw = obj['plugins'];
  if (!Array.isArray(pluginsRaw)) {
    throw new Error(`marketplace manifest at ${path} is missing required "plugins" array`);
  }

  const seenNames = new Set<string>();
  const plugins: MarketplacePluginEntry[] = pluginsRaw.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`marketplace manifest at ${path}: plugins[${idx}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const pName = e['name'];
    const pSource = e['source'];
    if (typeof pName !== 'string' || !pName.trim()) {
      throw new Error(`marketplace manifest at ${path}: plugins[${idx}] missing required "name"`);
    }
    if (typeof pSource !== 'string' || !pSource.trim()) {
      throw new Error(`marketplace manifest at ${path}: plugins[${idx}] missing required "source"`);
    }
    const trimmedName = pName.trim();
    if (seenNames.has(trimmedName)) {
      throw new Error(
        `marketplace manifest at ${path}: duplicate plugin name "${trimmedName}"`,
      );
    }
    seenNames.add(trimmedName);

    const out: MarketplacePluginEntry = {
      name: trimmedName,
      source: pSource.trim(),
    };
    const desc = e['description'];
    if (typeof desc === 'string') out.description = desc;
    return out;
  });

  const result: MarketplaceManifest = { name: name.trim(), plugins };

  const metadata = obj['metadata'];
  if (metadata && typeof metadata === 'object') {
    const m = metadata as Record<string, unknown>;
    const md: { description?: string } = {};
    if (typeof m['description'] === 'string') md.description = m['description'];
    if (Object.keys(md).length > 0) result.metadata = md;
  }

  const owner = obj['owner'];
  if (owner && typeof owner === 'object') {
    const o = owner as Record<string, unknown>;
    const ow: { name?: string; email?: string } = {};
    if (typeof o['name'] === 'string') ow.name = o['name'];
    if (typeof o['email'] === 'string') ow.email = o['email'];
    if (Object.keys(ow).length > 0) result.owner = ow;
  }

  return result;
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
