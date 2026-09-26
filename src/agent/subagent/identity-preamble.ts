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
 *   - the nesting line is chosen from `depth` / `maxDepth`: at the cap the
 *     `agent` / `skill` executors refuse any further dispatch
 *     (`depth >= maxDepth`, see `tools/subagent-executor.ts` and
 *     `tools/skill-executor.ts`), below it the child may still delegate.
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
 * @module agent/subagent/identity-preamble
 */

import type { AgentConfig } from '../types/config-types.js';

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

  const { depth, maxDepth } = facts;
  if (isFiniteNumber(depth) && isFiniteNumber(maxDepth) && depth >= maxDepth) {
    lines.push(
      '',
      `You are at the maximum nesting depth (${depth}/${maxDepth}), so you cannot dispatch further`,
      'subagents. Do the work directly.',
    );
  } else {
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
