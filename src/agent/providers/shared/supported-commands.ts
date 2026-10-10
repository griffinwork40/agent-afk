/**
 * Provider-neutral `supportedCommands` helper.
 *
 * Surfaces every skill discovered by the skill-bridge — built-in TS skills,
 * user-scope `~/.afk/skills/`, and plugin SKILL.md files under
 * `~/.afk/plugins/` — so the REPL slash registry can register a passthrough
 * `/<skill>` for each one. Without this, `/reload-plugins` reports 0 skills
 * and typing `/mint` does not autocomplete.
 *
 * The model learns about skills via the system-prompt manifest (built from
 * `collectSkillEntries()` in each provider's query method); reusing the same
 * collector here keeps the slash list and the manifest in lockstep.
 *
 * Previously duplicated verbatim in:
 *   - `anthropic-direct/query.ts`  (`AnthropicDirectQuery.supportedCommands`)
 *   - `openai-compatible/query.ts` (`OpenAICompatibleQuery.supportedCommands`)
 *
 * Both methods have been replaced with a delegating call to this helper.
 *
 * @module agent/providers/shared/supported-commands
 */

import type { ProviderCommandInfo } from '../../provider.js';
import type { SdkPluginConfig } from '../../types/sdk-types.js';
import { collectSkillEntries } from '../../tools/skill-bridge.js';

/**
 * Scope returned by `SkillExecutor.getManifestScope()` — subset of the fields
 * we care about here. Declared inline so this module does not import the full
 * executor class (which carries heavy runtime deps).
 */
export interface SupportedCommandsScope {
  /**
   * Plugin source override. Defined => only these plugins are scanned.
   * `[]` => no plugin skills. `undefined` => scan all plugin roots.
   */
  pluginConfigs?: SdkPluginConfig[];
  /**
   * Allowlist for the model-facing manifest. When defined, only listed skill
   * names (exact match) are returned. `undefined` => no gate.
   */
  skillAllowlist?: readonly string[];
}

/**
 * Returns `ProviderCommandInfo` for every skill the skill-bridge can discover.
 * Discovery is best-effort — returns `[]` on any error so the REPL stays
 * usable without skill plugins installed.
 *
 * When `scope` is provided (from `SkillExecutor.getManifestScope()`), the
 * result is restricted to the executor's configured plugin source and allowlist
 * so the slash command list mirrors what the model sees in its manifest.
 */
export function collectSupportedCommands(scope?: SupportedCommandsScope): Promise<ProviderCommandInfo[]> {
  try {
    const entries = collectSkillEntries(scope?.pluginConfigs);
    const allowlist = scope?.skillAllowlist;
    const filtered = allowlist !== undefined
      ? entries.filter((e) => allowlist.includes(e.name))
      : entries;
    return Promise.resolve(
      filtered.map((e) => {
        const info: ProviderCommandInfo = {
          name: e.name,
          description: e.description,
        };
        if (e.argumentHint) info.argumentHint = e.argumentHint;
        if (e.whenToUse) info.whenToUse = e.whenToUse;
        if (e.flags && e.flags.length > 0) info.flags = e.flags;
        if (e.category) info.category = e.category;
        if (e.source) info.source = e.source;
        return info;
      }),
    );
  } catch {
    // Discovery is best-effort — the REPL stays usable without it.
    return Promise.resolve([]);
  }
}
