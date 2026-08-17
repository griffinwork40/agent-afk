/**
 * Witness-layer lifecycle events for a newly-forked subagent.
 *
 * Extracted from `SubagentManager.forkSubagent` (#919). The two emissions
 * here — `subagent_lifecycle.started` and the routing-telemetry row — form a
 * matched pair that fires AFTER the handle is wired into both the active map
 * and the abort-graph. Emitting earlier would create a window where the trace
 * shows a started subagent the manager doesn't know about.
 *
 * Both functions take EXPLICIT parameters so they are independently testable
 * and readable without tracing back to forkSubagent's locals.
 *
 * @module agent/subagent/fork-lifecycle
 */

import type { AgentConfig, AgentModelInput } from '../types.js';
import type { TraceSink } from '../trace/index.js';
import { emitSubagentLifecycle } from '../trace/emit.js';
import { appendRoutingDecision } from '../routing-telemetry.js';

export interface EmitForkStartedArgs {
  effectiveTraceWriter: TraceSink | undefined;
  id: string;
  parentSessionId: string | undefined;
  /** Manager rootId — fallback parentId when parentSessionId is undefined. */
  rootId: string;
  effectiveChildModel: AgentModelInput;
  childConfig: AgentConfig;
  promptHead: string | undefined;
  effectiveAgentType: string | undefined;
  effectiveResolvedAgentType: string | undefined;
}

/**
 * Emit `subagent_lifecycle.started` into the shared witness trace.
 *
 * Witness layer: subagent_lifecycle.started fires AFTER the handle is
 * wired into the manager's active map and the abort-graph. Emitting
 * earlier (e.g. before linkChild) would create a window where the
 * trace shows a started subagent that the manager doesn't know about.
 *
 * parentId fallback: the child's `options.parent.sessionId` is the
 * honest answer when present; for a top-level fork from a session
 * that hasn't initialized yet, we fall back to the manager's rootId
 * so the schema's `parentId: string` requirement stays satisfied.
 */
export function emitForkStarted(args: EmitForkStartedArgs): string {
  const {
    effectiveTraceWriter,
    id,
    parentSessionId,
    rootId,
    effectiveChildModel,
    childConfig,
    promptHead,
    effectiveAgentType,
    effectiveResolvedAgentType,
  } = args;

  const modelString =
    typeof effectiveChildModel === 'string'
      ? effectiveChildModel
      : JSON.stringify(effectiveChildModel);

  void emitSubagentLifecycle(effectiveTraceWriter, {
    transition: 'started',
    subagentId: id,
    parentId: parentSessionId ?? rootId,
    model: modelString,
    ...(childConfig.tools?.allowedTools
      ? { allowedTools: [...childConfig.tools.allowedTools] }
      : {}),
    // Observability: WHAT was this child asked to do + WHICH role. promptHead
    // is the caller-supplied prompt slice (re-clamped to 80 to honour the
    // payload contract regardless of caller input); agentType is the already-
    // computed effective render label. Both omitted when unavailable so the
    // schema's `.optional()` fields stay absent rather than empty-valued.
    ...(promptHead && promptHead.trim() !== ''
      ? { promptHead: promptHead.slice(0, 80) }
      : {}),
    ...(effectiveAgentType ? { agentType: effectiveAgentType } : {}),
    // resolvedAgentType: the clean registered type (set only for named
    // dispatches). Carried separately from the agentType render label so a
    // trace reader can group by real type without the label-fallback noise.
    ...(effectiveResolvedAgentType ? { resolvedAgentType: effectiveResolvedAgentType } : {}),
  });

  return modelString;
}

export interface AppendForkTelemetryArgs {
  modelString: string;
  id: string;
  idPrefix: string | undefined;
  parentSessionId: string | undefined;
  effectiveResolvedAgentType: string | undefined;
}

/**
 * Append the `subagent.dispatched` row to routing-decisions.jsonl.
 *
 * Persists the resolved registered type into routing-decisions.jsonl so
 * "which agent types get dispatched, how often" is a one-line query on
 * the durable telemetry stream (undefined is dropped at write time).
 */
export async function appendForkTelemetry(args: AppendForkTelemetryArgs): Promise<void> {
  const { modelString, id, idPrefix, parentSessionId, effectiveResolvedAgentType } = args;
  await appendRoutingDecision({
    event: 'subagent.dispatched',
    subagent_id: id,
    id_prefix: idPrefix,
    model: modelString,
    parent_session_id: parentSessionId,
    resolved_agent_type: effectiveResolvedAgentType,
  });
}
