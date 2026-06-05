/**
 * Built-in TypeScript skill bridge.
 *
 * Registers every skill from `src/skills/` as an immediate slash command.
 * Each handler injects a 2-block user message into the parent session — an
 * XML breadcrumb plus a dispatch instruction — so the model narrates and
 * then calls the `skill` tool, which routes through SkillExecutor → handler.
 * This preserves the Zod schema flow and works with any provider, including
 * anthropic-direct (which has no SDK subprocess).
 *
 * Import side-effects in the barrel import trigger each skill's
 * `registerSkill()` call, populating the global skill registry before
 * `registerBuiltinSkillCommands()` reads it.
 */

import { listSkills, getSkill, isSkillVisible, type SkillMetadata } from '../../skills/index.js';
// Barrel import triggers self-registration side-effects for built-in skills.
import { scanAndRegisterUserSkills, scanSkillsFromDir } from '../../skills/all.js';
import { getProjectSkillsDir } from '../../paths.js';
import { registerOrReplace } from './registry.js';
import { runSkillDispatchTurn } from './_lib/run-skill-dispatch-turn.js';
import { runPreflight, getSkillPreflightDir, initBuiltinPreflights, type SkillInvocation } from './preflight/index.js';
import type { SlashCommand, SlashContext, SlashResult } from './types.js';
import type { ImageAttachment } from '../input/attachments.js';
import { env } from '../../config/env.js';

/** Map a SkillMetadata origin → SkillInvocation source. */
function originToSource(origin: SkillMetadata['origin']): SkillInvocation['source'] {
  // Normalise undefined (absent = vendored builtin) before the switch so the
  // compiler can enforce exhaustiveness over the 3-string union.
  const resolved = origin ?? 'builtin';
  switch (resolved) {
    case 'builtin':  return 'builtin';
    case 'user':     return 'user';
    case 'project':  return 'project';
    default: {
      // C04: Type-level exhaustiveness check — compile error if a new origin
      // value is added to SkillMetadata without a corresponding case here.
      // Throw at runtime so an unhandled origin is never silently returned as
      // `never` (which would produce `undefined` instead of failing loudly).
      const _exhaustive: never = resolved;
      throw new Error(`[afk builtin-skills] Unhandled origin: ${String(_exhaustive)}`);
    }
  }
}

export function makeImmediateHandler(skill: SkillMetadata): SlashCommand {
  const slashName = `/${skill.name}`;
  const usage = skill.argumentHint ? `${slashName} ${skill.argumentHint}` : undefined;
  return {
    name: slashName,
    summary: skill.description,
    acceptsAttachments: true,
    ...(usage !== undefined ? { usage } : {}),
    ...(skill.whenToUse ? { hint: skill.whenToUse } : {}),
    ...(skill.flags && skill.flags.length > 0 ? { flags: skill.flags } : {}),
    async handler(ctx: SlashContext, args: string, attachments?: readonly ImageAttachment[]): Promise<SlashResult> {
      try {
        await runSkillDispatchTurn(ctx, {
          skillName: skill.name,
          skillMeta: skill,
          args,
          attachments,
          // SkillPreflight — runtime-owned context gathering, runs inside
          // the armed renderer (helper invokes the callback after arm()
          // so the spinner is visible during any I/O the preflight does).
          // Registered preflights produce a manifest block prepended as
          // additive context; the breadcrumb + instruction tail of the
          // message stays bit-for-bit identical so the `skill` tool
          // dispatch the model recognizes is preserved.
          //
          // Failure isolation: a preflight that throws or returns null
          // falls back to the existing 2-block dispatch unchanged. The
          // helper's outer catch swallows thrown callbacks; `runPreflight`
          // itself also wraps in try/catch internally, so the only
          // exception that ever reaches the helper is a synchronous
          // throw in this closure (e.g. SkillInvocation construction).
          preflight: async (): Promise<string | undefined> => {
            const inv: SkillInvocation = {
              skillName: skill.name,
              rawArgs: args,
              source: originToSource(skill.origin),
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
                  ctx.out.warn(`preflight(${skill.name}) failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              },
            );
            return preflightResult?.manifestBlock;
          },
        });
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
 * Register all built-in TS skills as immediate slash commands.
 * Safe to call multiple times — uses registerOrReplace. The `/builtin-skills`
 * legacy listing command lives on the unified `/skills` (see plugin-skills.ts)
 * via an alias, so callers and tests that look up `/builtin-skills` keep
 * working.
 */
export function registerBuiltinSkillCommands(): void {
  // A02: explicitly initialize built-in preflights here, at the
  // bootstrapping entry point, instead of relying on the barrel's
  // module-evaluation side effect.
  initBuiltinPreflights();

  // Scan user-space then project-space skills before reading the registry.
  scanAndRegisterUserSkills();
  scanSkillsFromDir(getProjectSkillsDir(), 'project');

  // Tier gate: skills tagged `audience: 'internal'` (forge, audit-fit, etc.)
  // are filtered from the slash-command surface unless `AFK_INTERNAL=1`
  // unlocks the maintainer tier. The registry itself is unchanged — internal
  // skills remain dispatchable via `getSkill()` for tests and internal code
  // paths; only end-user surfacing is gated. Re-read `env.AFK_INTERNAL` on
  // every call (no caching) so the per-call value wins over import-time
  // state — matches the env.ts lazy-getter contract.
  const internalUnlocked = env.AFK_INTERNAL === '1';
  for (const name of listSkills()) {
    const skill = getSkill(name);
    if (!isSkillVisible(skill, internalUnlocked)) continue;
    registerOrReplace(makeImmediateHandler(skill));
  }
}
