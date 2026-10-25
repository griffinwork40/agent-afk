/**
 * Tell a forked child, in its own system prompt, that it is a subagent.
 *
 * Invariant: every line this module emits must be TRUE for the child that
 * receives it, so each fact is derived from the child's resolved config rather
 * than asserted as static prose. Concretely:
 *   - the audience line is unconditional (every config reaching
 *     `assembleChildConfig` is a fork by construction; see `isSubagentFork`);
 *   - the "no human is reachable" line is emitted only when
 *     `isNonInteractive === true` (the default; a caller may opt a fork back
 *     into elicitation with `isNonInteractive: false`);
 *   - the nesting line has three cases: (a) at the cap (`depth >= maxDepth`,
 *     the agent-tool, skill-fork, and compose/DAG paths all thread depth+1 /
 *     maxDepth so the executor's refuse gate and this line use the same values);
 *     (b) depth known and below the cap — the child may still delegate; (c)
 *     depth unknown (e.g. in-process inline-handler forks that create their
 *     own SubagentManager) — a conservative note that the runtime cap applies
 *     is emitted rather than claiming delegation is definitely available.
 *
 * History: before this module a child learned it was a subagent only by
 * inference (the `depth N/M` tag in `# Environment`, the handoff contract's
 * "dispatching session", tool-result text after a denial). Unnamed children
 * also inherit the coordinator-framed framework prompt ("Parallel by
 * default"), whose single child-directed sentence (system-prompt.md, the
 * "applies to the root coordinator" line) the child had to connect to its own
 * depth tag unaided. This block states the operational facts directly.
 *
 * Applied at ONE site, `assembleChildConfig`, beside the tool-budget preamble,
 * because every fork path (agent tool, compose/DAG, skill forks, in-process
 * callers) converges there. Provider-agnostic; shape handling mirrors
 * `budget-preamble.ts`.
 *
 * Dependencies: imports `resolveMaxNestingDepth` from `../tools/nesting.js` as
 * a pure env-reader fallback (same architectural layer). If this module grows
 * further cross-layer imports, revisit the coupling.
 *
 * @module agent/subagent/identity-preamble
 */

import type { AgentConfig } from '../types/config-types.js';
import { resolveMaxNestingDepth } from '../tools/nesting.js';
import { appendSystemPromptBlock } from './append-system-prompt-block.js';
import { isWorktreeCwd } from '../manifest/worktree.js';

/**
 * Sentence appended to the identity preamble when the child's cwd is inside a
 * linked afk worktree. Exported for tests.
 *
 * Invariant: every clause must be true for a child whose cwd is under
 * `.afk-worktrees/`. The hazard (shared stash) is structural; the alternatives
 * (`git diff`/`git apply`, rescue branch) work in any worktree.
 */
export const WORKTREE_STASH_RULE =
  'Never run `git stash` push/pop/apply/drop/clear (or bare `git stash`) in this worktree: ' +
  'the stash stack (refs/stash) is shared with every other worktree of this repo and a mutating ' +
  'stash operation can silently consume or corrupt stashes from other agents or the main checkout ' +
  '(incident 2026-10-21). To set changes aside: `git diff > <file-in-worktree>` then `git apply <file>`, ' +
  'or commit to a rescue branch (`git switch -c rescue-<name> && git add <paths> && git commit`). ' +
  '`git stash list`, `show`, `create`, `store`, and `branch` are still fine.';

/** The resolved facts the preamble is derived from. */
export interface SubagentIdentityFacts {
  /** Resolved `isNonInteractive`; only `true` asserts that no human is reachable. */
  isNonInteractive: boolean | undefined;
  /** This child's nesting depth (1 = dispatched by the top-level session). */
  depth: number | undefined;
  /** The dispatch cap; a child at `depth >= maxDepth` cannot dispatch further. */
  maxDepth: number | undefined;
  /**
   * The set of `agent_type` values this child may dispatch, if its definition
   * carried a scoped `Agent(x)` grant. Undefined = unrestricted (top-level or
   * bare-`Agent`); empty array = deny-all (`Agent()` grant). When set, the
   * executor enforces this list at every nested dispatch attempt, so the preamble
   * must name the same list (single authoritative source).
   *
   * Invariant: this value MUST be derived from the same resolved field the
   * executor reads (`ctx.nestedAgentAllowlist`, set from
   * `resolvedAccess.nestedAgentTypes` in child-config.ts). Text and enforcement
   * derive from one value.
   */
  nestedAgentAllowlist?: readonly string[];
  /**
   * The child's effective cwd, used to detect whether it is running inside a
   * linked afk worktree (`.afk-worktrees/<slug>/`). When true, the no-stash
   * rule sentence ({@link WORKTREE_STASH_RULE}) is appended to the preamble.
   *
   * Invariant: this must be the CHILD's resolved cwd (after inheritance from
   * the parent), not the parent's cwd, so the sentence is present precisely
   * when the child's bash tool would operate inside the shared-stash-hazard
   * zone. Absent = no sentence emitted (conservative: no false assertions).
   */
  cwd?: string;
  /**
   * When `true`, the child may yield by ending its turn with an **Asking**
   * block — the runtime will detect it, tag the result as `needsInput`, and
   * return a structured header to the parent. Only set for foreground
   * non-compose dispatches. When `false` or absent, the fallback
   * "proceed on the most reasonable assumption" language is used instead.
   */
  yieldEnabled?: boolean;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Render the identity block for a child with the given resolved facts.
 *
 * Contract: pure; the output depends only on `facts`. The audience line is
 * always present. Frames the child's reader as a model that treats the reply
 * as data, which is what the handoff pipeline actually does (the reply is
 * delivered verbatim as a tool_result to the parent).
 */
export function renderSubagentIdentityPreamble(facts: SubagentIdentityFacts): string {
  const lines: string[] = [
    '# Subagent context',
    '',
    'You are a subagent: another agent dispatched you to do a scoped task. Your final reply goes',
    'back to that agent, not to a person, and it decides what reaches the user. Write for that',
    'reader: lead with the result and the evidence it can act on.',
  ];

  if (facts.isNonInteractive === true) {
    if (facts.yieldEnabled === true) {
      lines.push(
        '',
        'No human is reachable from this session. You can ask your parent agent (not a human) by',
        'ending your turn with an **Asking** block in exactly this format:',
        '',
        '**Asking**',
        '- Question: <your question>',
        '- Assumption it resolves: <what answering clarifies>',
        '- Once answered: <what you will do>',
        '',
        'Include a self-contained summary of work done so far above the Asking block, written for a',
        'stranger who may continue from it.',
        '',
        'Ask only for information the parent uniquely holds: the user\'s intent, the original',
        'conversation, or sibling findings. Never ask for something your own tools can answer.',
        '',
        'Asking ends your turn. You may resume with your full history, or a fresh agent may',
        'continue from your summary.',
        '',
        'If you cannot ask (no question worth asking), proceed on the most reasonable assumption,',
        'or stop and put the open question in your reply.',
      );
    } else {
      lines.push(
        '',
        'No human is reachable from this session. When you need a decision you cannot make yourself,',
        'proceed on the most reasonable assumption, or stop, and put the open question in your reply.',
      );
    }
  }

  // Resolve effective maxDepth: use the threaded value when available, fall
  // back to resolveMaxNestingDepth() so the cap is always known even when the
  // caller is an in-process inline handler that did not thread maxDepth.
  const { depth } = facts;
  const effectiveMaxDepth = isFiniteNumber(facts.maxDepth)
    ? facts.maxDepth
    : resolveMaxNestingDepth();

  if (isFiniteNumber(depth) && depth >= effectiveMaxDepth) {
    // Case (a): depth is known and at or beyond the cap — forbid dispatch.
    lines.push(
      '',
      `You are at the maximum nesting depth (${depth}/${effectiveMaxDepth}), so you cannot dispatch further`,
      'subagents. Do the work directly.',
    );
  } else {
    // Case (b): depth is known and below the cap, OR depth is unknown (in-process
    // inline-handler path). In both cases emit conditional-delegation guidance —
    // it is truthful because (b) the child genuinely may delegate, and for the
    // unknown-depth case the runtime cap is enforced at the executor so any
    // over-limit dispatch is refused there rather than misdirected here.
    lines.push(
      '',
      'Guidance about coordinating parallel subagents describes the top-level session. Dispatch',
      'further subagents only when your instructions call for it or your own task genuinely splits',
      'into independent parts.',
    );
  }

  // Worktree stash rule: emitted only when the child's cwd is inside a linked
  // afk worktree. Every line of this preamble must be true for the child that
  // receives it — the stash-hazard is structural and applies precisely when the
  // child is in a worktree, so conditioning on cwd satisfies the module invariant.
  if (facts.cwd !== undefined && isWorktreeCwd(facts.cwd)) {
    lines.push('', WORKTREE_STASH_RULE);
  }

  // Nested-dispatch scope. Emitted only when the allowlist is set (scoped agent),
  // so unscoped children are unchanged. Text is semantically consistent with the
  // executor rejection message (subagent-executor.ts nestedScope gate) so the child
  // sees the preamble instruction and error text as aligned, single-source guidance.
  const { nestedAgentAllowlist } = facts;
  if (nestedAgentAllowlist !== undefined) {
    if (nestedAgentAllowlist.length === 0) {
      lines.push(
        '',
        'Nested dispatch is not permitted for this agent (its definition granted the dispatch',
        'tool but named zero allowed types, e.g. `Agent()`). Complete the task with your own tools.',
      );
    } else {
      lines.push(
        '',
        `When dispatching nested agents, agent_type is required and must be one of: ${nestedAgentAllowlist.join(', ')}.`,
        'Do not delegate your ordinary research to another research-agent or Explore agent unless that exact type appears in this list. Complete it with your own read tools.',
        'A bare dispatch with no agent_type is not permitted here — set agent_type to one of the allowed types, or complete the task with your own tools.',
      );
    }
  }

  return lines.join('\n');
}

/**
 * Append the identity block to a forked child's system prompt.
 *
 * Reads the facts from the config it is given, so the caller must pass the
 * config AFTER defaults (`isNonInteractive ?? true`, depth threading) have
 * been applied. Does not mutate the input; returns a shallow copy. When no
 * prompt is set the block becomes the prompt.
 *
 * @param nestedAgentAllowlist - The allowlist from the CHILD's own executor
 *   context (set from `resolvedAccess.nestedAgentTypes` in child-config.ts).
 *   When provided, the rendered block names the allowed types so the child
 *   never needs to guess. Mirrors the executor's enforcement gate exactly.
 */
export function injectSubagentIdentityPreamble(
  config: AgentConfig,
  nestedAgentAllowlist?: readonly string[],
  yieldEnabled?: boolean,
): AgentConfig {
  const block = renderSubagentIdentityPreamble({
    isNonInteractive: config.isNonInteractive,
    depth: config.depth,
    maxDepth: config.maxDepth,
    nestedAgentAllowlist,
    cwd: config.cwd,
    yieldEnabled,
  });
  return appendSystemPromptBlock(config, block);
}
