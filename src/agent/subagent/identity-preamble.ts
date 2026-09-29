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

/** The resolved facts the preamble is derived from. */
export interface SubagentIdentityFacts {
  /** Resolved `isNonInteractive`; only `true` asserts that no human is reachable. */
  isNonInteractive: boolean | undefined;
  /** This child's nesting depth (1 = dispatched by the top-level session). */
  depth: number | undefined;
  /** The dispatch cap; a child at `depth >= maxDepth` cannot dispatch further. */
  maxDepth: number | undefined;
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
    lines.push(
      '',
      'No human is reachable from this session. When you need a decision you cannot make yourself,',
      'proceed on the most reasonable assumption, or stop, and put the open question in your reply.',
    );
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

  return lines.join('\n');
}

/**
 * Append the identity block to a forked child's system prompt.
 *
 * Reads the facts from the config it is given, so the caller must pass the
 * config AFTER defaults (`isNonInteractive ?? true`, depth threading) have
 * been applied. Does not mutate the input; returns a shallow copy. When no
 * prompt is set the block becomes the prompt.
 */
export function injectSubagentIdentityPreamble(config: AgentConfig): AgentConfig {
  const block = renderSubagentIdentityPreamble({
    isNonInteractive: config.isNonInteractive,
    depth: config.depth,
    maxDepth: config.maxDepth,
  });
  const sp = config.systemPrompt;

  if (typeof sp === 'string') {
    return sp.length > 0
      ? { ...config, systemPrompt: `${sp}\n\n${block}` }
      : { ...config, systemPrompt: block };
  }

  if (sp && typeof sp === 'object' && 'type' in sp && sp.type === 'preset') {
    const existingAppend = sp.append ?? '';
    return {
      ...config,
      systemPrompt: {
        ...sp,
        append: existingAppend.length > 0 ? `${existingAppend}\n\n${block}` : block,
      },
    };
  }

  return { ...config, systemPrompt: block };
}
