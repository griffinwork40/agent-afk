/**
 * Provider SDK lifecycle: provider selection, query construction, and
 * initialization-event polling, extracted from {@link AgentSession}.
 *
 * `buildProviderLifecycle()` replaces `AgentSession.initSdkLifecycle()`:
 * it selects the provider, builds the query + input-stream pair, resets
 * per-cycle mutable state, and returns the live objects AgentSession
 * assigns to its fields.
 *
 * `ProviderInitializer` replaces the 9-parameter `runInitialization()`:
 * stable per-session deps are captured in the constructor; the per-cycle
 * volatile accessors are passed to {@link ProviderInitializer.run}. This
 * collapses the 9-argument call site to a constructor + a 3-argument
 * method call.
 *
 * Neither class nor function holds a reference to `AgentSession` — all
 * write-back is done through the returned objects and accessor callbacks.
 *
 * @module agent/session/provider-lifecycle
 */

import { debugLog } from '../../utils/debug.js';
import { emitSessionPhase } from '../trace/emit.js';
import { isReducedToolSurface, resolveSurfaceInputs } from './sdk-surface-warning.js';
import { emitSessionIdAssigned } from './session-id-trace.js';
import { resolveProvider, providerForModel } from '../providers/index.js';
import { ProviderRouter } from '../providers/router/provider-router.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import { dispatchSessionStart } from './hooks-dispatch.js';
import { HookBlockedError, ensureError} from '../../utils/errors.js';
import { buildMcpFailureNotice } from '../mcp/failure-notice.js';
import type { McpServerStateLike } from '../mcp/failure-notice.js';
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
import type { ProviderQuery, ProviderEvent, ProviderUserTurn } from '../provider.js';
import type { HookRegistry } from '../hooks.js';
import type { TransformDeps } from './stream-consumer.js';

/** Objects returned by {@link buildProviderLifecycle} for the caller to apply. */
export interface ProviderLifecycleResult {
  stateManager: SessionStateManager;
  inputStream: QueryInputStream;
  providerQuery: ProviderQuery;
  providerIterator: AsyncIterator<ProviderEvent>;
}

/** Objects returned by {@link rebuildProviderQuery}. */
export interface ProviderQueryResult {
  providerQuery: ProviderQuery;
  providerIterator: AsyncIterator<ProviderEvent>;
}

/**
 * Rebuild only the provider query + iterator for a new config, reusing an
 * existing `promptIterable` from the live `QueryInputStream`.
 *
 * Used by Phase 2 of `buildSessionInitPromise` (#4063) so the rebuilt
 * provider reads from the same input stream that `sendMessage` pushes to.
 * Creating a fresh `QueryInputStream` here would discard the Phase-1 stream
 * and leave `AgentSession.inputStream` feeding a provider that is never read.
 */
export function rebuildProviderQuery(
  config: AgentConfig,
  promptIterable: AsyncIterable<ProviderUserTurn>,
): ProviderQueryResult {
  let providerQuery: ProviderQuery;
  if (config.provider) {
    providerQuery = config.provider.query({ prompt: promptIterable, config });
  } else {
    const resolveProviderFn = config.providerFactory
      ? config.providerFactory
      : (m: string | undefined) =>
          resolveProvider(m, undefined, {
            customTools: config.customTools,
            canUseTool: config.canUseTool,
            ...(config.executors !== undefined ? { executors: config.executors } : {}),
            ...(config.mcpManager !== undefined ? { mcpManager: config.mcpManager } : {}),
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
  return { providerQuery, providerIterator: iterable[Symbol.asyncIterator]() };
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

  const stateManager = new SessionStateManager(
    sessionIdentity,
    metadata,
    // Emit a session_id_assigned trace event each time the provider-issued
    // session id first becomes known or changes (e.g. resumed/forked session).
    // Fire-and-forget: the callback must never propagate errors into
    // updateSessionIdentity — see SessionStateManager for the try/catch.
    (sid, prior) => void emitSessionIdAssigned(config.traceWriter, sid, prior),
  );
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
            // #3442: opt-in executors ride along on every provider the router
            // builds, including ones rebuilt by a cross-family model swap.
            ...(config.executors !== undefined ? { executors: config.executors } : {}),
            // #4063: forward the resolved MCP manager (caller-supplied or
            // SDK-built from config.mcpServers) so MCP tools are bridged and
            // mcpServerStatus() returns the live server states.
            ...(config.mcpManager !== undefined ? { mcpManager: config.mcpManager } : {}),
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
 * Drives the provider iterator until `session.init` arrives.
 *
 * Stable per-session deps are captured in the constructor. Per-cycle
 * volatile accessors (which depend on objects rebuilt by
 * `initSdkLifecycle`) are passed to {@link run}.
 *
 * This class replaces the original 9-parameter `runInitialization()`
 * free function, collapsing its call site from 9 arguments to a
 * constructor + a 3-argument `run()` call.
 */
export class ProviderInitializer {
  constructor(
    private readonly config: AgentConfig,
    private readonly abortSignal: AbortSignal,
    private readonly accounting: AccountingAccumulator,
    private readonly shutdown: SessionShutdown,
    private readonly hookRegistry: HookRegistry | undefined,
    private readonly queueFrameworkContext: (text: string) => void,
    /**
     * Live accessor for MCP server states. When one or more servers are in
     * `error` state, a framework context notice is queued at session init so
     * the model's FIRST turn already knows which servers are down and why
     * (#4064). Optional for backwards compat — callers that don't wire an
     * McpManager leave this undefined and no notice is injected.
     */
    private readonly getMcpServerStates?: () => readonly McpServerStateLike[],
  ) {}

  /**
   * Dispatches SessionStart, then drains the provider iterator until
   * `session.init` arrives (or an error).
   *
   * @param getProviderIterator - Returns the current (per-cycle) iterator.
   * @param buildTransformDeps  - Returns the current transform-dep snapshot.
   * @param stateManager        - The current per-cycle state manager.
   */
  async run(
    getProviderIterator: () => AsyncIterator<ProviderEvent>,
    buildTransformDeps: () => TransformDeps,
    stateManager: SessionStateManager,
  ): Promise<void> {
    try {
      // Perf (#3737): skip SessionStart dispatch entirely for forked children.
      //
      // Previously the registry fired for every fork (shared hookRegistry),
      // running all handlers — including expensive config-driven shell hooks
      // (e.g. jev rule-digest, ~4.7 KB) — only to have the merged
      // injectContext discarded at the `parentSessionId === undefined` guard
      // below.  Forked children inherit the same registry as the root session
      // but must NOT receive root-only nudge context (skill-routing hints,
      // forge briefs, prior-session bridge, pattern-card summaries).  Skipping
      // dispatch entirely removes the shell-hook overhead and the discarded
      // context budget in one step, with no behaviour change for root sessions.
      //
      // Handlers that govern edits tree-wide (path-approval, bash-restriction,
      // safe-destruct, etc.) are registered on PreToolUse, PostToolUse, and
      // SubagentStop — not on SessionStart — so they are unaffected.
      const isForkedChild = this.config.parentSessionId !== undefined;
      const sessionStartInjectContext = isForkedChild
        ? undefined
        : await dispatchSessionStart(
            this.hookRegistry,
            {
              event: 'SessionStart',
              sessionId: stateManager.getSessionId(),
              parentSessionId: this.config.parentSessionId,
            },
            {
              signal: this.abortSignal,
              ...(this.config.traceWriter ? { traceWriter: this.config.traceWriter } : {}),
            },
          );
      // Invariant: queue SessionStart injectContext HERE — before the init loop
      // resolves initPromise. `sendMessageStreamInternal` awaits initPromise
      // before draining the queue, so this context rides the session's FIRST
      // outbound user message.
      //
      // Root-only: forked children skip dispatch above, so this is now also
      // unreachable for forks. The guard is kept for clarity and defence-in-depth.
      if (sessionStartInjectContext && !isForkedChild) {
        this.queueFrameworkContext(sessionStartInjectContext);
      }

      // #4064: MCP failure notice — queued once at session init so the model's
      // first turn already knows which configured servers are unavailable and
      // why, preventing hallucinated causes. Emitted after SessionStart context
      // so hook-injected nudges take precedence. Skipped for forked children
      // (same guard as SessionStart dispatch above) — failures are a root-session
      // concern; children see errors through their own unknown-tool messages.
      if (!isForkedChild && this.getMcpServerStates !== undefined) {
        const mcpNotice = buildMcpFailureNotice(this.getMcpServerStates());
        if (mcpNotice !== undefined) {
          this.queueFrameworkContext(mcpNotice);
        }
      }

      while (true) {
        const result = await getProviderIterator().next();
        if (result.done) {
          stateManager.resolveInitializationIfNeeded();
          return;
        }
        const event = result.value;
        // Invariant (#3442): stamp reducedToolSurface BEFORE transformProviderEvent,
        // which resolves initPromise on session.init; stamping afterwards races
        // waitForInitialization() callers. The init updater spreads `prev`, so the
        // flag survives. Init metadata carries empty skills/tools, hence
        // resolveSurfaceInputs (registry + executor wiring). The stderr warning is
        // deferred to the first turn (session-send.ts) so probes stay quiet.
        if (event.type === 'session.init') {
          const surface = resolveSurfaceInputs(this.config, { skills: event.info.skills ?? [], tools: event.info.tools ?? [] });
          if (isReducedToolSurface(surface)) {
            stateManager.setSessionMetadata((prev) => ({ ...prev, reducedToolSurface: true }));
          }
        }
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
          await emitSessionPhase(this.config.traceWriter, {
            phase: 'session_init_done',
            durationMs: Date.now() - this.accounting.sessionStartedAt,
          });
          return;
        }
        if (output && output.type === 'error') {
          // Terminal-cause flag: an init-phase provider error must not seal as
          // a clean close.
          this.accounting.markProviderError();
          return;
        }
      }
    } catch (err) {
      const error = ensureError(err);
      if (error instanceof HookBlockedError) {
        this.accounting.markHookBlocked();
      }
      if (!stateManager.isInitializationSettled()) {
        stateManager.rejectInitializationOnce(error);
      }
      await this.shutdown.dispatchOnce('error').catch(() => {});
    }
  }
}
