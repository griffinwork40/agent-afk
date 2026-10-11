/**
 * Shared skill-preflight invocation helper.
 *
 * Both builtin-skills.ts (makeImmediateHandler) and
 * plugin-skills/dispatch.ts (makeForwardHandler) run identical
 * runPreflight → manifest-block logic.  This module extracts that
 * sequence into one named helper so there is a single source of truth
 * for the invocation contract.
 *
 * Extracted as part of #3268 (smaller shared-helper extractions).
 *
 * Contract:
 *  - `skillName`  bare skill name (no leading slash, no `<plugin>:` prefix)
 *  - `rawArgs`    effective args string at dispatch time (post-flag-strip
 *                 for plugin skills; original args for builtin skills)
 *  - `source`     SkillInvocation.source for the specific call site
 *  - `ctx`        live SlashContext (provides session id + effective cwd
 *                 + output channel)
 *
 * Returns the manifest block string when the preflight produced one, or
 * `undefined` when no preflight is registered, when it returned null, or
 * when it threw (failure-isolated — a failing preflight must never block
 * a skill from running).
 */

import { runPreflight, getSkillPreflightDir, type SkillInvocation } from '../preflight/index.js';
import { env } from '../../../config/env.js';
import { errorMessage } from '../../../utils/errors.js';
import type { SlashContext } from '../types.js';

/**
 * Invoke the registered preflight for `skillName` and return the manifest
 * block string, or `undefined` when none applies.
 *
 * Capabilities are fixed at `{ compose: true, subagents: true }` — all
 * slash-dispatched skills run inside a full interactive session.
 */
export async function invokeSkillPreflight(
  skillName: string,
  rawArgs: string,
  source: SkillInvocation['source'],
  ctx: SlashContext,
): Promise<string | undefined> {
  const inv: SkillInvocation = {
    skillName,
    rawArgs,
    source,
    capabilities: { compose: true, subagents: true },
  };
  // `sessionId` may be undefined early in bootstrap (AgentSession exposes it
  // post-init).  getSkillPreflightDir accepts undefined and falls back to a
  // random unbound-<hex> token so concurrent REPLs never share a directory
  // and no exploitable identifier leaks via the path. Passing undefined here
  // is intentional — do not coerce to a string.
  const sessionId: string | undefined = ctx.session.current.sessionId;
  const artifactDir = getSkillPreflightDir(sessionId);
  const preflightResult = await runPreflight(
    inv,
    // Honor the session's effective cwd so preflights that shell out to
    // `git status` / file globs operate on the worktree, not the Node
    // host's process.cwd() (the parent repo when launched with
    // `afk i --worktree`).  `stats.cwd` is stamped at bootstrap.ts:328
    // with the same `process.cwd()` fallback.
    { cwd: ctx.stats.cwd ?? process.cwd(), artifactDir },
    (err) => {
      if (env.AFK_SKILL_STREAM_VERBOSE === '1') {
        ctx.out.warn(`preflight(${skillName}) failed: ${errorMessage(err)}`);
      }
    },
  );
  return preflightResult?.manifestBlock;
}
