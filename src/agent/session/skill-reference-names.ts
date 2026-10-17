/**
 * Installed-skill name lookup for mid-message reference telemetry
 * ({@link ./skill-reference.ts}).
 *
 * Invariant: read-only. This deliberately does NOT call
 * `collectSkillEntries()`, which evicts and rescans project skills in the
 * global registry. It unions the names already in the registry (built-in,
 * user, project, imported — populated when the session's skill manifest was
 * built) with plugin skill names read from disk. Plugin skills never enter
 * the registry, and they are the most common mid-message references
 * (/devils-advocate, /research, /pr-triage), so leaving them out would hide
 * exactly the misses this telemetry exists to count.
 *
 * Cost: called only after a turn whose user text contained a `/name`
 * candidate, off the streaming path; plugin names are cached per cwd for
 * {@link PLUGIN_NAMES_TTL_MS}.
 */

import { listSkills } from '../../skills/skill-registry.js';
import { bareSkillName } from './skill-reference.js';

// Invariant: plugin discovery is imported lazily. `session-send.ts` imports
// this module, and a static import of `skill-bridge` would drag its whole
// graph (SubagentManager, telegram push, …) into every module that loads the
// send path, including tests that partially mock those modules. The dynamic
// import runs only after a turn that named a `/skill` candidate.
async function loadPluginDiscovery() {
  const [bridge, injector, commands] = await Promise.all([
    import('../tools/skill-bridge.js'),
    import('../plugins/tool-injector.js'),
    import('../plugins/command-files.js'),
  ]);
  return {
    scanAllPluginRoots: bridge.scanAllPluginRoots,
    extractPluginSkills: injector.extractPluginSkills,
    resolveKnownToolNames: injector.resolveKnownToolNames,
    extractPluginCommands: commands.extractPluginCommands,
  };
}

const PLUGIN_NAMES_TTL_MS = 5 * 60_000;

const pluginNameCache = new Map<string, { at: number; names: ReadonlySet<string> }>();
const pluginNameInflight = new Map<string, Promise<ReadonlySet<string>>>();

async function pluginSkillNames(cwd: string | undefined): Promise<ReadonlySet<string>> {
  const key = cwd ?? '';
  const hit = pluginNameCache.get(key);
  if (hit && Date.now() - hit.at < PLUGIN_NAMES_TTL_MS) return hit.names;
  const inflight = pluginNameInflight.get(key);
  if (inflight) return inflight;
  const promise = discoverPluginSkillNames(key, cwd);
  pluginNameInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    pluginNameInflight.delete(key);
  }
}

async function discoverPluginSkillNames(key: string, cwd: string | undefined): Promise<ReadonlySet<string>> {
  const { scanAllPluginRoots, extractPluginSkills, resolveKnownToolNames, extractPluginCommands } =
    await loadPluginDiscovery();
  const names = new Set<string>();
  const knownToolNames = resolveKnownToolNames();
  const roots = scanAllPluginRoots(cwd !== undefined ? { cwd } : undefined);
  for (const plugin of roots) {
    if (plugin.type !== 'local') continue;
    for (const s of [
      ...extractPluginSkills(plugin.path, knownToolNames),
      ...extractPluginCommands(plugin.path, knownToolNames),
    ]) {
      if (s.name) names.add(bareSkillName(s.name));
    }
  }
  pluginNameCache.set(key, { at: Date.now(), names });
  return names;
}

/**
 * Return the subset of `candidates` that name an installed skill. Never
 * throws: a discovery failure resolves to the registry-only answer.
 */
export async function resolveInstalledSkillNames(
  candidates: readonly string[],
  cwd?: string,
): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  if (candidates.length === 0) return found;
  const registry = new Set(listSkills().map(bareSkillName));
  let plugins: ReadonlySet<string> = new Set();
  try {
    plugins = await pluginSkillNames(cwd);
  } catch {
    // Telemetry must never fail the turn; fall back to registry names.
  }
  for (const name of candidates) {
    if (registry.has(name) || plugins.has(name)) found.add(name);
  }
  return found;
}
