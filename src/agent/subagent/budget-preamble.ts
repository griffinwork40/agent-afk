/**
 * Disclose a forked child's tool-round budget to the child itself.
 *
 * Invariant: the cap meter is tool-use ROUNDS, not tool CALLS. A round is one
 * assistant turn that requests tools, so a turn issuing five parallel calls
 * costs 1 round, not 5 (`providers/anthropic-direct/loop/tool-round.ts` and
 * `providers/openai-compatible/query.ts` both increment once per round, after
 * dispatching the whole batch). A child that batches independent calls
 * therefore buys ~10x the evidence per unit budget compared with one that
 * calls tools one at a time.
 *
 * This module is deliberately provider-agnostic and is applied at ONE site —
 * `SubagentManager.forkSubagent`, the sole path to a child `AgentSession`.
 *
 * Shape handling mirrors `companion/primer-loader.ts:injectCompanionPrimer` —
 * same union, same shallow-copy discipline, same "no prompt set → the block
 * becomes the prompt" fallback.
 *
 * History: why the child was never told about the budget before this module
 * existed, the measured cost of that gap, and why injection happens at this
 * specific provider-neutral fork site (incl. the openai-compatible wind-down
 * drift precedent that motivated it) live in docs/subagent-tool-budget.md.
 *
 * @module agent/subagent/budget-preamble
 */

import type { AgentConfig } from '../types/config-types.js';
import { appendSystemPromptBlock } from './append-system-prompt-block.js';

/**
 * Render the budget preamble for a given round cap.
 *
 * Contract: the text frames `maxRounds` as a CEILING to finish well under, not
 * an allowance to spend. That framing is load-bearing — disclosing a budget
 * without it risks the opposite failure ("I have 50 rounds, let me use them"),
 * and a wide-scope task will exhaust any budget it is told about. The
 * convergence sentence is the cheapest available substitute for the
 * non-convergence detector the runtime still lacks: nothing today terminates a
 * child whose queries keep varying while its conclusion stops changing.
 *
 * The code-quality caveat ("internally consistent checkpoint") distinguishes
 * partial research results (acceptable — summarize what you have) from
 * knowingly broken code (never acceptable — a partial code result should
 * compile and be coherent with the surrounding system).
 */
export function renderBudgetPreamble(maxRounds: number): string {
  return [
    '# Tool budget',
    '',
    `You have ${maxRounds} tool-use rounds for this turn. A round is one reply that requests tools:`,
    'issuing five tool calls in a SINGLE reply costs 1 round, not 5. Batch independent reads,',
    'greps, and commands into one reply instead of calling them one at a time — it is the',
    `difference between roughly ${maxRounds} and roughly ${maxRounds * 10} tool calls on the same budget.`,
    '',
    `${maxRounds} is a hard ceiling, not a target. Aim to finish well under it. When the budget is`,
    'spent you get one final reply with tools removed and must answer from what you already',
    'gathered, so a partial answer delivered early beats a complete one you never get to give.',
    'Persist requested artifacts early, then update them as you go. Near the cap, stop adding scope.',
    'Your final reply IS the deliverable: findings, evidence, and remaining work, never future actions.',
    'If new evidence has stopped changing your conclusion, stop gathering and answer now.',
    'When writing code, a partial result should be an internally consistent checkpoint --',
    'not knowingly broken, unverified, or incoherent code returned merely to finish early.',
  ].join('\n');
}

/**
 * Render the limits note injected into uncapped (unbounded) children.
 *
 * Unnamed `agent` dispatches with no explicit `max_tool_use_iterations` resolve
 * to 0 (unlimited rounds). `injectToolBudgetPreamble` previously returned early
 * in that case, so those children received NO mention of the wall-clock abort,
 * soft deadline, or idle watchdog — constraints that apply regardless of whether
 * a round cap is set. This note fills that gap without falsely claiming a cap.
 *
 * The convergence sentence is kept because an uncapped child is at least as
 * prone to spinning as a capped one. The batching example is omitted because
 * there is no finite ceiling to frame it against.
 */
export function renderUnboundedLimitsNote(): string {
  return [
    '# Tool budget',
    '',
    'There is no fixed round cap for this turn, but you are still bound by',
    'wall-clock, soft-deadline, and idle-watchdog limits. Batch independent',
    'reads, greps, and commands into one reply instead of calling them one at a',
    'time — issuing five tool calls in a SINGLE reply costs 1 round, not 5.',
    '',
    'Your final reply IS the deliverable: findings, evidence, and remaining work, never future actions.',
    'If new evidence has stopped changing your conclusion, stop gathering and answer now.',
    'When writing code, a partial result should be an internally consistent checkpoint --',
    'not knowingly broken, unverified, or incoherent code returned merely to finish early.',
  ].join('\n');
}

/**
 * Append the tool-budget preamble to a forked child's system prompt.
 *
 * History: previously a no-op for unbounded children (maxRounds ≤ 0), which
 * meant unnamed dispatches received no mention of wall-clock, soft-deadline, or
 * idle-watchdog limits — constraints that apply regardless of the round cap.
 * Now emits `renderUnboundedLimitsNote` for those children so every forked
 * child is told its runtime constraints (#5313 item 1).
 *
 * Appends AFTER any existing prompt so the child's actual instructions keep
 * top salience. Provider assembly places this at position 2 of 6; memory
 * instructions, hot memory, the environment fragment, and the skill manifest
 * follow after it in what the model receives.
 *
 * Does not mutate the input — returns a shallow copy.
 */
export function injectToolBudgetPreamble(config: AgentConfig): AgentConfig {
  const maxRounds = config.maxToolUseIterations;
  if (typeof maxRounds === 'number' && Number.isFinite(maxRounds) && maxRounds > 0) {
    const block = renderBudgetPreamble(Math.floor(maxRounds));
    return appendSystemPromptBlock(config, block);
  }

  // Unbounded child (0, undefined, or non-finite): no round cap to disclose,
  // but wall-clock and idle limits still apply. Emit the limits note so the
  // child is not silently unaware of the constraints it runs under.
  const block = renderUnboundedLimitsNote();
  return appendSystemPromptBlock(config, block);
}
