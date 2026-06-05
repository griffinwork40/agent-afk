/**
 * Plugin-agent listing.
 *
 * Queries the Claude Agent SDK for every Task-tool subagent loaded from
 * `~/.afk/plugins/` and renders them for `/agents`. Unlike plugin skills,
 * agents are NOT user-invokable via slash — they're dispatch targets the
 * model selects when it calls the `Task` tool. So this module installs a
 * pure display command plus a placeholder that hot-swaps after init.
 *
 * Mirrors the flow of `plugin-skills.ts`:
 *   1. `registerStaticPluginAgentCommands()` installs placeholder `/agents`
 *      at REPL boot.
 *   2. `registerPluginAgents(session)` runs after
 *      `session.waitForInitialization()` resolves and hot-swaps the real
 *      list in.
 *   3. `/reload-plugins` (owned by plugin-skills.ts) re-invokes
 *      `registerPluginAgents` alongside `registerPluginSkills`.
 */

import type { AgentSession } from '../../agent/session.js';
import { palette } from '../palette.js';
import { registerOrReplace, register } from './registry.js';
import type { SlashCommand } from './types.js';

interface DiscoveredAgent {
  name: string;
  description: string;
  model?: string;
}

let discoveredAgents: DiscoveredAgent[] = [];

/**
 * Placeholder `/agents` installed by `registerAll()` before the SDK session
 * is up. Real list replaces this once `registerPluginAgents()` runs.
 */
export const initialAgentsCmd: SlashCommand = {
  name: '/agents',
  summary: 'List plugin-provided subagents (loads after session init)',
  async handler(ctx) {
    ctx.out.line();
    ctx.out.line(palette.dim('  Plugin agents are still loading — try again after the session is ready.'));
    ctx.out.line();
    return 'continue';
  },
};

/** Render the live `/agents` listing. */
function makeDynamicAgentsCmd(agents: DiscoveredAgent[]): SlashCommand {
  return {
    name: '/agents',
    summary: 'List Task-tool subagents loaded by the SDK (plugin + user + project)',
    async handler(ctx) {
      ctx.out.line();
      if (agents.length === 0) {
        ctx.out.line(palette.dim('  No plugin agents loaded. Agents come from `agents:` entries in plugin.json or from ~/.afk/agents/.'));
        ctx.out.line();
        return 'continue';
      }
      ctx.out.line(palette.bold('Plugin agents') + palette.dim(`  (${agents.length} loaded)`));
      ctx.out.line(palette.dim('─'.repeat(60)));
      const maxName = agents.reduce((m, a) => Math.max(m, a.name.length), 0) + 2;
      for (const a of agents) {
        const nameCell = palette.warning(a.name.padEnd(maxName));
        const modelCell = a.model ? palette.dim(`[${a.model}]`) : '';
        const desc = a.description ? palette.dim(`  ${a.description}`) : '';
        ctx.out.line(`  ${nameCell} ${modelCell}${desc}`);
      }
      ctx.out.line();
      ctx.out.line(palette.dim('  Agents are dispatched by the model via the Task tool — not user-invoked.'));
      ctx.out.line();
      return 'continue';
    },
  };
}

/**
 * Query the SDK for loaded subagents and hot-swap the `/agents` listing.
 * Safe to call repeatedly — re-registration replaces the prior entry.
 *
 * @returns the discovered agent count, or null if the query failed.
 */
export async function registerPluginAgents(
  session: AgentSession,
): Promise<number | null> {
  let agents;
  try {
    agents = await session.supportedAgents();
  } catch (err) {
    // Non-fatal: REPL keeps working without agent discovery.
    // eslint-disable-next-line no-console
    console.error(
      palette.dim('  ⚠ Plugin-agent discovery failed: ') +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }

  discoveredAgents = agents.map((a) => {
    const entry: DiscoveredAgent = {
      name: a.name,
      description: a.description,
    };
    if (a.model) entry.model = a.model;
    return entry;
  });

  registerOrReplace(makeDynamicAgentsCmd(discoveredAgents));

  return discoveredAgents.length;
}

/** Register the always-available `/agents` placeholder. */
export function registerStaticPluginAgentCommands(): void {
  register(initialAgentsCmd);
}
