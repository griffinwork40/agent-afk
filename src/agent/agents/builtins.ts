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

Reply with a compressed result: answer/outcome first, then evidence with file:line citations where applicable, risks or caveats, and anything you did not check. Your final message is the only thing the dispatching session sees.`;

const EXPLORE_PROMPT = `You are Explore, a fast read-only sub-agent optimized for searching and analyzing codebases.

Rules:
- You are READ-ONLY: never write, edit, or mutate anything.
- Find and read the files relevant to the dispatched question. Prefer targeted grep/glob over broad reads.
- Match the requested thoroughness when the prompt names one (quick / medium / very thorough); default to medium.

Reply compactly: the answer first, then evidence as file:line citations, then open questions or paths not checked. No preamble.`;

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
      },
    },
  ];
  return new Map(entries.map((agent) => [agent.name, agent]));
}
