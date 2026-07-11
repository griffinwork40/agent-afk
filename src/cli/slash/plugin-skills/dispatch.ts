/**
 * Plugin-skill dispatch: forward-handler construction + registration.
 *
 * Split out of `plugin-skills.ts` (#366) — bridges plugin-discovered skills
 * (from `~/.afk/plugins/.../SKILL.md`) into the slash dispatcher, handling
 * bare-name collisions with vendored/user skills and the `/review --post`
 * special case at the dispatch layer.
 */

import type { AgentSession } from '../../../agent/session.js';
import { listSkills, getSkill, isSkillVisible, type SkillMetadata } from '../../../skills/index.js';
import { palette } from '../../palette.js';
import { registerPluginAgents } from '../plugin-agents.js';
import { registerOrReplace } from '../registry.js';
import { runSkillDispatchTurn } from '../_lib/run-skill-dispatch-turn.js';
import { parsePostFlag, runReviewPostPublish, type PostTarget } from '../_lib/review-post.js';
import { parsePrRef } from '../preflight/review-pr.js';
import {
  runPreflight,
  getSkillPreflightDir,
  type SkillInvocation,
} from '../preflight/index.js';
import { env } from '../../../config/env.js';
import type { SlashCommand, SlashContext, SlashResult } from '../types.js';
import type { ImageAttachment } from '../../input/attachments.js';
import { harvestAllPluginSkillFlags, extractHintFromDescription } from './flags.js';
import { makeDynamicSkillsCmd } from './listing.js';
import {
  state,
  setState,
  bareName,
  type DiscoveredSkill,
  type PluginCollision,
} from './state.js';

const CORE_COMMANDS = new Set(['/exit', '/quit', '/clear', '/compact', '/help']);

/**
 * Build the dispatch handler for a single plugin skill.
 *
 * Exported for regression tests that exercise the symmetric `runPreflight`
 * extension (the production path goes through `registerPluginSkills` →
 * `registerOrReplace`, but tests want to invoke the handler directly with a
 * synthetic `DiscoveredSkill`).
 */
export function makeForwardHandler(skill: DiscoveredSkill, flags?: readonly string[]): SlashCommand {
  const slashName = `/${skill.name}`;
  const usage = skill.argumentHint ? `${slashName} ${skill.argumentHint}` : undefined;
  const hint = extractHintFromDescription(skill.description);
  return {
    name: slashName,
    summary: skill.description,
    // Image-tail parity with `makeImmediateHandler`. Plugin skills go
    // through the same `buildSkillInvocationMessage` encoder, which
    // appends image blocks after the breadcrumb + instruction tail —
    // without `acceptsAttachments: true` the registry would warn and
    // drop attachments before the handler ever ran. See registry.ts.
    acceptsAttachments: true,
    ...(usage !== undefined ? { usage } : {}),
    ...(hint ? { hint } : {}),
    ...(flags && flags.length > 0 ? { flags } : {}),
    async handler(
      ctx: SlashContext,
      args: string,
      attachments?: readonly ImageAttachment[],
    ): Promise<SlashResult> {
      // `/review --post <github|telegram>` — parsed here at the dispatch layer
      // and stripped from the args BEFORE they reach the (read-only) review
      // skill, so the skill never sees `--post` as a review target and never
      // posts anything itself. Publishing happens after the verified output
      // lands (see runReviewPostPublish, below). Gated on the bare name so the
      // flag is review-only; every other plugin skill is unaffected.
      const isReview = bareName(skill.name) === 'review';
      let dispatchArgs = args;
      let postTargets: PostTarget[] = [];
      let prRefFromArgs: string | null = null;
      if (isReview) {
        const parsed = parsePostFlag(args);
        postTargets = parsed.targets;
        dispatchArgs = parsed.cleanedArgs;
        for (const u of parsed.unknown) {
          ctx.out.warn(`/review: unknown --post target "${u}" — expected "github" or "telegram".`);
        }
        if (postTargets.length === 0 && parsed.unknown.length === 0 && /--post\b/.test(args)) {
          ctx.out.warn('/review: --post needs a target — try "--post github" or "--post telegram".');
        }
        // Reuse the preflight's PR-ref parser so `/review 277 --post github`
        // comments on PR 277; a local-diff review (no PR ref) resolves the
        // current branch's PR at publish time instead.
        try {
          prRefFromArgs = parsePrRef(dispatchArgs);
        } catch {
          prRefFromArgs = null;
        }
      }

      // Mirror makeImmediateHandler: build the 2-block skill-invocation payload
      // (breadcrumb + dispatch instruction) and stream it through the session,
      // rather than returning 'forward' and letting the REPL send raw '/skill'
      // text. The raw-text path caused the model to invoke the skill with no
      // context, triggering a 2s no-op before the model manually re-invoked.
      //
      // Plugin skills don't have a SkillMetadata handler or context field.
      // buildSkillInvocationMessage only reads .name and .context, so we
      // synthesise a minimal adapter — context defaults to 'inline' (no fork note).
      const skillMeta: SkillMetadata = {
        name: skill.name,
        description: skill.description,
        // Plugin skills run via the skill tool's plugin executor — no local handler.
        handler: async () => undefined,
        // Plugin skills are always inline from the slash-dispatch perspective;
        // the executor inside the session handles any fork context internally.
        context: 'inline',
      };

      try {
        const finalAssistantText = await runSkillDispatchTurn(ctx, {
          skillName: skill.name,
          skillMeta,
          args: dispatchArgs,
          attachments,
          // SkillPreflight — runtime-owned context gathering, runs inside
          // the armed renderer. Symmetric with makeImmediateHandler
          // (built-in path): registered preflights produce a manifest
          // block prepended as additive context; the breadcrumb +
          // instruction tail stays bit-for-bit identical so the `skill`-
          // tool dispatch the model recognizes is preserved.
          //
          // Lookup key is the *bare* skill name (no `<plugin>:` prefix) so
          // a single registered preflight covers every source
          // (builtin/user/project/plugin) for the same skill name. This
          // matches the registry lookup in repl-loop.ts.
          //
          // Failure isolation: preflight throws or returns null → falls
          // through to the standard 2-block dispatch unchanged. A failing
          // context-gather must never block a skill from running.
          preflight: async (): Promise<string | undefined> => {
            const bareSkillName = skill.name.includes(':')
              ? (skill.name.split(':').pop() ?? skill.name)
              : skill.name;
            const inv: SkillInvocation = {
              skillName: bareSkillName,
              rawArgs: dispatchArgs,
              source: 'plugin',
              capabilities: { compose: true, subagents: true },
            };
            const sessionIdMaybe = ctx.session.current.sessionId;
            const artifactDir = getSkillPreflightDir(sessionIdMaybe);
            const preflightResult = await runPreflight(
              inv,
              // Honor the session's effective cwd so preflights that shell
              // out to `git status` / file globs operate on the worktree,
              // not the Node host's process.cwd() (the parent repo when
              // launched with `afk i --worktree`). `stats.cwd` is stamped
              // at bootstrap.ts:328 with the same `process.cwd()` fallback.
              { cwd: ctx.stats.cwd ?? process.cwd(), artifactDir },
              (err) => {
                if (env.AFK_SKILL_STREAM_VERBOSE === '1') {
                  ctx.out.warn(`preflight(${bareSkillName}) failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              },
            );
            return preflightResult?.manifestBlock;
          },
        });

        // Publish AFTER the verified review output lands. runReviewPostPublish
        // is fail-soft — it never throws and never suppresses the stdout the
        // renderer already streamed, so a posting failure can't be mistaken
        // for a review failure in the catch below.
        if (isReview && postTargets.length > 0) {
          await runReviewPostPublish(ctx.out, {
            targets: postTargets,
            reviewText: finalAssistantText,
            prRefFromArgs,
          });
        }
      } catch (err) {
        ctx.out.line();
        ctx.out.error(
          `${skill.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return 'continue';
    },
  };
}

/**
 * Query the current session for loaded plugin skills and register each as a
 * passthrough slash command. Vendored and user skills already in the global
 * skill registry win bare-name collisions — colliding plugin skills are still
 * reachable via their namespaced form, and surface as alt rows in `/skills`.
 *
 * Safe to call repeatedly — re-registration replaces prior plugin entries.
 *
 * @returns the discovered skill count, or null if the query failed.
 */
export async function registerPluginSkills(
  session: AgentSession,
): Promise<number | null> {
  let commands;
  try {
    commands = await session.supportedCommands();
  } catch (err) {
    // Non-fatal — plugin skills are nice-to-have; the REPL works without them.
    // eslint-disable-next-line no-console
    console.error(
      palette.dim('  ⚠ Plugin-skill discovery failed: ') +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }

  const discovered: DiscoveredSkill[] = commands.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
  }));

  const harvestedFlags = harvestAllPluginSkillFlags();
  // Reserved names = registry skills that are ACTUALLY VISIBLE at the
  // current tier. Internal-tier skills (forge, audit-fit) that are hidden
  // by the audience gate don't reserve their slash — otherwise a plugin
  // contributing `forge` would be pushed to /plugin:forge even though no
  // visible bare /forge exists, leaving the user with a confusing
  // namespace prefix for a slot that's effectively empty.
  const internalUnlocked = env.AFK_INTERNAL === '1';
  const reservedBareNames = new Set(
    listSkills()
      .filter((name) => isSkillVisible(getSkill(name), internalUnlocked))
      .map(bareName),
  );

  const collisions: PluginCollision[] = [];
  const shadowedBareNames = new Set<string>();

  for (const skill of discovered) {
    const slashName = `/${skill.name}`;
    if (CORE_COMMANDS.has(slashName)) continue;

    const bare = bareName(skill.name);
    const flags = harvestedFlags.get(bare);

    if (reservedBareNames.has(bare)) {
      // Vendored or user skill already owns the bare slot. Register only the
      // namespaced form so the plugin skill is still reachable. If the SDK
      // gave us a bare name with no namespace, synthesise one.
      const fallbackName = skill.name.includes(':') ? skill.name : `plugin:${skill.name}`;
      const fallbackSkill: DiscoveredSkill = { ...skill, name: fallbackName };
      registerOrReplace(makeForwardHandler(fallbackSkill, flags));
      collisions.push({
        bare,
        altSlash: `/${fallbackName}`,
        altDescription: skill.description,
      });
      shadowedBareNames.add(bare);
      continue;
    }

    // No collision — register at the SDK-given name (which may already be
    // namespaced like `example-plugin:mint`).
    registerOrReplace(makeForwardHandler(skill, flags));
  }

  setState({ discovered, collisions, shadowedBareNames });
  registerOrReplace(makeDynamicSkillsCmd(discovered));

  return discovered.length;
}

/**
 * Return a one-time dim notice line for each detected plugin shadowing. The
 * REPL post-init wiring captures the result and prints it at the top of the
 * next prompt iteration, so the user sees which plugins got shadowed without
 * extra interaction. Returns an empty array when nothing was shadowed.
 */
export function getPluginShadowingNoticeLines(): string[] {
  if (state.collisions.length === 0) return [];
  return state.collisions.map((c) =>
    palette.dim(
      `  /${c.bare}: vendored or user skill wins; plugin form ${c.altSlash} stays reachable.`,
    ),
  );
}

/**
 * Post-init wiring helper. Called by the REPL once `waitForInitialization()`
 * resolves so users don't have to run `/reload-plugins` manually at every
 * startup. Mirrors the registration half of `/reload-plugins` — skipping the
 * query-side `reloadPlugins()` call, which is unnecessary on a fresh session
 * (the subprocess already scanned plugin dirs during boot).
 *
 * Errors inside `registerPluginSkills` / `registerPluginAgents` are already
 * caught and logged in those functions (returning `null`), so this helper
 * is non-throwing in practice — the REPL stays usable even when discovery
 * fails.
 */
export async function autoRegisterPluginPassthroughs(
  session: AgentSession,
): Promise<{ skillCount: number | null; agentCount: number | null }> {
  const [skillCount, agentCount] = await Promise.all([
    registerPluginSkills(session),
    registerPluginAgents(session),
  ]);
  return { skillCount, agentCount };
}
