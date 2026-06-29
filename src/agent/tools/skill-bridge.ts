/**
 * Skill-to-tool bridge.
 *
 * Collects skill metadata from the global skill registry (built-in + user
 * skills) and from plugin SKILL.md files, then produces:
 *   - A system-prompt manifest listing available skills so the model knows
 *     what it can invoke via the `skill` tool.
 *   - A body lookup map for plugin skills so {@link SkillExecutor} can
 *     dispatch subagents with the SKILL.md body as the system prompt.
 *
 * @module agent/tools/skill-bridge
 */

// Barrel import triggers self-registration side-effects for built-in skills.
import '../../skills/all.js';

import { listSkills, getSkill, registerSkill, isSkillVisible } from '../../skills/index.js';
import { loadSkillPrompts } from '../../skills/_lib/prompt-loader.js';
import { scanSkillsFromDir } from '../../skills/user-skills.js';
import { scanLocalPlugins } from '../plugins-scanner.js';
import { loadPluginEntrypoints } from '../plugins/load-entrypoints.js';
import { extractPluginSkills } from '../plugins/tool-injector.js';
import { SubagentManager } from '../subagent.js';
import { describeFailure } from '../subagent/result.js';
import {
  deriveSessionFacet,
  getOrDeriveFacet,
  listSessionIds,
  loadStoredSession,
} from '../facets/index.js';
import type { SdkPluginConfig } from '../types/sdk-types.js';
import {
  getAgentFrameworkDir,
  getBundledPluginsDir,
  getProjectPluginsDir,
  getProjectSkillsDir,
  getSessionsDir,
  getSkillsDir,
} from '../../paths.js';
import { env } from '../../config/env.js';
import { loadImportFromConfig, resolveImportedRoots } from '../../config/import-sources.js';


export interface SkillManifestEntry {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'project' | 'plugin' | 'imported';
  argumentHint?: string;
  whenToUse?: string;
}

/**
 * Build a system-prompt manifest of all available skills.
 *
 * Merges skills from the global registry (built-in TS skills + user-space
 * `~/.afk/skills/`) with plugin-discovered SKILL.md files. Returns a
 * formatted string to inject into the system prompt.
 *
 * Each skill entry includes name, description, and optional argumentHint
 * and whenToUse fields if present in the skill metadata.
 */
export function buildSkillManifest(
  pluginConfigs?: SdkPluginConfig[],
): string {
  const entries = collectSkillEntries(pluginConfigs);
  if (entries.length === 0) return '';

  const lines: string[] = [];
  for (const e of entries) {
    const hint = e.argumentHint ? `${e.argumentHint}` : '';
    const mainLine = hint ? `- \`${e.name} ${hint}\`: ${e.description}` : `- ${e.name}: ${e.description}`;
    lines.push(mainLine);
    if (e.whenToUse) {
      lines.push(`  When to use: ${e.whenToUse}`);
    }
  }

  return [
    'Available skills (invoke via the `skill` tool):',
    '',
    "Each skill either dispatches one or more context-isolated subagents (delegation — preserves the main session's context) or loads its instructions directly into your current context (`load` mode). Calling `skill` is the entry point for both; the executor picks the mode per skill. Prefer a skill over inline investigation when the task shape matches.",
    '',
    ...lines,
  ].join('\n');
}

/**
 * Collect all skill entries from registry + plugins.
 */
export function collectSkillEntries(
  pluginConfigs?: SdkPluginConfig[],
): SkillManifestEntry[] {
  const entries: SkillManifestEntry[] = [];
  const seen = new Set<string>();

  // Tier gate (parallel to the slash-command filter in builtin-skills.ts):
  // hide internal-audience skills from the manifest the model sees unless
  // `AFK_INTERNAL=1`. If we surfaced them in the manifest but hid them from
  // slash commands, the model could dispatch via the `skill` tool while end
  // users can't invoke directly — a worse failure mode than a clean split.
  const internalUnlocked = env.AFK_INTERNAL === '1';

  // Resolve imported roots once — reused for both the skill-root scan loop
  // (step 1) and the plugin-config expansion (step 3). Avoids duplicate
  // loadImportFromConfig() + existsSync passes per manifest build.
  const importedRoots = resolveImportedRoots(loadImportFromConfig());

  // 1. Populate the registry with user + project disk skills so the manifest
  //    is complete on every surface (daemon, Telegram, one-shot, subagent)
  //    regardless of whether the CLI slash-command path ran first.
  //    scanSkillsFromDir is idempotent for same-origin re-scans: resolveSkillKey
  //    reuses the bare name when the existing registry entry shares the same
  //    origin, preventing duplicate aliases (e.g. both `foo` and `user:foo`).
  //    (~/.afk/skills/ is typically <20 entries, all single-file reads.)
  //    Scan order matches builtin-skills.ts (user-space first, then project).
  //    The first registrant keeps the bare name on collision, so user-scope
  //    wins the bare slot and an identically-named project skill falls back to
  //    `project:<name>`. Both lose the bare slot to an already-registered
  //    builtin (origin undefined) via the resolveSkillKey collision logic.
  scanSkillsFromDir(getSkillsDir(), 'user');
  scanSkillsFromDir(getProjectSkillsDir(), 'project');
  // Imported skills from trusted source binaries (Claude Code, Codex) opted
  // into via `importFrom`. Scanned AFTER native scopes so a native skill keeps
  // the bare name on collision; an imported same-name skill falls back to
  // `imported:<binary>:<name>` via resolveSkillKey.
  for (const { dir, origin } of importedRoots.skillRoots) {
    scanSkillsFromDir(dir, origin);
  }

  // 2. Registry skills (built-in + user + project). The barrel import at the
  //    top of this file self-registers built-in skills; the two scan calls
  //    above ensure user and project skills are also present.
  for (const name of listSkills()) {
    const skill = getSkill(name);
    if (!isSkillVisible(skill, internalUnlocked)) continue;
    entries.push({
      name,
      description: skill.description,
      source:
        skill.origin === 'user'
          ? 'user'
          : skill.origin === 'project'
            ? 'project'
            : skill.origin?.startsWith('imported:')
              ? 'imported'
              : 'builtin',
      argumentHint: skill.argumentHint,
      whenToUse: skill.whenToUse,
    });
    seen.add(name);
  }

  // 3. Plugin skills — from SKILL.md frontmatter in plugin directories.
  //    Scan order: project-scope → user-scope → bundled (lowest priority).
  //    Plugin frontmatter MAY carry `audience: internal` to opt into the
  //    same tier gate — extractPluginSkills() surfaces it as `audience`,
  //    defaulting to 'public' when absent.
  const plugins = pluginConfigs ?? scanAllPluginRoots();
  for (const plugin of plugins) {
    if (plugin.type !== 'local') continue;
    const skills = extractPluginSkills(plugin.path);
    for (const skill of skills) {
      if (!skill.name || seen.has(skill.name)) continue;
      if (!isSkillVisible({ audience: skill.audience }, internalUnlocked)) continue;
      entries.push({
        name: skill.name,
        description: skill.description ?? `Skill from plugin at ${plugin.path}`,
        source: 'plugin',
      });
      seen.add(skill.name);
    }
  }

  return entries;
}

/**
 * Plugin skill body + the absolute path of the plugin it came from.
 *
 * `pluginPath` is used by `executePluginSkill` to inject `PLUGIN_ROOT`
 * into the forked subagent's tool-handler context, so shell commands in
 * the body that reference `${PLUGIN_ROOT}/...` resolve correctly.
 *
 * `allowedTools` is the resolved tool allowlist from the SKILL.md `tools:`
 * frontmatter field. When present, `executePluginSkill` must restrict the
 * forked subagent's provider to this set only. When absent, the default
 * `CHILD_ALLOWED_TOOLS` surface applies (backward-compatible).
 */
export interface PluginSkillBody {
  body: string;
  pluginPath: string;
  /** Resolved AFK-canonical tool names from the `tools:` frontmatter field, or undefined. */
  allowedTools?: string[];
  /**
   * Execution mode from SKILL.md frontmatter `context:`. The executor forks a
   * subagent ONLY when this is `'fork'`; undefined/`'load'`/other values load
   * the body into the current session (the default since 2026-06; see
   * docs/skill-load-mode.md).
   */
  context?: string;
  /**
   * Read-only enforcement flag from SKILL.md frontmatter `read-only:`. When
   * `true`, the forked subagent is built with the RECON tool allowlist and a
   * mutating-bash guard (see `nesting.ts` / dispatcher `readOnlyBash`).
   * Absent → historical full-write fork.
   */
  readOnly?: boolean;
}

/**
 * Discover plugin skill bodies for subagent dispatch.
 *
 * Returns a map from skill name → `{ body, pluginPath }`. Only includes
 * plugin skills with non-empty bodies (skills without a body can't
 * meaningfully drive a subagent).
 *
 * `pluginPath` is the absolute directory of the plugin that contributed
 * the skill — needed downstream to set `PLUGIN_ROOT` in the subagent's
 * Bash-tool spawn env.
 */
export function discoverPluginSkillBodies(
  pluginConfigs?: SdkPluginConfig[],
): Map<string, PluginSkillBody> {
  // Invariant: no audience filter — dispatch is always available; only surfacing is gated.
  // Do NOT add isSkillVisible() here; see this comment before 'fixing' it.
  const bodies = new Map<string, PluginSkillBody>();
  // Imported plugin roots are resolved inline in the fallback so the
  // loadImportFromConfig() + existsSync work only runs when no pluginConfigs
  // were supplied (a caller passing pluginConfigs skips it entirely).
  const plugins = pluginConfigs ?? scanAllPluginRoots();

  for (const plugin of plugins) {
    if (plugin.type !== 'local') continue;
    const skills = extractPluginSkills(plugin.path);
    for (const skill of skills) {
      if (skill.name && skill.body && skill.body.length > 0 && !bodies.has(skill.name)) {
        bodies.set(skill.name, {
          body: skill.body,
          pluginPath: plugin.path,
          ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
          ...(skill.context !== undefined ? { context: skill.context } : {}),
          ...(skill.readOnly === true ? { readOnly: true } : {}),
        });
      }
    }
  }

  return bodies;
}

/**
 * Aggregate every plugin root AFK loads from, in priority order:
 * project-scope → user-scope → bundled → imported (trusted) roots. Single
 * source of truth for "which plugins exist," shared by skill-manifest
 * collection, plugin-body discovery, and boot-time entrypoint loading so the
 * three never drift apart.
 */
export function scanAllPluginRoots(): SdkPluginConfig[] {
  return [
    ...scanLocalPlugins(getProjectPluginsDir()),
    ...scanLocalPlugins(),
    ...scanLocalPlugins(getBundledPluginsDir()),
    ...resolveImportedRoots(loadImportFromConfig()).pluginRoots.flatMap((root) =>
      scanLocalPlugins(root, { trustAll: true }),
    ),
  ];
}

/**
 * Import the JS entrypoint of every discovered plugin that declares a manifest
 * `main`, so a plugin's top-level `registerSkill()` side-effects populate the
 * global registry BEFORE the skill manifest is built. Awaiting this before
 * constructing an AgentSession is what lets a plugin contribute code-backed
 * skills (the manifest is assembled synchronously at session construction).
 *
 * Idempotent and process-global (see {@link loadPluginEntrypoints}): cheap to
 * await from every surface bootstrap, a no-op for already-loaded entrypoints,
 * and non-fatal per plugin. A subagent inherits the parent process's registry,
 * so calling it again in a child is a safe no-op.
 */
export async function ensurePluginEntrypointsLoaded(): Promise<void> {
  // Inject the host's runtime API so a code-backed plugin's default-export
  // entrypoint (a) registers against THIS process's singleton registry, and
  // (b) can reach core runtime values (env, SubagentManager, describeFailure,
  // discoverPluginSkillBodies, the session-facet substrate, the paths getters) WITHOUT a bare
  // `import 'agent-afk'` — which a marketplace-cloned plugin (no node_modules)
  // cannot resolve at all. See PluginApi for the full rationale.
  await loadPluginEntrypoints(scanAllPluginRoots(), {
    pluginApi: {
      registerSkill,
      listSkills,
      getSkill,
      loadSkillPrompts,
      env,
      SubagentManager,
      describeFailure,
      discoverPluginSkillBodies,
      getAgentFrameworkDir,
      getSkillsDir,
      getSessionsDir,
      getOrDeriveFacet,
      listSessionIds,
      deriveSessionFacet,
      loadStoredSession,
    },
  });
}
