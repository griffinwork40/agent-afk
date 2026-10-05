/**
 * Plugin userConfig — manifest parsing and env-var building.
 *
 * Handles the `userConfig` block inside `.claude-plugin/plugin.json`:
 *
 * ```json
 * {
 *   "userConfig": {
 *     "provider": { "type": "string", "description": "LLM provider name" },
 *     "apiKey":   { "type": "string", "sensitive": true }
 *   }
 * }
 * ```
 *
 * Rules:
 *   - Each key is normalised to `UPPER_ALPHA_NUM` (`/[A-Z0-9_]/` only) and
 *     exported as `CLAUDE_PLUGIN_OPTION_<KEY>` (Claude Code compatible).
 *   - `sensitive: true` fields are NEVER exported — not even when a value is
 *     stored. They go through the separate `pluginHookEnv` allowlist (#2459).
 *   - If two manifest keys collapse to the same normalised name the manifest
 *     is rejected (an error is thrown) rather than letting one silently win.
 *   - Stale keys (present in the stored options map but absent or removed
 *     from the manifest) are silently dropped at export time.
 *   - When a manifest key has a `default` and the user has not set a value,
 *     the default is exported.  When neither a stored value nor a default
 *     exists, nothing is exported for that key.
 *
 * Scope: user-scope installs only.  Project-scope and bundled plugins have no
 * index entry and receive no option env vars (documented in hook-payload.md).
 *
 * @module agent/plugins/plugin-user-config
 */

import { existsSync, readFileSync } from 'fs';
import { pluginManifestPath } from '../../config/plugin-discovery.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry in the `userConfig` map from `plugin.json`. */
export interface UserConfigField {
  /** Data type hint — currently informational only; always treated as string. */
  type?: string;
  /** Human-readable description shown by `afk plugin config <name>`. */
  description?: string;
  /** Default value exported when the user has never set this key. */
  default?: string;
  /**
   * When `true` this field is NEVER exported to hook subprocesses.
   * It is stored (set by `afk plugin config`) but not surfaced in env vars;
   * use the `pluginHookEnv` allowlist (#2459) if the hook script needs it.
   */
  sensitive?: boolean;
}

/** Parsed and validated `userConfig` map (key → field descriptor). */
export type UserConfigSchema = Record<string, UserConfigField>;

/** Env-var name → value pairs ready to inject into a hook subprocess. */
export type PluginOptionEnv = Record<string, string>;

// ---------------------------------------------------------------------------
// Env-name normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a `userConfig` key to an env-var segment.
 *
 * Rules (Claude Code compatible):
 *   - Uppercase the entire string.
 *   - Replace any character outside `[A-Z0-9_]` with `_`.
 *
 * e.g. `provider` → `PROVIDER`, `api-key` → `API_KEY`.
 */
export function normaliseOptionKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

// ---------------------------------------------------------------------------
// Manifest reading
// ---------------------------------------------------------------------------

/**
 * Read and parse the `userConfig` block from `<dir>/.claude-plugin/plugin.json`
 * (or `.codex-plugin/plugin.json`).
 *
 * Returns an empty object when:
 *   - the manifest file is missing,
 *   - the JSON is malformed,
 *   - the `userConfig` key is absent or not an object.
 *
 * Throws `Error` when two keys normalise to the same env-var name, because
 * silently dropping one would be a silent mis-configuration.
 */
export function readUserConfigSchema(dir: string): UserConfigSchema {
  const path = pluginManifestPath(dir);
  if (!existsSync(path)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;

  const uc = obj['userConfig'];
  if (uc === null || uc === undefined || typeof uc !== 'object' || Array.isArray(uc)) {
    return {};
  }

  const schema: UserConfigSchema = {};
  // Collision detection: normalised name → original key
  const seen = new Map<string, string>();

  for (const [key, value] of Object.entries(uc as Record<string, unknown>)) {
    if (!key) continue; // skip empty keys
    const norm = normaliseOptionKey(key);
    if (seen.has(norm)) {
      throw new Error(
        `plugin manifest userConfig collision: keys "${seen.get(norm)}" and "${key}" ` +
          `both normalise to "${norm}" — rename one to avoid ambiguity`,
      );
    }
    seen.set(norm, key);

    // Parse the field descriptor. A bare string is treated as description.
    const field: UserConfigField = {};
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const fd = value as Record<string, unknown>;
      if (typeof fd['type'] === 'string') field.type = fd['type'];
      if (typeof fd['description'] === 'string') field.description = fd['description'];
      if (typeof fd['default'] === 'string') field.default = fd['default'];
      if (fd['sensitive'] === true) field.sensitive = true;
    }
    schema[key] = field;
  }

  return schema;
}

// ---------------------------------------------------------------------------
// Env-var building
// ---------------------------------------------------------------------------

/**
 * Build the `CLAUDE_PLUGIN_OPTION_*` env vars for a plugin hook subprocess.
 *
 * @param schema   Parsed `userConfig` from the manifest (via `readUserConfigSchema`).
 * @param stored   The `options` map stored in the index entry for this plugin.
 *                 Only keys that exist in `schema` are consulted; stale keys
 *                 (removed from the manifest after an update) are silently
 *                 ignored.
 *
 * Sensitive fields are unconditionally excluded.
 * Default values are exported when no stored value is present.
 */
export function buildOptionEnv(
  schema: UserConfigSchema,
  stored: Record<string, string> | undefined,
): PluginOptionEnv {
  const env: PluginOptionEnv = {};

  for (const [key, field] of Object.entries(schema)) {
    // Never export sensitive options — they require the explicit pluginHookEnv allowlist.
    if (field.sensitive === true) continue;

    const norm = normaliseOptionKey(key);
    const envName = `CLAUDE_PLUGIN_OPTION_${norm}`;

    // Prefer the stored value; fall back to the manifest default; skip when absent.
    const storedVal = stored?.[key];
    if (storedVal !== undefined) {
      env[envName] = storedVal;
    } else if (field.default !== undefined) {
      env[envName] = field.default;
    }
    // If neither stored nor default → nothing exported for this key.
  }

  return env;
}

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

/**
 * Validate that `key` is declared in `schema` and is not sensitive.
 *
 * Returns `'ok'` on success, or an error string the CLI should display.
 */
export function validateOptionKey(
  key: string,
  schema: UserConfigSchema,
): 'ok' | string {
  if (!(key in schema)) {
    const declared = Object.keys(schema);
    const hint =
      declared.length > 0
        ? `Declared keys: ${declared.join(', ')}`
        : 'No userConfig keys are declared in this plugin\'s manifest.';
    return `Key "${key}" is not declared in the plugin manifest's userConfig. ${hint}`;
  }
  if (schema[key]?.sensitive === true) {
    return (
      `Key "${key}" is marked sensitive — it cannot be set via "afk plugin config". ` +
      `Use the pluginHookEnv allowlist (see issue #2459) to forward secrets to hooks.`
    );
  }
  return 'ok';
}
