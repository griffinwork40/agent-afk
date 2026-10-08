/**
 * Per-query dispatcher options for {@link OpenAICompatibleProvider.buildDispatcher}.
 *
 * Extracted from the inline parameter type literal in `index.ts` so the
 * documented option fields do not count against the `buildDispatcher`
 * function-size ceiling (the AST measure includes an inline type literal).
 * Shape is unchanged; parity with `anthropic-direct/build-dispatcher.ts`
 * `BuildDispatcherOptions`.
 *
 * @module agent/providers/openai-compatible/index.dispatcher-opts
 */

import type { PlanExitControls } from '../../types/config-types.js';
import type { RuntimeStateSource } from '../../awareness/index.js';

export interface BuildDispatcherOpts {
  cwd?: string;
  readRoots?: string[];
  writeRoots?: string[];
  sessionId?: string;
  parentSessionId?: string;
  /**
   * Root (depth-0) session id, forwarded from {@link AgentConfig.rootSessionId}.
   * Undefined on top-level sessions. Parity with
   * `anthropic-direct/build-dispatcher.ts:BuildDispatcherOpts.rootSessionId`.
   */
  rootSessionId?: string;
  /**
   * This fork's own subagent id — parity with
   * `anthropic-direct/index.ts:buildDispatcher`. Stamped onto every
   * `hook_decision` the dispatcher emits so a policy block is attributable
   * to the child that provoked it. Undefined on a top-level session.
   */
  subagentId?: string;
  /** `AgentConfig.env` — parity with anthropic-direct (bash/test_run child env). */
  env?: Record<string, string>;
  /**
   * Explicit "this session is a forked subagent" signal carrying the
   * per-result output-cap budget (#661) — parity with
   * `anthropic-direct/index.ts:buildDispatcher`. Set to MODEL_CAP_BYTES by
   * `SubagentManager.forkSubagent` for EVERY fork; undefined on a top-level
   * session. Arms the dispatcher's `maxOutputBytes` backstop declaratively.
   */
  subagentToolOutputCapBytes?: number;
  traceWriter?: import('../../trace/index.js').TraceSink;
  /** Factory for the REPL-only live bash output tail callback. */
  bashOutputTailReporter?: (toolUseId: string) => (tail: string | undefined) => void;
  /**
   * Session-scoped detach registry for the Ctrl+B bash-backgrounding
   * contract (#2542, #2735) — parity with anthropic-direct buildDispatcher.
   * Absent for headless surfaces and forked children.
   */
  detachRegistry?: import('../../tools/detach-registry.js').DetachableToolRegistry;
  /** Background process registry (`bash run_in_background`); root REPL sessions only. */
  processJobs?: import('../../shell-jobs/process-jobs.js').ProcessJobRegistry;
  /**
   * Live source for the `get_runtime_state` tool — see the matching
   * comment in `anthropic-direct/index.ts:buildDispatcher`.
   */
  runtimeStateSource?: RuntimeStateSource;
  /**
   * When true, this is a skill-dispatch sub-agent: strip the `ask_question`
   * escape-hatch tool so it cannot ask the operator "which skill?". Parity
   * with the `config.isSkillDispatch` toolDefs filter in
   * AnthropicDirectProvider.
   */
  isSkillDispatch?: boolean;
  /**
   * When true, this is a non-interactive surface (daemon, scheduler/cron,
   * one-shot chat) where no human answers elicitations. Strip `ask_question`
   * only (not `terminal_font_size`). Parity with the `config.isNonInteractive`
   * toolDefs filter in AnthropicDirectProvider. Also forwarded to the
   * dispatcher via {@link headlessSignalOpts} as the explicit headless signal
   * for the bash-restriction floor (#2302).
   */
  isNonInteractive?: boolean;
  /**
   * Session-scoped hook registry from `AgentConfig.hookRegistry`. Threaded
   * here so `PreToolUse`/`PostToolUse` hooks (notably the plan-mode gate)
   * fire on the per-query dispatcher. Falls back to the constructor-time
   * `providerOpts.hookRegistry` when unset. Mirrors AnthropicDirectProvider.
   */
  hookRegistry?: import('../../hooks.js').HookRegistry;
  /**
   * Session-control bridge for `exit_plan_mode`, forwarded from the query
   * config (top-level sessions only). When set AND `permissionMode ===
   * 'plan'`, the handler + schema are registered. Mirrors AnthropicDirectProvider.
   */
  planExitControls?: PlanExitControls;
}

/**
 * Root-REPL-only session registries forwarded from AgentConfig to the
 * per-query dispatcher: the Ctrl+B detach registry (#2542) and the background
 * process registry. Both are absent for forks, so a child never inherits them.
 * Extracted so `index.ts` (file-size baselined) forwards both in one line.
 */
export function sessionRegistryOpts(src: {
  detachRegistry?: BuildDispatcherOpts['detachRegistry'];
  processJobs?: BuildDispatcherOpts['processJobs'];
}): Pick<BuildDispatcherOpts, 'detachRegistry' | 'processJobs'> {
  return {
    ...(src.detachRegistry !== undefined ? { detachRegistry: src.detachRegistry } : {}),
    ...(src.processJobs !== undefined ? { processJobs: src.processJobs } : {}),
  };
}

/**
 * The explicit headless signal forwarded to the per-query dispatcher, which
 * injects it onto every PreToolUse context as `nonInteractive` (#2302). Parity
 * with `anthropic-direct/build-dispatcher.ts`. Needed because this provider
 * wires itself as the session grant manager on EVERY surface, so grant-manager
 * absence can never tell the bash-restriction hook a session is unattended.
 * Extracted so `index.ts` (file-size baselined) forwards it without growing.
 */
export function headlessSignalOpts(src: Pick<BuildDispatcherOpts, 'isNonInteractive'>): {
  isNonInteractive?: true;
} {
  return src.isNonInteractive === true ? { isNonInteractive: true } : {};
}
