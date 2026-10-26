/**
 * Slash-command dispatch for the `afk web` surface.
 *
 * The REPL has a full slash-dispatch pipeline in `cli/commands/interactive/
 * loop-iteration.ts` that parses `/`-prefixed input, dispatches native
 * commands, runs preflights, and injects skill-invocation messages. None of
 * that existed on the web surface -- the prompt path sent text verbatim to
 * `sendMessageStream`.
 *
 * This module bridges the gap for SKILL commands (the ones that matter for
 * web users). Native REPL commands (`/clear`, `/exit`, `/model`, etc.) are
 * rejected with a diagnostic -- they drive terminal machinery that doesn't
 * exist here.
 *
 * Contract: the module uses DYNAMIC imports for the slash registry and skill
 * bridge to match the lazy-loading pattern already established in
 * `handleCommands` (routes.ts). This keeps the heavy `cli/slash` import
 * tree off the web server's startup path.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { ensureSlashRegistry, resetSlashRegistry } from './slash-registry.js';
import { isGated } from './command-gate.js';

export type SlashDispatchResult =
  | { kind: 'passthrough' }
  | { kind: 'native' }
  | { kind: 'skill'; message: ContentBlockParam[] }
  | { kind: 'repl-only'; command: string }
  | { kind: 'unknown'; command: string; suggestion?: string };

/**
 * Test seam: kept as a thin wrapper over the shared resetSlashRegistry()
 * so existing tests that import this name continue to work without changes.
 */
export function resetSlashDispatchRegistration(): void {
  resetSlashRegistry();
}

/**
 * Classify and, for skill commands, build the invocation payload.
 *
 * Returns:
 * - `passthrough` -- not a slash command; send as plain text.
 * - `skill` -- a skill invocation with a ready-to-send ContentBlockParam[].
 * - `repl-only` -- a native REPL command that cannot run on this surface.
 * - `unknown` -- unrecognised command (with an optional did-you-mean hint).
 *
 * The caller (`handlePrompt`) decides the HTTP response for each case.
 */
export async function classifySlashInput(
  text: string,
  cwd: string,
  sessionId: string | undefined,
): Promise<SlashDispatchResult> {
  if (!text.trimStart().startsWith('/')) return { kind: 'passthrough' };

  // Lazy-load the slash registry (matches handleCommands' dynamic import
  // pattern -- keeps the cli/slash import tree off the server's startup).
  // Registration is memoized: registerAll() resets the process-global registry,
  // so concurrent calls without memoization would race and wipe each other.
  await ensureSlashRegistry();

  const registry = await import('../cli/slash/registry.js');

  const parsed = registry.parse(text);
  if (!parsed) return { kind: 'passthrough' };

  // Look up the command first, then check the gate list on the RESOLVED
  // canonical name (cmd.name) rather than the raw parsed token. This ensures
  // aliases (e.g. /quit -> /exit) are correctly caught: the alias resolves to
  // a cmd whose canonical name IS gated even though the alias itself is not.
  const cmd = registry.lookup(parsed.name);
  if (!cmd) {
    // For unknown commands, check the raw parsed name against the gate list
    // (they can't resolve to an alias-target anyway).
    if (isGated(parsed.name)) {
      return { kind: 'repl-only', command: parsed.name };
    }
    const suggestion = registry.suggest(parsed.name) ?? undefined;
    return { kind: 'unknown', command: parsed.name, suggestion };
  }

  // Check the RESOLVED canonical name against the gate list.
  if (isGated(cmd.name)) {
    return { kind: 'repl-only', command: cmd.name };
  }

  // Native commands that aren't REPL-only but also aren't skill dispatches
  // (e.g. /help, /cost) -- route to the command execution API on the web
  // surface. Only skill commands (those with acceptsAttachments) get the
  // structured invocation treatment.
  if (!cmd.acceptsAttachments) {
    return { kind: 'native' };
  }

  // Fix 3: Use the FULL resolved command name (minus leading `/`) for
  // getSkill() and buildSkillInvocationMessage. The bare `.split(':').pop()`
  // would strip the namespace prefix, causing `/user:mint` to resolve to the
  // vendored `mint` skill instead of the user-scoped one.
  const fullSkillName = parsed.name.replace(/^\//, '');

  // The preflight lookup uses the bare name because preflights are registered
  // by bare name in the preflight registry.
  const bareSkillName = fullSkillName.split(':').pop() ?? fullSkillName;

  const message = await buildSkillPayload(fullSkillName, bareSkillName, parsed.args, cwd, sessionId);
  return { kind: 'skill', message };
}

/**
 * Build the ContentBlockParam[] payload for a skill invocation.
 *
 * Runs the registered preflight (if any) and produces the same multi-block
 * message shape the REPL's `runSkillDispatchTurn` sends through
 * `sendMessageStream`.
 *
 * @param fullSkillName - Full skill name without leading `/` (e.g. `user:mint`).
 * @param bareSkillName - Bare skill name without namespace (e.g. `mint`), used
 *   for preflight lookup which is keyed by bare name.
 */
async function buildSkillPayload(
  fullSkillName: string,
  bareSkillName: string,
  args: string,
  cwd: string,
  sessionId: string | undefined,
): Promise<ContentBlockParam[]> {
  const [
    { buildSkillInvocationMessage },
    { getPreflight, runPreflight, getSkillPreflightDir },
    { getSkill },
  ] = await Promise.all([
    import('../cli/slash/_lib/skill-message-bridge.js'),
    import('../cli/slash/preflight/index.js'),
    import('../skills/skill-registry.js'),
  ]);

  // Run preflight if registered (e.g. review-pr gathers diff context).
  // Preflights are keyed by bare name.
  let manifestBlock: string | undefined;
  const preflight = getPreflight(bareSkillName);
  if (preflight) {
    try {
      const artifactDir = getSkillPreflightDir(sessionId);
      const result = await runPreflight(
        {
          skillName: bareSkillName,
          rawArgs: args,
          source: 'plugin',
          capabilities: { compose: true, subagents: true },
        },
        { cwd, artifactDir },
      );
      manifestBlock = result?.manifestBlock;
    } catch {
      // Preflight failure must never block a skill from running.
    }
  }

  // Build the skill metadata adapter -- only .name and .context are consumed
  // by buildSkillInvocationMessage. Use the FULL skill name so that namespaced
  // skills (e.g. user:mint) resolve correctly in the skills registry.
  let skillMeta;
  try {
    skillMeta = getSkill(fullSkillName);
  } catch {
    // Skill not in the TS registry (plugin-only skill or namespaced). Synthesise
    // a minimal adapter -- same pattern as makeForwardHandler in dispatch.ts.
    skillMeta = {
      name: fullSkillName,
      description: '',
      handler: async () => undefined,
      context: 'inline' as const,
    };
  }

  return buildSkillInvocationMessage(skillMeta, args, manifestBlock, undefined, sessionId);
}
