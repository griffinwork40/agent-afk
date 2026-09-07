/**
 * Workspace-subscription opt-in wiring for forked subagents.
 *
 * Mirrors fork-progress-events.ts: a mutable handleRef bridges the gap between
 * dispatcher-build time (when the subscribe handler is created and registered)
 * and handle-construction time (when the ring buffer target becomes available).
 *
 * Call wireWorkspaceSubscriptions() before new AgentSession() — it mutates
 * config only to inject schema-level support; no handler is added to
 * customTools (the handler travels via build-dispatcher deps instead).
 * Call bindHandle(handle) immediately after SubagentHandleImpl is constructed.
 *
 * @module agent/subagent/workspace-subscription-wiring
 */

import type { ToolHandler } from '../tools/types.js';
import type { WorkspaceStore } from '../workspace/workspace-store.js';
import type { WorkspaceEntryType } from '../workspace/workspace-store.js';
import { WORKSPACE_DELIVERY_RING_CAPACITY } from '../workspace/workspace-subscription-constants.js';
import { generateSubscriptionId } from '../workspace/workspace-subscription.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { TraceSink } from '../trace/index.js';
import type { SubagentHandleImpl } from './handle.js';

/** Result of wireWorkspaceSubscriptions — the handler to register + a callback to bind the handle. */
export interface WorkspaceSubscriptionWiring {
  /** The tool handler for workspace_subscribe. Register in dispatcher deps. */
  subscribeHandler: ToolHandler;
  /** Call after SubagentHandleImpl construction to bind the ring buffer target. */
  bindHandle: (handle: SubagentHandleImpl<unknown>) => void;
}

/**
 * Wire workspace subscriptions for a forked subagent.
 *
 * Returns { subscribeHandler, bindHandle }. The subscribeHandler is registered
 * on the dispatcher deps bag; bindHandle MUST be called after SubagentHandleImpl
 * construction (same two-phase init as progress events).
 *
 * When store is undefined, returns no-op stubs.
 */
export function wireWorkspaceSubscriptions(
  store: WorkspaceStore | undefined,
  agentId: string,
  traceWriter: TraceSink | undefined,
  /** Pre-built child provider. If it has setSubscribeHandler(), the handler is injected. */
  provider?: { setSubscribeHandler?: (h: ToolHandler) => void },
): WorkspaceSubscriptionWiring {
  if (store === undefined) {
    return {
      subscribeHandler: async () => ({ content: 'workspace_subscribe: no store available.', isError: true }),
      bindHandle: () => {},
    };
  }

  const handleRef: { current: SubagentHandleImpl<unknown> | undefined } = { current: undefined };

  const subscribeHandler: ToolHandler = async (input: unknown) => {
    if (handleRef.current === undefined) {
      return { content: 'workspace_subscribe: handle not yet initialized.', isError: true };
    }

    // Parse optional filter params
    const raw = (input != null && typeof input === 'object') ? input as Record<string, unknown> : {};
    const subjectFilter =
      typeof raw['subject'] === 'string' && raw['subject'].length > 0
        ? raw['subject']
        : undefined;
    const typeRaw = raw['type'];
    const VALID_TYPES = new Set(['finding', 'evidence', 'hypothesis', 'decision', 'artifact', 'status']);
    const typeFilter =
      typeof typeRaw === 'string' && VALID_TYPES.has(typeRaw)
        ? (typeRaw as WorkspaceEntryType)
        : undefined;

    const subscriptionId = generateSubscriptionId();

    // Register on the store. deliveryFn pushes raw WorkspaceEntry objects
    // to the handle's ring buffer (oldest-first eviction at cap).
    store.subscribe({
      id: subscriptionId,
      agentId,
      subject: subjectFilter,
      type: typeFilter,
      lastDeliveredSeq: 0,
      deliveryFn: (entry) => {
        const h = handleRef.current;
        if (h === undefined) return;
        let droppedCount = 0;
        if (h._pendingWorkspaceEntries.length >= WORKSPACE_DELIVERY_RING_CAPACITY) {
          h._pendingWorkspaceEntries.shift();
          droppedCount = 1;
          h._workspaceDroppedSinceDrain++;
        }
        h._pendingWorkspaceEntries.push(entry);
        // Witness trace: workspace_delivery (fire-and-forget)
        void emitSessionPhase(traceWriter, {
          phase: 'workspace_delivery',
          metadata: {
            subscriptionId,
            agentId,
            // Serialize entry id as a string to match SessionPhasePayload metadata type.
            entryId: String(entry.id),
            droppedCount,
          },
        });
      },
    });

    // Witness trace: workspace_subscribed (fire-and-forget)
    void emitSessionPhase(traceWriter, {
      phase: 'workspace_subscribed',
      metadata: {
        subscriptionId,
        agentId,
        ...(subjectFilter !== undefined && { query: subjectFilter }),
        ...(typeFilter !== undefined && { type: typeFilter }),
      },
    });

    return { content: JSON.stringify({ subscriptionId, active: true }) };
  };

  // Inject into pre-built provider if available (childProviderFactory path).
  if (provider?.setSubscribeHandler !== undefined) {
    provider.setSubscribeHandler(subscribeHandler);
  }

  return {
    subscribeHandler,
    bindHandle: (handle) => {
      handleRef.current = handle;
      // Thread the store reference so dispatchStopAndRelease can call
      // unsubscribeAll(agentId) on teardown without needing a separate closure.
      handle._workspaceStore = store;
    },
  };
}
