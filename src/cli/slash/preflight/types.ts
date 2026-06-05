/**
 * SkillPreflight — runtime-owned context gathering for slash-dispatched skills.
 *
 * The dispatcher knows the skill name, args, source, and capabilities the
 * moment the user types `/<skill> ...`. A preflight registered against a
 * skill name gets to do deterministic context-gathering — `gh pr view`,
 * `git status`, reading config — *before* the model loop starts, and emits a
 * compressed manifest block that's prepended to the first user message.
 *
 * The goal: the model's first action should be the actual work, not
 * `find ~/.afk -path '*review*'` self-discovery spelunking.
 *
 * Design constraints:
 * - Preflights are pure-ish — they read state, write stable artifacts, and
 *   return a manifest string. They do NOT mutate the working tree, stash,
 *   commit, or run model calls.
 * - Returning `null` means "no preflight applies, fall through to the
 *   existing 2-block dispatch unchanged." Failure (thrown error) is logged
 *   and treated as null — preflight must never block a skill from running.
 * - Manifest blocks are additive context. The existing breadcrumb +
 *   instruction blocks remain load-bearing and unmodified.
 */

/** What the dispatcher knows about an invocation at slash-parse time. */
export interface SkillInvocation {
  /** Bare skill name, no leading slash, no `<plugin>:` prefix. */
  skillName: string;
  /** Raw remainder string after the command name. */
  rawArgs: string;
  /**
   * Where the skill was resolved from.
   * - `builtin`: vendored TS skill in `src/skills/`
   * - `user`: scanned from `~/.afk/skills/`
   * - `project`: scanned from `<cwd>/.afk/skills/`
   * - `plugin`: discovered via session.supportedCommands() (forward path)
   */
  source: 'builtin' | 'user' | 'project' | 'plugin';
  /** Capabilities the model can rely on. Constant today; here for future flexibility. */
  capabilities: {
    /** `compose` DAG tool available. */
    compose: boolean;
    /** Subagent forking available. */
    subagents: boolean;
  };
}

/** Runtime context handed to a preflight. */
export interface PreflightContext {
  /** Process cwd at slash-dispatch time. */
  cwd: string;
  /**
   * Per-session artifact directory. Preflights write stable files here
   * (e.g. `pr-277.diff`) that the model can reference by absolute path.
   * The dispatcher creates this dir before calling the preflight.
   */
  artifactDir: string;
}

/** What a preflight produces. */
export interface PreflightResult {
  /**
   * Compressed manifest text injected as a new text block *before* the
   * existing breadcrumb + instruction blocks. Should be <=400 tokens
   * (~1600 chars) and structured so the model can parse it without help.
   */
  manifestBlock: string;
  /** Stable artifact paths written by the preflight, for diagnostics. */
  artifacts: Record<string, string>;
}

/**
 * A preflight function. Returns `null` when it doesn't apply (e.g. the
 * args don't match this preflight's expected shape), so the dispatch falls
 * through unchanged.
 */
export type SkillPreflight = (
  inv: SkillInvocation,
  ctx: PreflightContext,
) => Promise<PreflightResult | null>;
