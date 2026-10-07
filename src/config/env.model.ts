/**
 * Core model / agent-runtime env vars: compaction, limits, scheduling, and
 * per-session behaviour toggles. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.model
 */

import type { EnvVarMeta } from './env.js';

export const MODEL_ENV_REGISTRY = [
  {
    name: 'AFK_CONNECT_RETRY_BUDGET_MS',
    description: 'Experimental streaming connection retry wall budget in milliseconds. Positive finite value enables capped jittered backoff before the stream opens; unset or invalid preserves legacy retry counts. In-flight attempts retain existing timeouts.',
    type: 'number',
    required: false,
    example: '120000',
    category: 'model',
  },
  {
    name: 'AFK_CONTEXT_GUARD_PCT',
    description: 'Temporary within-turn context guard operational threshold as percent of the effective provider-route limit (catalog metadata for subscription routes; contextLimitFor() for API-key routes). Default 95. Not a documented model capacity or guaranteed server cutoff. Valid range 1–99.',
    type: 'number', required: false, default: '95', example: '90', category: 'model',
  },
  {
    name: 'AFK_CONTEXT_GUARD_DISABLE',
    description: 'Disable the temporary within-turn context pressure guard (1/true/yes/on). Restores unguarded tool-loop behavior; ordinary compaction and round caps remain enabled.',
    type: 'boolean', required: false, default: '0', example: '1', category: 'model',
  },
  {
    name: 'AFK_COMPACT_KEEP_LAST_TURNS',
    description: 'Number of recent turns the compactor keeps verbatim during /compact. Default tuned in compact-handler.ts.',
    type: 'number',
    required: false,
    example: '6',
    category: 'model',
  },
  {
    name: 'AFK_COMPACT_MODEL',
    description: 'Model id or slot alias used by the /compact summarizer and auto-compaction. Accepts any model on any supported provider (anthropic, openai, xai). Cross-provider compaction is supported: set to a gpt-* id on a Claude session (or a claude-* id on an OpenAI session) and AFK will route the summarize call to that provider using its own credentials. The transcript is sent to the target provider — a one-time privacy warning is emitted on first cross-provider use. Requires that provider\'s credentials to be available (ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY, or ChatGPT-subscription OAuth via AFK_OPENAI_CHATGPT_OAUTH). Falls back to a cheap haiku-class default when unset. Also drives ghost-text suggestions on Claude sessions (see AFK_SUGGEST_MODEL to override that independently).',
    type: 'string',
    required: false,
    example: 'gpt-6-luna',
    category: 'model',
  },
  {
    name: 'AFK_COMPACT_SHRINK_FRACTION',
    description: 'Context-fullness fraction (0–1, exclusive) at/above which /compact and auto-compaction relax the keep-window so a short-but-full session (few turns, huge tool exchanges) can still be summarized instead of no-oping on turn count. Default 0.7 (see shared/compaction.ts DEFAULT_COMPACT_SHRINK_THRESHOLD).',
    type: 'number',
    required: false,
    example: '0.8',
    category: 'model',
  },
  {
    name: 'AFK_DEFAULT_SUBAGENT_MODEL',
    description: 'Override the default model used when a subagent is dispatched without an explicit model.',
    type: 'string',
    required: false,
    example: 'sonnet',
    category: 'model',
  },
  {
    name: 'AFK_DISABLE_PROMPT_CACHE',
    description: 'Disable Anthropic prompt caching when set to 1/true/yes/on. Unset = caching enabled.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_DISABLE_BASH_INTERPRETER_GUARD',
    description:
      'Skip ONLY the bash interpreter-eval denylist (python -c, node -e, sh -c, ...) when set to 1, ' +
      'leaving the rest of path-approval intact. Applies on interactive surfaces (REPL/Telegram), ' +
      'where the denylist is active but your workflow legitimately runs interpreter one-liners. ' +
      'The restricted-root substring check is unaffected. Default: denylist active on interactive ' +
      'surfaces; headless already fails open (opt in with AFK_FORCE_BASH_INTERPRETER_GUARD=1). To ' +
      'disable all of path-approval + bash restriction instead, use AFK_DISABLE_PATH_APPROVAL=1.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'process',
  },
  {
    name: 'AFK_DISABLE_PATH_APPROVAL',
    description:
      'Skip the path-approval + bash-restriction hooks entirely when set to 1. Use for headless ' +
      'flows that need wide-open file access (CI scripts, batch jobs). Default: hooks enabled. ' +
      'Note: on headless surfaces (afk chat, daemon) no grant manager is wired, so the interpreter ' +
      'denylist (python -c, node -e, sh -c, ...) fails OPEN by default — opt headless flows into it ' +
      'with AFK_FORCE_BASH_INTERPRETER_GUARD=1, or set this var to 1 to disable all of path-approval.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'process',
  },
  {
    name: 'AFK_DISABLE_SPINE_UPDATE',
    description:
      'Disable the SPINE.md SessionEnd hook when set to 1. The hook runs a single LLM call at the ' +
      'end of each top-level session to classify architectural signals in the git diff against ' +
      'SPINE.md. Set to 1 to opt out globally (useful in CI or when the LLM call is unwanted).',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_FORCE_BASH_INTERPRETER_GUARD',
    description:
      'Apply the bash interpreter-eval denylist (python -c, node -e, sh -c, ...) even on headless ' +
      'surfaces (afk chat, daemon) where no grant manager is wired. By default the denylist ' +
      'fires only on interactive surfaces (REPL/Telegram), failing open on headless so legitimate ' +
      'automation is not hard-blocked with no recourse. Set to 1 to opt headless flows back into the ' +
      'guard. Overridden by AFK_DISABLE_BASH_INTERPRETER_GUARD=1. Default: off (headless fails open).',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'process',
  },
  {
    name: 'AFK_EFFORT',
    description: 'Effort hint guiding adaptive-thinking depth, forwarded as Anthropic output_config.effort (model-gated; ignored where unsupported). Accepts low | medium | high | xhigh | max.',
    type: 'string',
    required: false,
    example: 'medium',
    category: 'model',
  },
  {
    name: 'AFK_EVAL_STALENESS_DAYS',
    description:
      'Number of days without a completed eval-run before the ground-state pre-flight ' +
      'surfaces a staleness warning. The guard reads the most recent timestamp from the ' +
      'eval-runs index ($AFK_HOME/agent-framework/improve/eval-runs/.index.jsonl) and ' +
      'emits a warning finding when the gap exceeds this threshold. Default: 7. ' +
      'Set to 0 to disable the guard.',
    type: 'number',
    required: false,
    default: '7',
    example: '14',
    category: 'misc',
  },
  {
    name: 'AFK_MAX_BUDGET_USD',
    description: 'Opt-in cumulative USD budget ceiling for the session. Aborts the turn when the running cost crosses this. Unset by default (no cap applied).',
    type: 'number',
    required: false,
    example: '5.00',
    category: 'model',
  },
  {
    name: 'AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS',
    description: 'Maximum concurrency-safe tool calls run simultaneously within one dispatcher batch. Default 8; accepted range 1-32; out-of-range or unparseable input falls back to the default.',
    type: 'number',
    required: false,
    default: '8',
    example: '4',
    category: 'process',
  },
  {
    name: 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS',
    description: 'Maximum subagent calls run simultaneously from one compose/DAG layer or skill wave. Default 8; accepted range 1-32; out-of-range or unparseable input falls back to the default.',
    type: 'number',
    required: false,
    default: '8',
    example: '2',
    category: 'process',
  },
  {
    name: 'AFK_MAX_CONCURRENT_BACKGROUND_JOBS',
    description: 'Maximum background subagent jobs running simultaneously in one registry. Default 10; accepted range 1-64; out-of-range or unparseable input falls back to the default.',
    type: 'number',
    required: false,
    default: '10',
    example: '5',
    category: 'process',
  },
  {
    name: 'AFK_MAX_NESTING_DEPTH',
    description:
      'Maximum sub-agent/skill nesting depth; 0 disables nested delegation entirely (the agent, ' +
      'skill, AND compose tools all refuse). A top-level session is depth 0, so the default 3 ' +
      'permits three generations of forked descendants (depth 1 → 2 → 3) and refuses the agent ' +
      'and skill tools at depth 3. Resolved once ' +
      'at the root of each session and propagated down through child AgentConfig, so descendants ' +
      'inherit the root value rather than re-reading the environment. Raise with care: depth is a ' +
      'fan-out exponent (a width-N wave at depth D reaches ~N^D concurrent children), so values ' +
      'above 4 invite provider rate-limit (429) cascades. Accepted range 0-6; unset, empty, ' +
      'unparseable, negative, or out-of-range input falls back to the default. An explicit ' +
      'programmatic maxDepth (SubagentExecutorContext / SkillExecutorContext) still wins.',
    type: 'number',
    required: false,
    default: '3',
    example: '2',
    category: 'model',
  },
  {
    name: 'AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT',
    description:
      'Maximum number of child agents a single agent may have running concurrently (per-agent concurrent child cap). ' +
      'Part of the delegation budget: guards against a single agent fanning out too many simultaneous children. ' +
      'Accepted range 1-20; unset or unparseable means no per-agent child limit. ' +
      'Works alongside AFK_MAX_CONCURRENT_AGENTS and AFK_MAX_TOTAL_AGENTS.',
    type: 'number',
    required: false,
    example: '4',
    category: 'model',
  },
  {
    name: 'AFK_MAX_CONCURRENT_AGENTS',
    description:
      'Maximum number of simultaneously-running agents across the entire session tree. ' +
      'Part of the delegation budget: prevents rate-limit (429) cascades from too many parallel children. ' +
      'Accepted range 1-64; unset or unparseable means no concurrent limit. ' +
      'Works alongside AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT and AFK_MAX_TOTAL_AGENTS.',
    type: 'number',
    required: false,
    example: '16',
    category: 'model',
  },
  {
    name: 'AFK_MAX_TOTAL_AGENTS',
    description:
      'Maximum total agents spawned across the entire session tree (lifetime, not concurrent). ' +
      'Part of the delegation budget: absolute ceiling preventing runaway recursive delegation. ' +
      'Accepted range 1-200; unset or unparseable means no total limit. ' +
      'Works alongside AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT and AFK_MAX_CONCURRENT_AGENTS.',
    type: 'number',
    required: false,
    example: '48',
    category: 'model',
  },
  {
    name: 'AFK_MAX_OUTPUT_TOKENS',
    description:
      'Cap on output tokens per turn. When unset, falls back to the model output ceiling ' +
      "(AFK's own per-model limit, 64k–128k — NOT a small provider default), so every request " +
      'advertises the full ceiling by default. An over-ceiling value is clamped down with a warning.',
    type: 'number',
    required: false,
    example: '8192',
    category: 'model',
  },
  {
    name: 'AFK_MAX_TOKENS',
    description: 'Deprecated and inert: not read by the generation path. Use AFK_MAX_OUTPUT_TOKENS (or --max-output-tokens) to cap per-response output tokens; falls back to the model output ceiling when unset.',
    type: 'number',
    required: false,
    default: '4096',
    example: '8192',
    category: 'model',
  },
  {
    name: 'AFK_MAX_TOOL_USE_ITERATIONS',
    description:
      'Opt-in ceiling on tool-use rounds per turn for TOP-LEVEL (non-subagent) sessions, on both ' +
      'providers. Mirrors the maxToolUseIterations config key / max_tool_use_iterations tool param. ' +
      'Unset, non-numeric, or <=0 means unlimited (the default — zero behavior change): a top-level ' +
      'turn ends only when the model stops calling tools, the abort signal fires, the provider ' +
      'errors, or the dollar budget trips. A positive integer N makes top-level turns wind down ' +
      'gracefully after N tool rounds (one tools-stripped final round). An explicit config/CLI ' +
      'value wins over this env default. Does NOT affect subagent forks — they keep their own ' +
      'non-zero anti-hang default (SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS) regardless of this var.',
    type: 'number',
    required: false,
    default: '0',
    example: '150',
    category: 'model',
  },
  {
    name: 'AFK_MEMORY_EVIDENCE_GATE',
    description:
      'Evidence gate for durable memory writes. When enabled, a codebase ' +
      'fact (memory_update category "convention") stored without an evidence citation is ' +
      'recalled as [unverified], and memory_search results carry a verification verdict. ' +
      'User preferences and agent reflections are never gated. On by default. ' +
      'Set to 0 to disable.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'misc',
  },
  {
    name: 'AFK_MICROCOMPACT_KEEP_LAST',
    description: 'Number of the most-recent tool_result blocks that tool-result microcompaction keeps intact regardless of size, so the agent does not lose the tool output it is actively reasoning over. Older results are the safe ones to trim. Default 4 (see shared/compaction.ts DEFAULT_MICROCOMPACT_KEEP_LAST). Values <= 0 protect nothing.',
    type: 'number',
    required: false,
    default: '4',
    example: '3',
    category: 'model',
  },
  {
    name: 'AFK_MICROCOMPACT_TOOL_RESULT_BYTES',
    description: 'Byte threshold (tool_result content length) at/above which a tool_result block becomes a microcompaction candidate. When /compact and auto-compaction would otherwise no-op on a short-but-full session, microcompaction clears large/old tool_result CONTENT in place (largest first) — replacing it with a short placeholder, never removing the block — to reclaim context deterministically (no LLM call). Blocks below this size are left intact. Default 2048 (see shared/compaction.ts DEFAULT_MICROCOMPACT_TOOL_RESULT_BYTES).',
    type: 'number',
    required: false,
    default: '2048',
    example: '4096',
    category: 'model',
  },
  {
    name: 'AFK_MICROCOMPACT_DELEGATION_BYTES',
    description: 'Byte threshold for delegation tool results (agent/compose/skill). These results carry pre-compressed subagent findings that are expensive to re-derive -- clearing them destroys irreplaceable synthesized knowledge. A delegation tool result must be at least this large before microcompaction considers clearing it. Default 16384 (16KB, vs 2KB for ordinary tools). Set to match AFK_MICROCOMPACT_TOOL_RESULT_BYTES to disable the elevated threshold.',
    type: 'number',
    required: false,
    default: '16384',
    example: '32768',
    category: 'model',
  },
] as const satisfies readonly EnvVarMeta[];
