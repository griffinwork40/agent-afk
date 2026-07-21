/**
 * Agent tool input parsing.
 *
 * Extracted from `subagent-executor.ts` `execute()`: the `AgentInput` shape and
 * the `parseAgentInput` validator. Pure — no dependency on the executor
 * instance or its context.
 *
 * @module agent/tools/subagent/input-parse
 */

import { isAbsolute, parse as parsePath, resolve as resolvePath, relative as relativePath } from 'node:path';
import { homedir } from 'node:os';
import { isReadDenied } from '../handlers/read-denylist.js';

export type AgentExecutionMode = 'foreground' | 'background';

export interface AgentInput {
  prompt: string;
  model?: string;
  /** Conversation-turn cap. `0` (the default) means unlimited — no ceiling. */
  max_turns?: number;
  /**
   * True when the caller supplied `max_turns` explicitly. Distinguishes the
   * parse-time default (0 = unlimited) from a deliberate value so a named
   * agent's `maxTurns` frontmatter can act as the default without being able
   * to override an explicit per-call budget.
   */
  max_turns_explicit: boolean;
  /**
   * Tool-use-round cap within the child's single turn (anti-hang ceiling).
   * `0` (the default) means unlimited on this dispatch path. A positive value
   * caps rounds; honored uniformly by both providers (see
   * shared/tool-loop-cap.ts).
   */
  max_tool_use_iterations?: number;
  /** True when the caller supplied `max_tool_use_iterations` explicitly. */
  max_tool_use_iterations_explicit: boolean;
  id_prefix?: string;
  /**
   * Named agent type to dispatch (`agent_type`, alias `subagent_type`).
   * Resolved against {@link SubagentExecutorContext.agentRegistry}.
   */
  agent_type?: string;
  /** Execution mode. Defaults to 'foreground' (existing await-and-return semantic). */
  mode: AgentExecutionMode;
  /**
   * Optional working directory the subagent runs in. When omitted, the child
   * inherits the parent's cwd (`SubagentManager.parentCwd`) so `afk -w`
   * worktree isolation extends transparently. When provided, must be an
   * absolute path with no `..` segments — the executor threads it into
   * `AgentConfig.cwd`, which `SubagentManager.forkSubagent` applies in
   * preference to the parent fallback (see `src/agent/subagent.ts:291-297`).
   *
   * Validation is format-only at parse time (existence/git-worktree status
   * is not checked) — a non-existent path surfaces as an ENOENT on the
   * child's first cwd-relative tool call, which the parent sees as a
   * structured failure. Mirrors the existing AgentConfig.cwd contract
   * used by `afk interactive -w` and the diagnose/farm orchestrators.
   *
   * Caveat: this field affects only the dispatched child's cwd. Depth-2+
   * forks (the child itself calling `agent`) inherit through
   * `SubagentExecutorContext.cwd` set at orchestrator construction —
   * passing `cwd` here does NOT auto-propagate to recursive subagents.
   * Each level must specify `cwd` explicitly to operate in a worktree.
   */
  cwd?: string;
  /**
   * Optional extra write roots to pre-grant to the forked child (#435). By
   * default a fork's writes are confined to its cwd/worktree; the path-approval
   * hook auto-denies any write outside it and a fork cannot elicit. Passing
   * writeRoots here lets the PARENT deliberately grant additional write roots.
   * Composed WITH the child's cwd (never replaces it), so the child keeps write
   * access to its own tree. Each entry must be an absolute path with no `..`
   * segments. Mutually exclusive with `isolation:'worktree'` (isolation's
   * contract is total confinement). Unlike the #416 read grant this is never
   * automatic — writing outside the worktree breaks isolation, so it requires
   * explicit parent intent.
   */
  writeRoots?: string[];
  /**
   * Optional extra READ roots to pre-grant to the forked child (#662). Mirrors
   * {@link writeRoots} but on the read axis: lets the PARENT grant the fork read
   * access to absolute paths OUTSIDE the repo/worktree it is confined to (e.g.
   * `~/Downloads`, a scratch data dir). ADDITIVE — composed WITH (never replaces)
   * the child's normally-inherited read scope in `forkSubagent`, so the child
   * keeps its repo/worktree/state reach AND gains the named dirs. Writes stay
   * confined. Grandchildren must be re-granted (not inherited).
   *
   * Per-entry rules (parse-time): non-empty absolute path, no `..` segment. PLUS
   * two hardening rejections: (a) breadth — a filesystem root, the home dir, or
   * an ancestor of the home dir is refused (the model must not over-grant a broad
   * root); (b) denylist — an entry that resolves into the credential floor
   * (`isReadDenied`: ~/.ssh, ~/.afk/config, …) is refused, so a grant can never
   * even attempt to shadow secrets. This is defense-in-depth ON TOP of the
   * read-time floor in `resolveAndContain` / the path-approval hook.
   *
   * Deliberately NOT mutually exclusive with `isolation:'worktree'` — widening a
   * confined worktree fork's READS is legitimate (only WRITES break isolation).
   */
  readRoots?: string[];
  /**
   * Filesystem-isolation mode. When `'worktree'`, the executor forks the child
   * inside a fresh afk-managed git worktree (`.afk-worktrees/<slug>` on a new
   * branch) and sets the child's cwd to it, so parallel write-capable
   * subagents never collide in the shared tree. Omitted / `'none'` runs the
   * child in the parent tree (or `cwd`).
   *
   * Mutually exclusive with {@link cwd} (the executor owns the child's cwd when
   * isolating). Forbidden with `mode: 'background'` in this release: a detached
   * child outlives the executor's teardown, so nothing would reclaim its
   * worktree in-turn (see docs/proposals/first-class-worktree-isolation.md
   * Open Question 1). Only the honored value is retained — `'none'` normalizes
   * to `undefined` (no field) so the executor's `=== 'worktree'` check is total.
   */
  isolation?: 'worktree';
}

/**
 * Validate and parse Agent tool input.
 * @throws if input is invalid
 */
export function parseAgentInput(input: unknown): AgentInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Agent tool input must be an object');
  }

  const agentInput = input as Record<string, unknown>;

  const prompt = agentInput['prompt'];
  if (typeof prompt !== 'string') {
    throw new Error('Agent tool input must have a "prompt" field of type string');
  }
  if (prompt.trim().length === 0) {
    throw new Error('Agent tool prompt cannot be empty');
  }

  let model: string | undefined;
  const modelValue = agentInput['model'];
  if (modelValue !== undefined) {
    if (typeof modelValue !== 'string') {
      throw new Error('Agent tool model must be a string');
    }
    model = modelValue;
  }

  // Turn budget: default 0 = unlimited (matches AgentSession's falsy-maxTurns
  // = no-cap check in assertCanSend). A positive value caps conversation
  // turns; 0/negatives mean unlimited. No upper ceiling — the caller, or a
  // named agent's `maxTurns` frontmatter, owns any cap it wants.
  let max_turns = 0;
  let max_turns_explicit = false;
  const maxTurnsValue = agentInput['max_turns'];
  if (maxTurnsValue !== undefined) {
    if (typeof maxTurnsValue !== 'number') {
      throw new Error('Agent tool max_turns must be a number');
    }
    max_turns = Math.max(0, Math.floor(maxTurnsValue));
    max_turns_explicit = true;
  }

  // Tool-use-round budget within the single child turn (anti-hang ceiling).
  // Default 0 = unlimited on the agent-tool path; a positive value caps
  // rounds. Honored uniformly by both providers (see config-types.ts
  // maxToolUseIterations and providers/shared/tool-loop-cap.ts).
  let max_tool_use_iterations = 0;
  let max_tool_use_iterations_explicit = false;
  const maxToolIterValue = agentInput['max_tool_use_iterations'];
  if (maxToolIterValue !== undefined) {
    if (typeof maxToolIterValue !== 'number') {
      throw new Error('Agent tool max_tool_use_iterations must be a number');
    }
    max_tool_use_iterations = Math.max(0, Math.floor(maxToolIterValue));
    max_tool_use_iterations_explicit = true;
  }

  // agent_type: canonical param; `subagent_type` accepted as an alias for
  // Claude Code-ported prompts (bundled SKILL.mds already write it). When
  // both are present the canonical name wins.
  let agent_type: string | undefined;
  const agentTypeValue = agentInput['agent_type'] ?? agentInput['subagent_type'];
  if (agentTypeValue !== undefined) {
    if (typeof agentTypeValue !== 'string') {
      throw new Error('Agent tool agent_type must be a string');
    }
    const trimmed = agentTypeValue.trim();
    if (trimmed.length > 0) agent_type = trimmed;
  }

  let id_prefix = 'agent-tool';
  const idPrefixValue = agentInput['id_prefix'];
  if (idPrefixValue !== undefined) {
    if (typeof idPrefixValue !== 'string') {
      throw new Error('Agent tool id_prefix must be a string');
    }
    id_prefix = idPrefixValue;
  }

  // mode: default 'foreground'. Unknown strings reject loudly rather than
  // silently coercing — a typo like "back" would be silently downgraded
  // to a foreground run, exactly the surprise this feature is built to
  // avoid.
  let mode: AgentExecutionMode = 'foreground';
  const modeValue = agentInput['mode'];
  if (modeValue !== undefined) {
    if (modeValue !== 'foreground' && modeValue !== 'background') {
      throw new Error(
        `Agent tool mode must be "foreground" or "background", got: ${JSON.stringify(modeValue)}`,
      );
    }
    mode = modeValue;
  }

  // cwd: optional absolute path. Format-only validation here — existence is
  // not checked because the call site is sync and any ENOENT surfaces
  // cleanly through the child's first tool call. Rules:
  //   1. Must be a non-empty string when present.
  //   2. Must be absolute (`path.isAbsolute`) — relative paths would otherwise
  //      resolve against `process.cwd()` and silently land somewhere
  //      unrelated to the caller's intent.
  //   3. Must not contain `..` as a path segment. `path.resolve` would
  //      silently collapse them; rejecting forces the caller to write
  //      what they mean. Splits on both `/` and `\\` so the check holds
  //      on Windows too.
  let cwd: string | undefined;
  const cwdValue = agentInput['cwd'];
  if (cwdValue !== undefined) {
    if (typeof cwdValue !== 'string') {
      throw new Error(
        `Agent tool cwd must be a string, got: ${JSON.stringify(cwdValue)}`,
      );
    }
    if (cwdValue.length === 0) {
      throw new Error('Agent tool cwd must be a non-empty string');
    }
    if (!isAbsolute(cwdValue)) {
      throw new Error(
        `Agent tool cwd must be an absolute path, got: ${JSON.stringify(cwdValue)}`,
      );
    }
    const segments = cwdValue.split(/[/\\]/);
    if (segments.includes('..')) {
      throw new Error(
        `Agent tool cwd must not contain '..' segments, got: ${JSON.stringify(cwdValue)}`,
      );
    }
    cwd = cwdValue;
  }

  // writeRoots: optional array of absolute paths pre-granted as extra write
  // roots to the fork (#435). Same per-entry rules as cwd (non-empty, absolute,
  // no '..' segments). An empty array normalizes to undefined (no-op grant).
  let writeRoots: string[] | undefined;
  const writeRootsValue = agentInput['writeRoots'];
  if (writeRootsValue !== undefined) {
    if (!Array.isArray(writeRootsValue)) {
      throw new Error(
        `Agent tool writeRoots must be an array of absolute paths, got: ${JSON.stringify(writeRootsValue)}`,
      );
    }
    const roots: string[] = [];
    for (const entry of writeRootsValue) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new Error(
          `Agent tool writeRoots entries must be non-empty strings, got: ${JSON.stringify(entry)}`,
        );
      }
      if (!isAbsolute(entry)) {
        throw new Error(
          `Agent tool writeRoots entries must be absolute paths, got: ${JSON.stringify(entry)}`,
        );
      }
      if (entry.split(/[/\\]/).includes('..')) {
        throw new Error(
          `Agent tool writeRoots entries must not contain '..' segments, got: ${JSON.stringify(entry)}`,
        );
      }
      roots.push(entry);
    }
    if (roots.length > 0) writeRoots = roots;
  }

  // readRoots: optional array of absolute paths pre-granted as extra READ roots
  // to the fork (#662). Same per-entry format rules as writeRoots (non-empty,
  // absolute, no '..' segments), PLUS two hardening rejections so the model
  // cannot over-grant or shadow the credential floor:
  //   (a) BREADTH — reject a filesystem root, os.homedir(), or an ANCESTOR of
  //       homedir (homedir inside the entry). Blocks `/`, `~`, `/Users`, `/home`.
  //   (b) DENYLIST — reject any entry that resolves into the read-denylist
  //       (isReadDenied: ~/.ssh, ~/.afk/config, …). isReadDenied is a pure,
  //       string/realpath-based, non-throwing check (safeRealpath swallows fs
  //       errors), so it is safe to call at parse time. Defense-in-depth ON TOP
  //       of the read-time floor in resolveAndContain / the path-approval hook.
  // An empty array normalizes to undefined (no-op grant). Deliberately NOT
  // mutually exclusive with isolation:'worktree' (that constraint is write-only).
  let readRoots: string[] | undefined;
  const readRootsValue = agentInput['readRoots'];
  if (readRootsValue !== undefined) {
    if (!Array.isArray(readRootsValue)) {
      throw new Error(
        `Agent tool readRoots must be an array of absolute paths, got: ${JSON.stringify(readRootsValue)}`,
      );
    }
    const home = homedir();
    const roots: string[] = [];
    for (const entry of readRootsValue) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new Error(
          `Agent tool readRoots entries must be non-empty strings, got: ${JSON.stringify(entry)}`,
        );
      }
      if (!isAbsolute(entry)) {
        throw new Error(
          `Agent tool readRoots entries must be absolute paths, got: ${JSON.stringify(entry)}`,
        );
      }
      if (entry.split(/[/\\]/).includes('..')) {
        throw new Error(
          `Agent tool readRoots entries must not contain '..' segments, got: ${JSON.stringify(entry)}`,
        );
      }
      // (a) Breadth rejection. Resolve once so `~`-shaped inputs and trailing
      // separators normalize before the comparisons. A filesystem root, the
      // home dir itself, or any ANCESTOR of the home dir (homedir lexically
      // inside the entry → `relative(entry, home)` neither escapes nor is
      // absolute) is too broad to pre-grant.
      const resolved = resolvePath(entry);
      const rel = relativePath(resolved, home);
      const homeInsideEntry = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      if (resolved === parsePath(resolved).root || homeInsideEntry) {
        throw new Error(
          `Agent tool readRoots entries must not be a filesystem root, your home directory, ` +
            `or an ancestor of it — grant a specific subdirectory instead, got: ${JSON.stringify(entry)}`,
        );
      }
      // (b) Denylist rejection — never let a grant target the credential floor.
      const denied = isReadDenied(resolved);
      if (denied.denied) {
        throw new Error(
          `Agent tool readRoots entries must not target a protected/credential path ` +
            `(matches read-denylist entry: ${denied.matched}), got: ${JSON.stringify(entry)}`,
        );
      }
      roots.push(entry);
    }
    if (roots.length > 0) readRoots = roots;
  }

  // isolation: optional enum. 'none' (or omitted) is a no-op and normalizes to
  // undefined so the executor's `=== 'worktree'` check is total. 'worktree'
  // asks the executor to fork the child inside a fresh managed git worktree.
  //   - Mutually exclusive with cwd: isolating means the executor owns the
  //     child's cwd, so a caller-supplied cwd would be silently overwritten —
  //     reject loudly instead.
  //   - Forbidden with mode:'background': a detached child outlives the
  //     foreground teardown that removes the worktree, so nothing would reclaim
  //     it in-turn (proposal Open Q1). Reject rather than leak.
  let isolation: 'worktree' | undefined;
  const isolationValue = agentInput['isolation'];
  if (isolationValue !== undefined && isolationValue !== 'none') {
    if (isolationValue !== 'worktree') {
      throw new Error(
        `Agent tool isolation must be "none" or "worktree", got: ${JSON.stringify(isolationValue)}`,
      );
    }
    if (cwd !== undefined) {
      throw new Error(
        'Agent tool cwd and isolation are mutually exclusive — pass one or the other',
      );
    }
    if (writeRoots !== undefined) {
      throw new Error(
        'Agent tool writeRoots and isolation are mutually exclusive — a worktree-isolated child is fully confined by design',
      );
    }
    if (mode === 'background') {
      throw new Error(
        'Agent tool isolation:"worktree" is not supported with mode:"background" yet',
      );
    }
    isolation = 'worktree';
  }

  return {
    prompt,
    model,
    max_turns,
    max_turns_explicit,
    max_tool_use_iterations,
    max_tool_use_iterations_explicit,
    id_prefix,
    mode,
    ...(agent_type !== undefined ? { agent_type } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(writeRoots !== undefined ? { writeRoots } : {}),
    ...(readRoots !== undefined ? { readRoots } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
  };
}
