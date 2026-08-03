import { unconfiguredSlotError } from '../../../agent/session/model-slots.js';
import type { ThinkingConfig, EffortLevel, AgentConfig } from '../../../agent/types.js';
import {
  parseThinking, parseEffort, parseMaxOutputTokens, getThinking, getEffort,
  getMaxOutputTokens, getMaxToolUseIterations, resolveBaseSystemPrompt,
} from '../../shared-helpers.js';
import { loadConfig, type CliConfig } from '../../config.js';
import { assembleSystemPrompt } from '../../../agent/routing-directive.js';
import type { CliOptions } from './shared.js';
import { resolveResumeCwd } from './shared.js';
import { resolveResumeTarget, resumeConfigFor } from '../../resume-session.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';

/** Resolved bootstrap configuration — output of {@link resolveBootstrapConfig}. */
export interface BootstrapConfig {
  resumeTarget: ResolvedResumeTarget | undefined;
  resumeConfig: Partial<AgentConfig>;
  effectiveCwd: string | undefined;
  sessionModel: string;
  thinking: ThinkingConfig | undefined;
  effort: EffortLevel | undefined;
  maxOutputTokens: number | undefined;
  maxToolUseIterations: number | undefined;
  basePrompt: string | undefined;
  systemPrompt: string | undefined;
  systemPromptSource: string | undefined;
  cliConfig: CliConfig;
}

/**
 * Resolve the resume target, effective cwd, session model, thinking/effort/
 * token knobs, and the layered system prompt from CLI options. Extracted
 * from `bootstrapSession` so option-parsing failures (the unconfigured-slot
 * throw below) are testable without constructing the heavy session/executor
 * graph.
 *
 * Throws when the resolved session model names an unconfigured capability
 * tier (e.g. `afk i -m local` with no `AFK_MODEL_LOCAL`) — callers must let
 * this propagate before building the REPL session, exactly as the inlined
 * code did.
 */
export function resolveBootstrapConfig(
  options: CliOptions,
  extras?: { cwd?: string },
): BootstrapConfig {
  const resumeTarget = resolveResumeTarget(options);
  const resumeConfig = resumeConfigFor(resumeTarget);
  // Resume cwd restoration: a resumed session should run in the directory it
  // was saved in (e.g. an `afk --worktree` session that was later /fork'd or
  // --resume'd), not wherever the shell happens to be. Precedence: an explicit
  // --worktree override (extras.cwd) always wins; otherwise fall back to the
  // stored cwd IFF it still exists on disk as a directory — a cleaned-up
  // worktree degrades safely to process.cwd(). `effectiveCwd` is threaded
  // through every cwd-purpose usage below (stats stamp, hook/session cwd,
  // subagent/skill/compose/MCP cwd) so resumed worktree sessions AND their
  // children anchor correctly. Defaults to `extras?.cwd` when there is no
  // resume override, so this is a safe drop-in: behavior only changes for a
  // resume whose stored cwd still exists.
  const effectiveCwd = resolveResumeCwd(extras?.cwd, resumeTarget?.stored?.cwd);
  const sessionModel = resumeTarget?.stored?.model ?? options.model;
  // Fail fast on an unconfigured capability tier (e.g. `afk i -m local` with no
  // AFK_MODEL_LOCAL) before building the REPL session — an empty id would
  // otherwise reach the provider as an opaque error or a silent cloud call.
  const unconfiguredModel = unconfiguredSlotError(sessionModel);
  if (unconfiguredModel) {
    throw new Error(unconfiguredModel);
  }

  const thinking: ThinkingConfig | undefined = parseThinking(options.thinking) ?? getThinking();
  const effort: EffortLevel | undefined = parseEffort(options.effort) ?? getEffort();
  const maxOutputTokens: number | undefined =
    parseMaxOutputTokens(options.maxOutputTokens) ?? getMaxOutputTokens();
  // Opt-in top-level tool-use-round ceiling. No CLI flag exists, so this is the
  // env default only (unset/<=0 → undefined → unlimited; no behavior change).
  const maxToolUseIterations = getMaxToolUseIterations();

  // System-prompt layering: the framework base (`prompts/system-prompt.md`)
  // is unconditional; the operator overlay (env → afk.config.json → AFK.md)
  // is appended on top via resolveBaseSystemPrompt(), never substituted for
  // the base. `source` is the layered provenance string surfaced by
  // --dump-prompt (`framework`, `framework+afk-md:/path`, …).
  const { prompt: basePrompt, source: systemPromptSource } = resolveBaseSystemPrompt();
  const cliConfig = loadConfig();
  const autoRouting = cliConfig.autoRouting?.interactive ?? true;
  const systemPrompt = assembleSystemPrompt(basePrompt, autoRouting, 'repl');

  return {
    resumeTarget,
    resumeConfig,
    effectiveCwd,
    sessionModel,
    thinking,
    effort,
    maxOutputTokens,
    maxToolUseIterations,
    basePrompt,
    systemPrompt,
    systemPromptSource,
    cliConfig,
  };
}
