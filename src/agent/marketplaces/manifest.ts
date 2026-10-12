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
import { errorMessage } from '../../utils/errors.js';

/**
 * A `git-subdir` object source: clone `url` at `ref`/`sha` and resolve the
 * plugin root to `path` within the clone. This is the shape used by the live
 * `anthropics/claude-plugins-official` marketplace for the majority of its
 * entries.
 */
export interface GitSubdirSource {
  source: 'git-subdir';
  url: string;
  path: string;
  ref?: string;
  sha?: string;
}

/**
 * A source entry that could not be resolved to a known installable shape.
 * The entry is carried through so callers can warn the user rather than
 * silently dropping the plugin from the list.
 */
export interface UnknownObjectSource {
  source: string;
  [key: string]: unknown;
}

/**
 * Union of all valid `source` shapes for a marketplace plugin entry.
 *
 * - `string` — existing shorthand: a relative path (`./plugins/foo`), an
 *   `owner/repo` GitHub shorthand, or a full HTTPS URL.
 * - `GitSubdirSource` — an object with `source: 'git-subdir'`; indicates the
 *   plugin lives in a subdirectory of a git repository.
 * - `UnknownObjectSource` — an object with an unrecognised `source`
 *   discriminator. The entry is parsed but marked `skipped` so the manifest
 *   load still succeeds.
 */
export type PluginSourceSpec = string | GitSubdirSource | UnknownObjectSource;

export interface MarketplacePluginEntry {
  /** Plugin name as it appears in `afk plugin install <mp>:<plugin>`. */
  name: string;
  /** Where to fetch the plugin. See {@link PluginSourceSpec} for all shapes. */
  source: PluginSourceSpec;
  /** Free-text description for list rendering. */
  description?: string;
  /**
   * Set when the source object shape is not yet supported or is malformed.
   * The entry is still included in the manifest so list commands can surface
   * it, but install will refuse with a descriptive error.
   */
  skipped?: string;
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

const MARKETPLACE_MANIFEST_RELPATH = '.claude-plugin/marketplace.json';

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
 * Throws on missing file, malformed JSON, or invalid top-level shape.
 *
 * Individual plugin entries with unrecognised or malformed object `source`
 * values are **not** rejected — they are included with `skipped` set so the
 * manifest load still succeeds for the remaining entries.
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

/** Narrow a parsed source object to {@link GitSubdirSource}. */
export function isGitSubdirSource(s: PluginSourceSpec): s is GitSubdirSource {
  return typeof s === 'object' && (s as GitSubdirSource).source === 'git-subdir';
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
    if (typeof pName !== 'string' || !pName.trim()) {
      throw new Error(`marketplace manifest at ${path}: plugins[${idx}] missing required "name"`);
    }
    const trimmedName = pName.trim();
    if (seenNames.has(trimmedName)) {
      throw new Error(
        `marketplace manifest at ${path}: duplicate plugin name "${trimmedName}"`,
      );
    }
    seenNames.add(trimmedName);

    const out = parsePluginEntry(e, trimmedName, idx, path);
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

/**
 * Parse one plugin entry's `source` field.
 *
 * - Plain string: validated non-empty, returned as-is (trimmed).
 * - Object with `source: 'git-subdir'`: validated for required `url` + `path`.
 * - Object with unknown/missing `source` discriminator: accepted with `skipped`
 *   set — the entry is listed but install will refuse gracefully.
 *
 * Never throws for individual entries — errors are captured in `skipped` so
 * the overall manifest load is not aborted by a single unsupported entry.
 */
function parsePluginEntry(
  e: Record<string, unknown>,
  name: string,
  idx: number,
  manifestPath: string,
): MarketplacePluginEntry {
  const pSource = e['source'];

  // ── String source (existing behaviour) ──────────────────────────────────
  if (typeof pSource === 'string') {
    if (!pSource.trim()) {
      // Empty string is a hard validation error, same as before.
      throw new Error(
        `marketplace manifest at ${manifestPath}: plugins[${idx}] missing required "source"`,
      );
    }
    return { name, source: pSource.trim() };
  }

  // ── Object source ────────────────────────────────────────────────────────
  if (pSource !== null && typeof pSource === 'object') {
    const s = pSource as Record<string, unknown>;
    const discriminator = s['source'];

    if (discriminator === 'git-subdir') {
      return parseGitSubdirEntry(s, name, idx);
    }

    // Unknown discriminator — skip with warning rather than failing the manifest.
    const disc = typeof discriminator === 'string' ? discriminator : '(none)';
    return {
      name,
      source: pSource as UnknownObjectSource,
      skipped: `unsupported source type "${disc}" in plugins[${idx}]`,
    };
  }

  // ── Missing / null / non-string non-object source ─────────────────────
  throw new Error(
    `marketplace manifest at ${manifestPath}: plugins[${idx}] missing required "source"`,
  );
}

function parseGitSubdirEntry(
  s: Record<string, unknown>,
  name: string,
  idx: number,
): MarketplacePluginEntry {
  const url = s['url'];
  const subPath = s['path'];

  if (typeof url !== 'string' || !url.trim()) {
    return {
      name,
      source: s as unknown as UnknownObjectSource,
      skipped: `git-subdir source in plugins[${idx}] is missing required "url"`,
    };
  }
  if (typeof subPath !== 'string' || !subPath.trim()) {
    return {
      name,
      source: s as unknown as UnknownObjectSource,
      skipped: `git-subdir source in plugins[${idx}] is missing required "path"`,
    };
  }

  const spec: GitSubdirSource = {
    source: 'git-subdir',
    url: url.trim(),
    path: subPath.trim(),
  };
  const ref = s['ref'];
  if (typeof ref === 'string' && ref.trim()) spec.ref = ref.trim();
  const sha = s['sha'];
  if (typeof sha === 'string' && sha.trim()) spec.sha = sha.trim();

  return { name, source: spec };
}

function errorMsg(err: unknown): string {
  return errorMessage(err);
}
