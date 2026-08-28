/**
 * Second half of {@link AnthropicDirectProvider.query}: build the cwd/prompt
 * re-anchoring factories and construct the {@link AnthropicDirectQuery}.
 *
 * Extracted verbatim from `provider-runtime.ts` (#824 split). Every option
 * spread and its guarding comment is preserved as written — the conditional
 * spreads are load-bearing (an explicit `undefined` is NOT the same as an
 * absent key for several of these options).
 *
 * @module agent/providers/anthropic-direct/provider-query-build
 */

import type { ProviderQuery, ProviderQueryArgs } from '../../provider.js';
import { AnthropicDirectQuery } from './query-runtime.js';
import {
  resolveAutoCompactThreshold,
  resolveEffort,
  resolveThinkingParam,
  resumeHistoryToMessages,
} from './resolve-params.js';
import { createCwdDependentsFactory } from './query/cwd-dependents.js';
import { createSystemPromptRebuildFactory } from './query/overlay-rebuild.js';
import type { ProviderQueryContext } from './provider-context.js';
import type { QuerySetupResult } from './provider-query-setup.js';

/** Construct the session query handle from the resolved setup. */
export function buildProviderQuery(
  ctx: ProviderQueryContext,
  args: ProviderQueryArgs,
  setup: QuerySetupResult,
): ProviderQuery {
  const config = args.config;
  const {
    client,
    authMode,
    localMode,
    model,
    maxTokens,
    cwd,
    systemPrefix,
    throttleQueue,
    tokenRefresher,
    queryDispatcher,
    runtimeStateSource,
    toolDefs,
    resolvedSessionId,
    stableSystemPrefix,
    toolSystemAppend,
  } = setup;

  // Invariant: this MUST be the same id the presence file advertises, so the
  // Telegram watcher tails the ledger this session actually writes. Sourced
  // from the single resolution performed inside wireQueryDispatcher (explicit
  // --resume id wins; top-level sessions get a memoized mint; forks stay
  // undefined so the query keeps minting its own id per call).
  // `opts.sessionId` feeds only `initSessionId` in query.ts — it gates no
  // resume behavior — so supplying a minted id here is inert apart from
  // making the id known earlier.
  const resumedSessionId = resolvedSessionId;
  const initialMessages = resumeHistoryToMessages(config.resumeHistory);
  // Seed the context-overflow guard from the last stored turn's token count
  // (#1294). The last turn of resumeHistory carries `inputTokens` when the
  // session was saved with a recent enough sidecar; absent on legacy sidecars.
  // Conservative: prefer over-estimate (triggers compaction) over under-estimate
  // (lets a full context reach the wire and get rejected with HTTP 400).
  const lastResumedTurn = config.resumeHistory?.at(-1);
  const initialUsageInputTokens = lastResumedTurn?.inputTokens;

  const cwdDependentsFactory = ctx.externalTools
    ? undefined
    : createCwdDependentsFactory({
        stableSystemPrefix,
        config,
        surface: ctx.surface,
        runtimeStateSource,
        getCurrentCwd: () => ctx.getCurrentCwd(),
        setCurrentCwd: (newCwd) => { ctx.setCurrentCwd(newCwd); },
        getCurrentPermissionMode: () => ctx.getCurrentPermissionMode(),
        sharedReadRoots: ctx.getSharedReadRoots(),
        sharedWriteRoots: ctx.getSharedWriteRoots(),
        subagentExecutor: ctx.subagentExecutor,
        skillExecutor: ctx.skillExecutor,
        composeExecutor: ctx.composeExecutor,
        buildDispatcher: (mode, opts) => ctx.buildDispatcher(mode, opts),
      });

  // Invariant: this factory MUST close over the SAME `stableSystemPrefix`
  // object passed to `createCwdDependentsFactory` above — not a copy. The
  // overlay rebuild writes the new base prompt back into that shared object
  // so a later `setCwd()` re-assembly inherits it instead of resurrecting the
  // launch-time prompt. See the Invariant block in query/overlay-rebuild.ts.
  // Gated on `externalTools` for the same reason the cwd factory is: those
  // callers own their own prompt/dispatcher lifecycle.
  const systemPromptRebuildFactory = ctx.externalTools
    ? undefined
    : createSystemPromptRebuildFactory({
        stableSystemPrefix,
        config,
        surface: ctx.surface,
        runtimeStateSource,
        getCurrentCwd: () => ctx.getCurrentCwd(),
        fallbackCwd: cwd,
      });

  const resolvedEffort = resolveEffort(config.effort, model);
  // Use requestedModel (the alias, e.g. sonnet_1m) rather than the resolved
  // wire id so safeAutoCompactThresholdFor sees the full 1M window when
  // the alias carries that budget. Extracted to avoid calling
  // resolveAutoCompactThreshold twice. (#1014 Item 3 & 4)
  const autoCompactThreshold = resolveAutoCompactThreshold(
    config.autoCompact,
    typeof config.model === 'string' && config.model.length > 0 ? config.model : model,
  );
  return new AnthropicDirectQuery({
    client,
    // In local-server mode, downgrade the effective auth mode to 'api-key'
    // so that per-request OAuth CLI-mimicry headers (anthropic-beta, x-app,
    // User-Agent, X-Claude-Code-Session-Id) are never sent to the shim.
    // The real authMode is still used above for client construction and
    // tokenRefresher — only the per-turn header emission is suppressed.
    authMode: localMode ? 'api-key' : authMode,
    promptStream: args.prompt,
    toolDispatcher: queryDispatcher,
    ...(resumedSessionId !== undefined ? { sessionId: resumedSessionId } : {}),
    ...(initialMessages !== undefined ? { initialMessages } : {}),
    ...(initialUsageInputTokens !== undefined ? { initialUsageInputTokens } : {}),
    model,
    // Preserve the requested alias (e.g. opus_1m) so context-window lookups
    // recover the 1M window. `model` above is the resolved wire id, which is
    // ambiguous between an alias and its 1M variant. Fall back to the wire id
    // when no distinct alias was supplied.
    requestedModel:
      typeof config.model === 'string' && config.model.length > 0 ? config.model : model,
    ...(config.permissionMode !== undefined
      ? { permissionMode: config.permissionMode }
      : {}),
    maxTokens,
    tools: toolDefs,
    userSystem: toolSystemAppend,
    systemPrefix,
    tokenRefresher,
    ...(config.thinking !== undefined
      ? { thinking: resolveThinkingParam(config.thinking, maxTokens, model) }
      : {}),
    ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
    ...(localMode ? { baseUrl: config.baseUrl } : {}),
    ...(config.traceWriter ? { traceWriter: config.traceWriter } : {}),
    ...(config.subagentId !== undefined ? { subagentId: config.subagentId } : {}),
    ...(config.autoResumeOnUsageLimit !== undefined
      ? { autoResumeOnUsageLimit: config.autoResumeOnUsageLimit }
      : {}),
    // Overload-pause surface gate (#762): reuse the EXISTING surface signal
    // (the same value stamped as `origin` on session_init_start) rather than
    // inventing a new one, so a daemon session fails fast on upstream capacity
    // while an interactive one may park briefly.
    //
    // Invariant: this reads `declaredSurface`, NEVER `surface`. `surface`
    // defaults to 'cli' for presence advertising, and every forked child is
    // constructed with no surface at all — so reading it would grant headless
    // children the interactive park this gate exists to deny them (#764).
    // `resolveOverloadPauseCeilingMs(undefined)` already means "fail fast".
    surface: ctx.declaredSurface,
    ...(config.maxToolUseIterations !== undefined
      ? { maxToolUseIterations: config.maxToolUseIterations }
      : {}),
    // TIME sibling of the round cap above — see shared/soft-deadline.ts. Armed
    // by the subagent fork site from its wall-clock budget; unset (the
    // top-level case, where a human owns the turn) means hard abort only.
    ...(config.softDeadlineMs !== undefined
      ? { softDeadlineMs: config.softDeadlineMs }
      : {}),
    ...(cwdDependentsFactory !== undefined ? { cwdDependentsFactory } : {}),
    ...(systemPromptRebuildFactory !== undefined ? { systemPromptRebuildFactory } : {}),
    // Path-approval half of the live `/bypass` toggle: keep the provider's
    // `_currentPermissionMode` (read by getGrants().allowAll) in sync with
    // the query handle's mode. The file-tool half is the dispatcher's
    // setAllowAll(), flipped inside the same setPermissionMode call.
    onPermissionMode: (mode: string) => {
      ctx.setCurrentPermissionMode(mode);
    },
    ...(ctx.mcpManager !== undefined ? { mcpManager: ctx.mcpManager } : {}),
    ...(autoCompactThreshold !== undefined ? { autoCompactThreshold } : {}),
    // Thread the resolved hook registry into the query so auto-compaction
    // can dispatch PreCompact(trigger:'auto') before calling compact().
    // resolveSessionHookRegistry is already called above for the dispatcher;
    // we reuse config.hookRegistry directly here — the query stores it
    // separately from the dispatcher and dispatches only PreCompact events.
    ...(config.hookRegistry !== undefined ? { hookRegistry: config.hookRegistry } : {}),
    // Live-throttle mailbox: the SAME instance wired to the client fetch
    // callback above, so the loop's consumer meets the fetch producer.
    ...(throttleQueue !== undefined ? { throttleQueue } : {}),
    ...(ctx.fastModeController !== undefined ? { fastModeController: ctx.fastModeController } : {}),
  });
}
