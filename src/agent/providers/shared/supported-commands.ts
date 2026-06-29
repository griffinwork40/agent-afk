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
import { collectSkillEntries } from '../../tools/skill-bridge.js';

/**
 * Returns `ProviderCommandInfo` for every skill the skill-bridge can discover.
 * Discovery is best-effort — returns `[]` on any error so the REPL stays
 * usable without skill plugins installed.
 */
export function collectSupportedCommands(): Promise<ProviderCommandInfo[]> {
  try {
    const entries = collectSkillEntries();
    return Promise.resolve(
      entries.map((e) => {
        const info: ProviderCommandInfo = {
          name: e.name,
          description: e.description,
        };
        if (e.argumentHint) info.argumentHint = e.argumentHint;
        return info;
      }),
    );
  } catch {
    // Discovery is best-effort — the REPL stays usable without it.
    return Promise.resolve([]);
  }
}
