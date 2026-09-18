/**
 * Provider SDK lifecycle: provider selection, query construction, and
 * initialization-event polling, extracted from {@link AgentSession}.
 *
 * `buildProviderLifecycle()` replaces `AgentSession.initSdkLifecycle()`:
 * it selects the provider, builds the query + input-stream pair, resets
 * per-cycle mutable state, and returns the live objects AgentSession
 * assigns to its fields.
 *
 * `runInitialization()` replaces `AgentSession.pullInitialization()`:
 * it dispatches SessionStart, then drains the provider iterator until
 * `session.init` arrives (or an error).
 *
 * Neither function holds a reference to `AgentSession` — all write-back
 * is done by the caller through the returned objects and the
 * {@link InitCallbacks} context bag.
 *
 * @module agent/session/provider-lifecycle
 */

import { debugLog } from '../../utils/debug.js';
import { emitSessionPhase } from '../trace/emit.js';
import { resolveProvider, providerForModel } from '../providers/index.js';
import { ProviderRouter } from '../providers/router/provider-router.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import { dispatchSessionStart } from './hooks-dispatch.js';
import { HookBlockedError } from '../../utils/errors.js';
import { transformProviderEvent } from './stream-consumer.js';
import { buildInitialState } from './session-setup.js';
import { SessionStateManager } from './session-state.js';
import { resolveModelId } from './model-resolution.js';
import { setSlotBindings } from './model-slots.js';
import { applySlotCredentials } from './slot-credentials.js';
import { QueryInputStream } from './input-iterable.js';
import type { AccountingAccumulator } from './accounting-accumulator.js';
import type { SessionShutdown } from './session-shutdown.js';
import type { AgentConfig } from '../types.js';
import type { ProviderQuery, ProviderEvent } from '../provider.js';
import type { HookRegistry } from '../hooks.js';
import type { TransformDeps } from './stream-consumer.js';

/** Objects returned by {@link buildProviderLifecycle} for the caller to apply. */
export interface ProviderLifecycleResult {
  stateManager: SessionStateManager;
  inputStream: QueryInputStream;
  providerQuery: ProviderQuery;
  providerIterator: AsyncIterator<ProviderEvent>;
}

/**
 * Build (or rebuild) the SDK-side plumbing: session-state manager, input
 * stream, provider query, and the event iterator. Corresponds to the body of
 * `AgentSession.initSdkLifecycle()`.
 *
 * The caller resets accounting, sessionEndDispatched, currentState,
 * turnCount, lastResponseMetadata, conversationHistory, and
 * pendingFrameworkContext after this returns (those fields belong to
 * AgentSession, not here).
 */
export function buildProviderLifecycle(config: AgentConfig): ProviderLifecycleResult {
  // Safety net for direct construction (library/test) that bypasses
  // `loadConfig()`: install caller-provided slot bindings process-globally
  // so `resolveModelId`/`resolveProvider` resolve tier aliases.
  if (config.models) setSlotBindings(config.models);

  // Apply the resolved model's per-slot provider credentials onto this
  // session's config so the active provider reads them at query time.
  applySlotCredentials(config);

  const resolvedModel = resolveModelId(config.model) ?? (config.model as string);
  const { sessionIdentity, metadata } = buildInitialState(config, resolvedModel);

  const stateManager = new SessionStateManager(sessionIdentity, metadata);
  const inputStream = new QueryInputStream(() => stateManager.getSessionId());

  const promptIterable = inputStream.createIterable();
  let providerQuery: ProviderQuery;

  if (config.provider) {
    debugLog(
      `🟢 AgentSession: Creating query session via injected provider=${config.provider.name}`,
    );
    providerQuery = config.provider.query({ prompt: promptIterable, config });
  } else {
    debugLog(`🟢 AgentSession: Creating query session via ProviderRouter`);
    // When config.providerFactory is set, use it as resolveProvider so every
    // provider built during a cross-family /model swap is fully wired (with
    // subagentExecutor, skillExecutor, composeExecutor, memoryStore,
    // mcpManager, and permission lists). When absent, fall back to the bare
    // resolveProvider which is suitable for one-shot and test paths.
    const resolveProviderFn = config.providerFactory
      ? config.providerFactory
      : (m: string | undefined) =>
          resolveProvider(m, undefined, {
            customTools: config.customTools,
            canUseTool: config.canUseTool,
          });
    providerQuery = new ProviderRouter(
      { prompt: promptIterable, config },
      {
        resolveProvider: resolveProviderFn,
        providerNameForModel: (m) => providerForModel(m),
        resolveApiKey: (m) => resolveCredentialForModel(m),
      },
    );
  }

  const iterable = providerQuery as AsyncIterable<ProviderEvent>;
  const providerIterator = iterable[Symbol.asyncIterator]();

  return { stateManager, inputStream, providerQuery, providerIterator };
}

/**
 * Pull events from the provider iterator until `session.init` arrives.
 * Dispatches the SessionStart hook first (may block init on HookBlockedError).
 *
 * Corresponds to `AgentSession.pullInitialization()`.
 */
export async function runInitialization(
  config: AgentConfig,
  providerIterator: AsyncIterator<ProviderEvent>,
  abortSignal: AbortSignal,
  stateManager: SessionStateManager,
  accounting: AccountingAccumulator,
  shutdown: SessionShutdown,
  hookRegistry: HookRegistry | undefined,
  queueFrameworkContext: (text: string) => void,
  buildTransformDeps: () => TransformDeps,
): Promise<void> {
  try {
    const sessionStartInjectContext = await dispatchSessionStart(
      hookRegistry,
      {
        event: 'SessionStart',
        sessionId: stateManager.getSessionId(),
        parentSessionId: config.parentSessionId,
      },
      {
        signal: abortSignal,
        ...(config.traceWriter ? { traceWriter: config.traceWriter } : {}),
      },
    );
    // Invariant: queue SessionStart injectContext HERE — before the init loop
    // resolves initPromise. `sendMessageStreamInternal` awaits initPromise
    // before draining the queue, so this context rides the session's FIRST
    // outbound user message.
    //
    // Parent-only: subagent forks run this same init path with the bubbled
    // hook registry, so an unconditional queue would prepend session-priming
    // context to EVERY subagent's first prompt. Gate on parentSessionId so
    // only the parent session delivers it.
    if (sessionStartInjectContext && config.parentSessionId === undefined) {
      queueFrameworkContext(sessionStartInjectContext);
    }

    while (true) {
      const result = await providerIterator.next();
      if (result.done) {
        stateManager.resolveInitializationIfNeeded();
        return;
      }
      const event = result.value;
      const output = transformProviderEvent(event, buildTransformDeps());
      if (event.type === 'session.init') {
        // Witness layer: mark end of init phase with wall-clock duration.
        // MUST be awaited — initPromise resolves inside transformProviderEvent
        // (line above) so any code awaiting initPromise is already runnable.
        // A void/fire-and-forget call here yields a microtask gap in which
        // sendMessageStreamInternal can advance the shared providerIterator
        // before pullInitialization returns, causing two concurrent consumers
        // on the same iterator and silently swallowing the first user
        // message's response.
        await emitSessionPhase(config.traceWriter, {
          phase: 'session_init_done',
          durationMs: Date.now() - accounting.sessionStartedAt,
        });
        return;
      }
      if (output && output.type === 'error') {
        // Terminal-cause flag: an init-phase provider error must not seal as
        // a clean close.
        accounting.markProviderError();
        return;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error instanceof HookBlockedError) {
      accounting.markHookBlocked();
    }
    if (!stateManager.isInitializationSettled()) {
      stateManager.rejectInitializationOnce(error);
    }
    await shutdown.dispatchOnce('error').catch(() => {});
  }
}
