/**
 * Skill router — intercepts slash-command input and dispatches to registered skills.
 *
 * Parses `/commandName args` format and invokes the corresponding skill handler
 * from the skill registry. Handles JSON parsing, string wrapping, and error cases.
 *
 * @module cli/commands/skill-router
 */

import { getSkill, listSkills, isSkillVisible } from '../../skills/index.js';
import { env } from '../../config/env.js';
import type { IAgentSession } from '../../agent/types.js';

// Import skill modules to trigger registerSkill() side-effects.
// diagnose is no longer a vendored TS registry skill — it ships as the
// bundled-plugin `awa-bundled/skills/diagnose` SKILL.md (context: fork),
// resolved via the plugin scanner, not registerSkill().
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import '../../skills/mint/index.js';

export interface RouteResult {
  handled: true;
  output: string;
  status: 'ok' | 'error' | 'help';
}

/**
 * Parse slash-command input and dispatch to registered skill handler.
 *
 * Format: `/commandName [args]`
 * - `/help` → list all registered skills
 * - `/unknown` → error with available skills
 * - `/mint { "idea": "test" }` → invoke mint handler with parsed JSON
 * - `/diagnose crash on startup` → invoke diagnose with { input: "crash on startup" }
 * - `/example-skill` → invoke with {}
 *
 * @param input - User input line (must start with `/` to be routed)
 * @param session - Parent agent session (passed to handler)
 * @returns RouteResult if handled (status ok|error|help), or null if not a slash command
 */
export async function tryRouteSkill(
  input: string,
  session: IAgentSession,
): Promise<RouteResult | null> {
  // Only handle slash-prefixed input
  if (!input.startsWith('/')) {
    return null;
  }

  // Parse command name and args
  const trimmed = input.slice(1).trim();
  const spaceIdx = trimmed.indexOf(' ');
  const commandName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const argsStr = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  // Handle /help meta-command
  if (commandName === 'help') {
    // Tier gate: hide internal-audience skills (forge, audit-fit, …) unless
    // AFK_INTERNAL=1, in lockstep with the slash-command and system-prompt
    // manifest surfaces. (As of this writing tryRouteSkill has no production
    // call site — it is exercised only by tests — so this filter is defensive:
    // it keeps surfacing consistent if the router is ever wired in.)
    const internalUnlocked = env.AFK_INTERNAL === '1';
    const lines: string[] = ['Available skills:'];
    for (const name of listSkills()) {
      let skill;
      try {
        skill = getSkill(name);
      } catch {
        // Skill lookup failed — list the bare name without a description.
        lines.push(`  /${name}`);
        continue;
      }
      if (!isSkillVisible(skill, internalUnlocked)) continue;
      lines.push(`  /${name} — ${skill.description}`);
    }
    return {
      handled: true,
      status: 'help',
      output: lines.join('\n'),
    };
  }

  // Look up skill
  let skill;
  try {
    skill = getSkill(commandName);
  } catch (err) {
    // Only suggest skills visible at the current tier (same gate as /help).
    const internalUnlocked = env.AFK_INTERNAL === '1';
    const skillNames = listSkills().filter((name) => {
      try {
        return isSkillVisible(getSkill(name), internalUnlocked);
      } catch {
        return false;
      }
    });
    const availableMsg =
      skillNames.length > 0
        ? `Available: ${skillNames.join(', ')}`
        : 'No skills registered.';
    const errorMsg = `Unknown skill: ${commandName}. ${availableMsg}`;
    return {
      handled: true,
      status: 'error',
      output: errorMsg,
    };
  }

  // Parse args: try JSON, fall back to raw string wrapped
  let parsedArgs: unknown;
  if (!argsStr) {
    parsedArgs = {};
  } else {
    try {
      parsedArgs = JSON.parse(argsStr);
    } catch {
      // Not valid JSON — wrap as { input: string }
      parsedArgs = { input: argsStr };
    }
  }

  // Invoke handler
  try {
    const result = await skill.handler(parsedArgs, session);

    // Format result based on type
    let output: string;
    if (
      typeof result === 'object' &&
      result !== null &&
      'paused' in result
    ) {
      // Skill is paused (e.g., for user approval)
      output = JSON.stringify(result, null, 2);
    } else if (typeof result === 'string') {
      output = result;
    } else {
      output = JSON.stringify(result, null, 2);
    }

    return {
      handled: true,
      status: 'ok',
      output,
    };
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : String(err);
    return {
      handled: true,
      status: 'error',
      output: `Skill handler error: ${errorMsg}`,
    };
  }
}
