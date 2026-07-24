/**
 * Built-in named agents.
 *
 * Registered programmatically (no filesystem scan) at the BOTTOM of the
 * precedence order, so a user or project file with the same name shadows
 * them. Two sources:
 *
 * 1. Vendored plugin agents (`research-agent`, `git-investigator`) from
 *    `src/skills/_agents/` — byte-pinned to upstream by `vendored.test.ts`.
 *    Wrapped here, never edited. These make the bundled orchestration
 *    SKILL.mds (review, shadow-verify, devils-advocate, research, ship,
 *    refactor) resolve their `subagent_type: "research-agent"` dispatches.
 * 2. Claude Code compatibility types (`general-purpose`, `Explore`) with
 *    AFK-authored prompts, so prompts ported from Claude Code — and the
 *    bundled research skill's documented `Explore` fallback — resolve too.
 *
 * @module agent/agents/builtins
 */

import { researchAgent } from '../../skills/_agents/research-agent.js';
import { gitInvestigator } from '../../skills/_agents/git-investigator.js';
import { SUBAGENT_HANDOFF_CONTRACT } from '../subagent-contract.js';
import { parseAgentMarkdown } from './parser.js';
import type { RegisteredAgent } from './types.js';

/**
 * A vendored agent module's `systemPrompt` is the RAW upstream markdown —
 * frontmatter included (byte-equality with upstream is enforced, so the
 * wrapper cannot pre-strip it). A system prompt should be the body only:
 * parse and take the body, falling back to the raw text if the vendored
 * format ever changes shape. Tools/description stay sourced from the
 * wrapper constants (the vendored contract diagnose already relies on),
 * NOT from the file's frontmatter.
 */
function vendoredPromptBody(raw: string): string {
  return parseAgentMarkdown(raw)?.definition.prompt ?? raw;
}

const GENERAL_PURPOSE_PROMPT = `You are a general-purpose sub-agent for complex, multi-step tasks that require both exploration and action.

Work autonomously from the task prompt you were dispatched with: investigate, act, and verify. You have the parent session's full child tool surface. Keep intermediate exploration out of your reply.

Watch for non-convergence: if repeated attempts at the same sub-goal — the same fix, the same search, the same command — stop making progress after a few tries, STOP and do not keep retrying. Activity is not progress. Return your best PARTIAL result with a clear note on what you could not resolve and why.

${SUBAGENT_HANDOFF_CONTRACT}`;

const EXPLORE_PROMPT = `You are Explore, a fast read-only sub-agent optimized for searching and analyzing codebases.

Rules:
- You are READ-ONLY: never write, edit, or mutate anything.
- Find and read the files relevant to the dispatched question. Prefer targeted grep/glob over broad reads.
- Match the requested thoroughness when the prompt names one (quick / medium / very thorough); default to medium.

Reply compactly: the answer first, then evidence as file:line citations, then open questions or paths not checked. No preamble.`;

/**
 * Anti-runaway tool-use-round bound for the read-only research/review builtins.
 *
 * The `agent`-tool dispatch path is unlimited-by-default: `child-config.ts`
 * resolves a named dispatch's `maxToolUseIterations` to 0 (no cap) when neither
 * the call-site nor the definition sets one, deliberately bypassing
 * SubagentManager's `SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS` (50) — which only
 * guards internal skill/compose forks. A READ-ONLY research/review agent
 * never legitimately needs many rounds; without a bound it can loop on a hard
 * task until an external cutoff aborts it mid-loop, surfacing as an opaque
 * failure. Bounding it routes a runaway through the graceful capped-partial
 * wind-down instead. Value mirrors `SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS`;
 * duplicated (not imported) to keep `agents/` off the `subagent.ts` module
 * graph — same rationale as the KNOWN_AFK_TOOL_NAMES dup in resolve.ts.
 */
const READONLY_AGENT_MAX_TOOL_USE_ITERATIONS = 50;

/**
 * Anti-runaway ceiling for the inherit-all worker (`general-purpose`).
 *
 * general-purpose does exploration AND action across many dependent steps, so
 * it legitimately needs more rounds than a read-only leaf — it was previously
 * left UNCAPPED on the (uncapped-by-default) agent-tool dispatch path. But
 * "uncapped" means a busy, non-converging worker (one that keeps tool-calling
 * without making progress) has no bound short of the 45-min wall-clock and
 * dies opaquely there. This generous ceiling (3× the read-only cap) bounds
 * such a runaway through the SAME graceful capped-partial wind-down, while
 * staying well above any legitimate multi-step dispatch's round count so real
 * work is never cut off. A caller with a genuinely longer task opts out
 * per-dispatch via an explicit `max_tool_use_iterations` (including `0` =
 * uncapped) — see `child-config.ts`. The cap is PER-TURN, so a single-shot
 * fork gets one budget for its whole task, which is why it is deliberately
 * generous rather than matching the read-only 50.
 */
const GENERAL_PURPOSE_MAX_TOOL_USE_ITERATIONS = 150;

/**
 * Build the built-in agents, keyed by name.
 *
 * A fresh map per call — callers merge it into a mutable registry under
 * construction; sharing one module-level map would let one session's
 * shadowing leak into the next in long-lived processes (tests, telegram).
 */
export function builtinAgents(): Map<string, RegisteredAgent> {
  const entries: RegisteredAgent[] = [
    {
      name: researchAgent.name,
      source: 'builtin',
      definition: {
        description: researchAgent.description,
        prompt: vendoredPromptBody(researchAgent.systemPrompt),
        // The scoped `Agent(git-investigator)` grant matches the vendored
        // prompt's frontmatter intent (`tools: …, Agent(git-investigator)`)
        // and lets research-agent nest a git-investigator when a finding needs
        // git archaeology — the capability the prompt already instructs it to
        // use. Added HERE (registry entry) rather than in the shared
        // `researchAgent.allowedTools` const, because that const is also the
        // read-only leaf surface diagnose (RESEARCH_READONLY_TOOLS) and
        // audit-fit (inspectorTools) build their gates from — they must NOT
        // gain a dispatch tool. resolve.ts captures the paren scope as
        // `nestedAgentTypes`, and the subagent executor mechanically restricts
        // research-agent to dispatching ONLY git-investigator (no bare/other
        // dispatch), so the read-only contract can't be escalated.
        tools: [...researchAgent.allowedTools, 'Agent(git-investigator)'],
        // Anti-runaway bound (see READONLY_AGENT_MAX_TOOL_USE_ITERATIONS): a
        // read-only research/review agent that keeps tool-calling without ever
        // emitting a final message otherwise runs unbounded on the (uncapped)
        // agent-tool dispatch path and dies opaquely when cut off mid-loop.
        maxToolUseIterations: READONLY_AGENT_MAX_TOOL_USE_ITERATIONS,
      },
    },
    {
      name: gitInvestigator.name,
      source: 'builtin',
      definition: {
        description: gitInvestigator.description,
        prompt: vendoredPromptBody(gitInvestigator.systemPrompt),
        tools: [...gitInvestigator.allowedTools],
        model: gitInvestigator.model,
        // Same anti-runaway bound as research-agent / Explore: git-investigator
        // is a read-only git-archaeology leaf (dispatched by research-agent),
        // so it never needs an unbounded tool-use loop. Without a cap it can
        // spin on a hard task until an external wall-clock cutoff kills it
        // mid-loop and it surfaces as an opaque failure rather than a graceful
        // capped-partial wind-down. See READONLY_AGENT_MAX_TOOL_USE_ITERATIONS.
        maxToolUseIterations: READONLY_AGENT_MAX_TOOL_USE_ITERATIONS,
      },
      // The vendored definition grants Bash for git archaeology; its contract
      // is read-only ("Runs git commands only — no mutations"). Enforce that
      // contract mechanically with the read-only bash gate.
      bashReadOnly: true,
    },
    {
      name: 'general-purpose',
      source: 'builtin',
      definition: {
        description:
          'Capable agent for complex, multi-step tasks that require both exploration and action. ' +
          'Inherits the full child tool surface. Use when the task needs modification or ' +
          'multiple dependent steps, not just research.',
        prompt: GENERAL_PURPOSE_PROMPT,
        // No `tools` — inherit-all (Claude Code parity for general-purpose).
        // Generous anti-runaway ceiling (see GENERAL_PURPOSE_MAX_TOOL_USE_ITERATIONS):
        // bounds a busy, non-converging worker to a graceful capped-partial
        // wind-down instead of the 45-min wall-clock, without cutting legit
        // multi-step work. Opt out per-dispatch with an explicit
        // max_tool_use_iterations (`0` = uncapped).
        maxToolUseIterations: GENERAL_PURPOSE_MAX_TOOL_USE_ITERATIONS,
      },
    },
    {
      name: 'Explore',
      source: 'builtin',
      definition: {
        description:
          'Fast, read-only agent for searching and analyzing codebases: file discovery, code ' +
          'search, tracing usages. Cannot write, edit, or run shell commands. Claude Code ' +
          'compatibility type — accepts a thoroughness hint (quick/medium/very thorough) in the prompt.',
        prompt: EXPLORE_PROMPT,
        tools: ['Read', 'Grep', 'Glob', 'list_directory'],
        model: 'haiku',
        // Same anti-runaway bound as research-agent: Explore is a read-only
        // search leaf, so it never needs an unbounded tool-use loop.
        maxToolUseIterations: READONLY_AGENT_MAX_TOOL_USE_ITERATIONS,
      },
    },
  ];
  return new Map(entries.map((agent) => [agent.name, agent]));
}
