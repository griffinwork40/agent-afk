/**
 * `get_runtime_state` tool — schema + handler factory.
 *
 * Colocated with the awareness types/builder rather than living under
 * `src/agent/tools/handlers/` because the tool's contract is intrinsic to the
 * awareness layer (the schema's `view` enum mirrors {@link RuntimeView}, and
 * the response shape is {@link RuntimeSnapshot}). Mirrors the layout of
 * `src/agent/memory/memory-tools.ts`.
 *
 * Wired by the providers (`anthropic-direct/index.ts`, `openai-compatible/index.ts`):
 *   - Schema added to the provider's `schemas` list at construction time.
 *   - Handler created per-query via {@link createGetRuntimeStateHandler}
 *     and merged into the dispatcher's handler map.
 *
 * @module agent/awareness/tool
 */

import type { AnthropicToolDef, ToolHandler } from '../tools/types.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { ToolDispatcher } from '../providers/anthropic-direct/tool-dispatcher.js';
import type { RuntimeStateSource } from './types.js';
import { buildRuntimeSnapshot, parseView } from './runtime-snapshot.js';

/**
 * Tool definition for `get_runtime_state`. Stable surface — the model relies
 * on the description to know when to call it. Keep wording focused on
 * legitimate use cases (orientation, conflict-checking) rather than promising
 * data the snapshot does not include (no git state, no presence info in Phase 1).
 */
export const getRuntimeStateTool: AnthropicToolDef = {
  name: 'get_runtime_state',
  category: 'other',
  concurrencySafe: true,
  description:
    'Inspect what the runtime knows about this session: identity (sessionId, ' +
    'surface, depth, parent), tool affordances (currently-enabled tool names ' +
    'and MCP server summary), delegation state (active subagent handles, ' +
    'background jobs), and git workspace state (branch, HEAD SHA, dirty count, ' +
    'remote URL). Returns a compact JSON snapshot.\n\n' +
    'Use when uncertain about: your current nesting depth, whether a tool you ' +
    'want is actually available right now, what MCP servers are wired, ' +
    'whether earlier subagents you dispatched are still running, or what git ' +
    'branch / commit the session started on.\n\n' +
    'Views:\n' +
    '- `self`       — identity + model + permissions + cwd only\n' +
    '- `tools`      — enabled tool names + MCP server summary only\n' +
    '- `subagents`  — active subagent handles + background jobs only\n' +
    '- `workspace`  — git state (branch, headSha, dirty, dirtyCount, remoteUrl)\n' +
    '- `all`        — union of the four above (default)\n\n' +
    'This is a read-only, in-memory inspection. It does not probe the file ' +
    'system or network. Fields the runtime does not know (e.g. depth for a ' +
    'top-level session) come back as `null` rather than synthesised defaults.',
  input_schema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: ['self', 'tools', 'subagents', 'workspace', 'all'],
        description:
          'Which slice of state to return. Defaults to "all". Use a narrower ' +
          'view when only one slice is needed to keep the response compact.',
      },
    },
    required: [],
  },
};

/**
 * Names of the always-on awareness tools that every provider registers
 * unconditionally (see `anthropic-direct/index.ts` and `openai-compatible/index.ts`).
 *
 * Must be appended to every `permissions.allowedTools` allowlist constructed
 * at session-bootstrap time — without these entries the dispatcher's
 * permission gate (see `SessionToolDispatcher.execute()` → `checkToolPermission`)
 * rejects the registered handler with `Tool "get_runtime_state" is not in the
 * configured allowlist`, even though the schema is offered to the model and
 * the handler is wired.
 *
 * Kept as a single source of truth so adding a new awareness view (browser,
 * presence, claims, …) does not require a 6-site sweep across the CLI/threads/
 * telegram/subagent allowlist constructors.
 */
export const AWARENESS_TOOL_NAMES: readonly string[] = [getRuntimeStateTool.name];

/**
 * Factory that produces a handler closed over the given {@link RuntimeStateSource}.
 *
 * The handler is intentionally trivial — all data shaping lives in the
 * snapshot builder so it can be unit-tested without spinning up a dispatcher.
 */
export function createGetRuntimeStateHandler(source: RuntimeStateSource): ToolHandler {
  return async (input, _signal) => {
    const view = input && typeof input === 'object'
      ? parseView((input as Record<string, unknown>)['view'])
      : 'all';
    const snapshot = buildRuntimeSnapshot(source, view);
    return { content: JSON.stringify(snapshot) };
  };
}

/**
 * Wrap a caller-supplied {@link ToolDispatcher} so that `get_runtime_state`
 * calls are intercepted and routed to the awareness handler, while every
 * other tool name delegates to the inner dispatcher.
 *
 * Used by the provider `externalTools` / `providerOpts.tools` branch (tests,
 * the nesting fixture, embedders that own their dispatcher lifecycle) so the
 * awareness layer remains reachable even when the provider does not build
 * its own `SessionToolDispatcher`. Without this, callers who inject a custom
 * dispatcher get a working session but a silently-missing `get_runtime_state`
 * — the schema is offered (see provider `toolDefs` assembly), the model
 * dispatches, and the inner dispatcher returns `Unknown tool` because it
 * never registered the awareness handler.
 *
 * Invariant: the returned wrapper preserves the inner dispatcher's identity
 * for every non-awareness call — only the `name === 'get_runtime_state'`
 * branch is short-circuited. Render hints, isError, truncated, testResult
 * all flow through verbatim for the inner path.
 *
 * Duck-typed `toolDefs` exposure: the `openai-compatible` provider's
 * `OpenAICompatibleQuery` reads `dispatcher.toolDefs` via a duck-typed
 * structural check to pre-compute the OpenAI function catalog from the same
 * schema list the dispatcher will route against. If the inner dispatcher
 * exposes `toolDefs` (e.g. a {@link import('../tools/dispatcher.js').SessionToolDispatcher}),
 * the wrapper forwards that list with `getRuntimeStateTool` appended so the
 * model sees the awareness tool in its catalog without losing the inner
 * tools. If the inner dispatcher exposes no `toolDefs` (the minimal
 * ad-hoc test-dispatcher case), the wrapper omits the property — falling
 * back to the provider's own toolDefs-derivation path, which is the only
 * code path that currently consumes this field on the anthropic-direct
 * provider.
 */
export function wrapDispatcherWithRuntimeState(
  inner: ToolDispatcher,
  source: RuntimeStateSource,
): ToolDispatcher {
  const handler = createGetRuntimeStateHandler(source);
  const innerWithDefs = inner as ToolDispatcher & { toolDefs?: readonly AnthropicToolDef[] };
  const baseDefs = Array.isArray(innerWithDefs.toolDefs) ? innerWithDefs.toolDefs : null;

  // Only attach `toolDefs` to the wrapper when the inner dispatcher already
  // exposes one — keeps the duck-typed contract observable to callers that
  // rely on it (openai-compatible) while remaining invisible to callers that
  // don't (the minimal anthropic-direct externalTools test path).
  const wrapper: ToolDispatcher & { toolDefs?: readonly AnthropicToolDef[] } = {
    async execute(call: ToolCall): Promise<ToolResult> {
      if (call.name === 'get_runtime_state') {
        return handler(call.input, call.signal);
      }
      return inner.execute(call);
    },
  };
  if (baseDefs !== null) {
    // Avoid duplicating the schema if the caller's inner dispatcher already
    // (somehow) lists it — last-write-wins still favors the wrapper handler
    // because the execute() interceptor runs before delegation.
    const hasAwareness = baseDefs.some((t) => t.name === 'get_runtime_state');
    wrapper.toolDefs = hasAwareness ? baseDefs : [...baseDefs, getRuntimeStateTool];
  }
  return wrapper;
}
