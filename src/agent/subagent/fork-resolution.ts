/**
 * Pure resolution chain for `SubagentManager.forkSubagent`.
 *
 * Extracted from `forkSubagent` to reduce function size — every resolution here
 * is synchronous and side-effect-free. Takes EXPLICIT parameters so a reader
 * can understand every input without tracing back to the caller.
 *
 * Deliberately EXCLUDES:
 * - `dispatchSubagentStart` — async side-effect (hook dispatch)
 * - `resolveReadScope` / `composeWriteRoots` — async, mutates worktree cache
 * - abort-graph registration — mutates manager state
 * - occupancy heartbeat — closure-coupled to try/catch lifecycle
 *
 * @module agent/subagent/fork-resolution
 */

import type { HookRegistry } from '../hooks.js';
import type { TraceSink } from '../trace/index.js';
import type { AgentModelInput } from '../types.js';
import type { ForkSubagentOptions } from './fork-types.js';
import { coerceCrossProviderChildModel } from './child-model-fallback.js';
import { resolveSubagentTimeoutMs } from './constants.js';

/** Inputs to the pure resolution chain. Explicit — no closure over manager state. */
export interface ResolveForkInputsArgs {
  options: ForkSubagentOptions;
  /** Current counter value (already incremented by caller). */
  counter: number;
  // Manager-level fields threaded explicitly:
  managerHookRegistry: HookRegistry | undefined;
  parentTraceWriter: TraceSink | undefined;
  parentModel: string | undefined;
}

/** Resolved values produced by the pure resolution chain. */
export interface ForkResolved {
  /** Unique subagent identifier. */
  id: string;
  /** Parent session ID used as resume token. */
  resume: string | undefined;

  // Registry resolution (highest → lowest precedence):
  //   1. explicit per-fork override (config.hookRegistry)
  //   2. manager-level registry (managerHookRegistry)
  //   3. the forking parent session's registry (options.parent.hookRegistry)
  // Production almost always lands on (3): entry points build the registry
  // AFTER the manager/executors, so neither (1) nor (2) is set — but the
  // parent session exposes it at fork time. Without (3), SubagentStart/Stop
  // (incl. the shadow-verify nudge) would silently never fire.
  registry: HookRegistry | undefined;

  // Witness-writer resolution: explicit per-fork config wins, then the
  // manager-level writer (constructed at the surface bootstrap). This is
  // the SINGLE resolved value used by every witness touchpoint in this
  // fork path — SubagentStart dispatch, the child handle, and the
  // subagent_lifecycle 'started' emit below. Before this, those three
  // read `options.config.traceWriter` directly, so a fork relying on
  // manager-level inheritance (the `agent`-tool path — its executors
  // never set config.traceWriter) produced a child whose entire lifetime
  // was invisible in `afk trace show` even though childConfig inherited
  // the writer for the session's own events.
  effectiveTraceWriter: TraceSink | undefined;

  // #652: coerce a Claude-family child that would be mis-routed to the
  // openai-compatible provider onto the parent's model. See
  // ./child-model-fallback.ts.
  effectiveChildModel: AgentModelInput;

  // The original model string before coercion, when coercion fired.
  // `undefined` means no coercion was needed. The caller emits the warning
  // AFTER hook dispatch so a blocked fork never tells the operator it is
  // "running" under a substituted model.
  coercedFrom: string | undefined;

  // Wall-clock budget for the child's turn (see SUBAGENT_DEFAULT_TIMEOUT_MS).
  // Settled in the resolution phase (not inline at handle construction) because
  // it feeds TWO consumers that must agree: the handle's hard `withTimeout`
  // abort, and the child config's soft deadline. Reading it twice would let
  // them drift.
  effectiveTimeoutMs: number;
}

/**
 * Resolve the pure, synchronous inputs for a subagent fork.
 *
 * Every field on the returned {@link ForkResolved} is deterministic given its
 * inputs — no async work, no manager-state mutation, no abort-graph wiring,
 * no I/O side-effects. The coercion warning is deferred to the caller so it
 * fires AFTER hook dispatch (a blocked fork never tells the operator it is
 * "running" under a substituted model).
 */
export function resolveForkInputs(args: ResolveForkInputsArgs): ForkResolved {
  const { options, counter, managerHookRegistry, parentTraceWriter, parentModel } = args;

  const safePrefix = (options.idPrefix ?? 'subagent').replace(/[^A-Za-z0-9_-]/g, '-');
  const id = `${safePrefix}-${Date.now()}-${counter}`;
  const resume = options.parent.sessionId;

  const registry =
    options.config.hookRegistry ?? managerHookRegistry ?? options.parent.hookRegistry;

  const effectiveTraceWriter = options.config.traceWriter ?? parentTraceWriter;

  // Model coercion: see ./child-model-fallback.ts.
  // `?? options.config.model` keeps the type as the required AgentModelInput:
  // the helper only returns undefined when given an undefined model, and
  // options.config.model is always defined here.
  const childModelCoercion = coerceCrossProviderChildModel(
    options.config.model,
    parentModel,
  );
  const effectiveChildModel = childModelCoercion.model ?? options.config.model;

  const effectiveTimeoutMs = options.config.timeoutMs ?? resolveSubagentTimeoutMs();

  return {
    id,
    resume,
    registry,
    effectiveTraceWriter,
    effectiveChildModel,
    coercedFrom: childModelCoercion.coercedFrom,
    effectiveTimeoutMs,
  };
}
