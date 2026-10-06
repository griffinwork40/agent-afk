import { MemoryStore } from '../../../agent/memory/index.js';
import { StateStore } from '../../../agent/state/state-store.js';
import { getStateDatabasePath } from '../../../paths.js';
import { WorkspaceStore } from '../../../agent/workspace/workspace-store.js';
import { env } from '../../../config/env.js';
import { registerSurfaceSession } from '../../../agent/session/register-surface-session.js';
import { runReplReconcile } from '../../../agent/manifest/startup-reconcile.js';
import type { SlashContext } from '../../slash/types.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { CliOptions, InteractiveCtx } from './shared.js';
import { ContextSampler } from '../../context-sampler.js';
import { ensurePluginEntrypointsLoaded } from '../../../agent/tools/skill-bridge.js';
import { installPluginHooks } from '../../../agent/plugins/load-entrypoints.js';
import { emitSessionPhase } from '../../../agent/trace/emit.js';
import { wireSessionSidebands } from './bootstrap-sidebands.js';
import { createResumeRequest } from './bootstrap-resume.js';
import { resolveBootstrapConfig } from './bootstrap-config.js';
import { createBootstrapInfra } from './bootstrap-infra.js';
import { connectReplMcp } from './bootstrap-mcp.js';
import { createReplProviders } from './bootstrap-providers.js';
import { createReplSurface } from './bootstrap-surface.js';
import { createReplHookRegistry } from './bootstrap-hooks.js';
import { createReplSlashContext } from './bootstrap-slash-context.js';
import { wireTrustedSkillEvents, wireProviderGrants, createReplInput, createTurnBridgeRefs } from './bootstrap-wiring.js';
import { buildAgentSession, buildSharedDeps } from './bootstrap-session-builder.js';
import { registerAll } from '../../slash/index.js';
import { setTasksIctx } from '../../slash/commands/tasks.js';

// Re-exported so `resume-swap.test.ts` (and the mid-session swap closure
// below) can resolve `buildAgentSession` from this module — the historical
// import path every existing caller uses.
export { buildAgentSession } from './bootstrap-session-builder.js';

/**
 * Load plugin JS entrypoints and install their hook declarations onto an
 * already-built session registry. Extracted from {@link bootstrapSession} to
 * keep that function within its baselined line-count ceiling.
 *
 * Import any plugin JS entrypoints (manifest `main`) before constructing the
 * session: the skill manifest is assembled synchronously in the constructor,
 * so a plugin's registerSkill() side-effects must already have run for its
 * code-backed skills to appear. Idempotent + non-fatal; no-op without plugins.
 *
 * Idempotent: {@link ensurePluginEntrypointsLoaded} is process-scoped and
 * skips already-loaded entrypoints. {@link installPluginHooks} is safe to
 * call multiple times — the REPL registry is constructed before plugin
 * activation, so hooks are applied retroactively here.
 */
async function activatePluginEntrypoints(hookRegistry: Parameters<typeof installPluginHooks>[0]): Promise<void> {
  await ensurePluginEntrypointsLoaded();
  installPluginHooks(hookRegistry);
}

/**
 * Build the session context from CLI options. Throws with a user-facing
 * message when option parsing fails — caller is responsible for spinner
 * teardown, exit code, and draining any `extras.bootWarnings` it supplied
 * (warnings pushed before the throw never reach the returned ctx).
 *
 * Side effects: constructs an SDK AgentSession (opens a subprocess),
 * registers slash commands, creates a non-terminal readline interface on
 * stdin/stdout. Does NOT register cleanup — the caller owns cleanup order
 * so teardown remains auditable in one place.
 */
export async function bootstrapSession(
  options: CliOptions,
  extras?: { cwd?: string; bootWarnings?: string[] },
): Promise<InteractiveCtx> {
  // Capture bootstrap entry time before the trace writer exists.
  const bootstrapStartedAt = Date.now();

  const {
    resumeTarget, resumeConfig, effectiveCwd, sessionModel,
    thinking, effort, maxOutputTokens, maxToolUseIterations,
    basePrompt, systemPrompt, systemPromptSource, cliConfig,
  } = resolveBootstrapConfig(options, extras);

  // Deferred parent proxy reads through sessionRef across mid-session swaps.
  const sessionRef: SessionRef = { current: null! };

  // Bootstrap warnings that must outlive the startup screen clear. Everything
  // written to stdout/stderr from here until `interactive.ts` finishes clearing
  // is destroyed — `\x1b[3J` erases scrollback, not just the viewport — so
  // producers accumulate into this bucket and `interactive.ts` drains it after
  // the clear. See `InteractiveCtx.bootWarnings` (#745).
  //
  // Adopted from the caller when supplied, because this function can throw
  // AFTER producers have pushed (`McpManager.fromConfig` below rejects for an
  // `alwaysLoad` server that fails to connect) and a thrown bootstrap returns
  // no ctx to drain — the warnings would be silently destroyed. The REPL passes
  // its own array so its catch block can still print them. Callers that don't
  // care get a local bucket and the prior behaviour.
  const bootWarnings: string[] = extras?.bootWarnings ?? [];

  const sharedWorkspaceStore = env.AFK_WORKSPACE_DISABLED === '1' ? undefined : new WorkspaceStore();
  const sharedMemoryStore = new MemoryStore();
  const sharedStateStore = new StateStore(getStateDatabasePath());

  const {
    trace, backgroundRegistry, detachRegistry, processJobs, bgSummarizer,
    rootManager, subagentExecutor, skillExecutor, composeExecutor,
  } = createBootstrapInfra({
    sessionRef, options, cliConfig, sessionModel, basePrompt, effectiveCwd, resumeTarget, bootWarnings,
    workspaceStore: sharedWorkspaceStore,
  });
  const { FastModeController } = await import('../../../agent/fast-mode.js');
  const fastModeController = new FastModeController();

  // MCP — load `~/.afk/config/mcp.json` and connect every enabled server
  // BEFORE provider construction so the provider sees the MCP-bridged
  // tools in its initial schema set. The manager is also persisted on
  // `InteractiveCtx` so `interactive.ts` can call `disconnectAll()` during
  // teardown (ordered: subagents → session → mcpManager → memory → worktree).
  const mcpManager = await connectReplMcp({
    effectiveCwd,
    mcpConfigOverride: options.mcpConfig,
    traceWriter: trace?.writer,
    bootWarnings,
  });

  // Build a fully-wired provider factory that the ProviderRouter calls to
  // resolve the active provider. Must run AFTER MCP connect — the factory's
  // builder closes over `mcpManager`.
  const { providerFactory, startupProvider } = createReplProviders({
    options, cliConfig, sessionModel, subagentExecutor, skillExecutor, composeExecutor,
    memoryStore: sharedMemoryStore, stateStore: sharedStateStore, workspaceStore: sharedWorkspaceStore, mcpManager, fastModeController,
  });

  // Stats, permission/thinking-UI seeding, startup banners (`trace:` /
  // `↪ resuming in` — preserving the `mcp:` → `trace:` → `↪ resuming in`
  // console-output order), StatusLine/renderer/writer, trusted-skill ledger,
  // and git-status sampler.
  const {
    stats, initialPermissionMode, completionWriter, statusLine, replRenderer,
    writer, trustedSkillLedger, gitStatusSampler,
  } = createReplSurface({
    options, cliConfig, sessionModel, resumeTarget, effectiveCwd, extrasCwd: extras?.cwd, trace,
  });

  // Stable hookRegistry shared across sessions (including swaps), plus the
  // terminal-state Stop gate registered on top of it.
  const { hookRegistry, addPreviewDiffRef, setTranscriptPathGetter } = createReplHookRegistry({
    completionWriter, memoryStore: sharedMemoryStore, stateStore: sharedStateStore, stats, effectiveCwd, traceWriter: trace?.writer,
  });

  // Mutable refs bridging per-turn renderer state back to the session context
  // (issues #1505 and #1506 — see bootstrap-wiring.ts for field docs).
  const { bashTailSetter, capturePathRef } = createTurnBridgeRefs();
  const bashOutputTailReporter = (toolUseId: string) => {
    return (tail: string | undefined) => { bashTailSetter.current?.(toolUseId, tail); };
  };

  // Capture deps needed by both the initial build and the swap closure.
  const sharedDeps = buildSharedDeps({
    sessionModel, resumeConfig, systemPrompt, systemPromptSource, thinking, effort,
    maxOutputTokens, maxToolUseIterations, cliConfig, providerFactory, hookRegistry,
    traceWriter: trace?.writer, effectiveCwd, maxTurns: options.maxTurns, initialPermissionMode,
    bashOutputTailReporter,
    // #2542/#2735: Detach registry shared between REPL Ctrl+B handler and
    // every per-query dispatcher for this session.
    detachRegistry, processJobs,
    // Cascade-abort and drain in-flight children before the writer seals,
    // so a wave still running when this session ends emits real `cancelled`
    // rows instead of vanishing (#733).
    drainSubagents: (reason) =>
      rootManager.abortAllAndDrain('session_end', 'user_signal', undefined, reason === 'reset'),
    ...(options.provider !== undefined ? { explicitProvider: options.provider } : {}),
  });

  await activatePluginEntrypoints(hookRegistry);

  const session = buildAgentSession(sharedDeps);
  // Populate sessionRef (declared above deferredParent so the proxy works).
  sessionRef.current = session;

  // Wave-manifest reconciliation: surface resumption offers for unfinished work
  // from prior sessions. Fire-and-forget — never blocks session startup.
  runReplReconcile(session.sessionId ?? '');

  registerReplSession(session, sharedDeps, resumeTarget?.stored?.sessionId);

  wireSessionSidebands(sessionRef, rootManager, composeExecutor, backgroundRegistry);

  // Resume rebinds the sampler source and resets its cache.
  const contextSampler = new ContextSampler(session);

  const maxTurnsNum = parseInt(options.maxTurns, 10);
  const slashCtx: SlashContext = createReplSlashContext({
    sessionRef, stats, writer, statusLine, contextSampler, gitStatusSampler,
    ledger: trustedSkillLedger, mcpManager, fastModeController,
    ...(cliConfig.baseUrl !== undefined ? { anthropicBaseUrl: cliConfig.baseUrl } : {}),
    ...(cliConfig.openaiBaseUrl !== undefined ? { openaiBaseUrl: cliConfig.openaiBaseUrl } : {}),
    ...(options.provider !== undefined ? { explicitProvider: options.provider } : {}),
    ...(maxTurnsNum > 0 ? { maxTurns: maxTurnsNum } : {}),
  });

  const requestResume = createResumeRequest(
    () => ctx, sessionRef, sharedDeps,
    { subagentExecutor, skillExecutor, composeExecutor, rootManager, backgroundRegistry },
    () => trustedSkillLedger.clear(), maxTurnsNum,
  );

  // Build the ctx object first (so requestResume can close over it for
  // getInFlight and resumeTarget mutation), then wire requestResume in.
  const ctx: InteractiveCtx = {
    session: sessionRef,
    memoryStore: sharedMemoryStore,
    stateStore: sharedStateStore,
    stats,
    statusLine,
    contextSampler,
    gitStatusSampler,
    completionWriter,
    replRenderer,
    bashTailSetter,
    capturePathRef,
    slashCtx,
    rl: null!,  // overwritten below
    options,
    ...(resumeTarget !== undefined ? { resumeTarget } : {}),
    teardownTrustedSkillEvents: undefined,  // wired below
    // Same array the producers above pushed into — drained post-clear by
    // interactive.ts. Passed by reference so a late producer (anything between
    // here and `return ctx`) still lands.
    bootWarnings,
    backgroundRegistry, ...(trace?.writer !== undefined ? { traceWriter: trace.writer } : {}),
    subagentManager: rootManager,
    // Expose the root executor's narrow promotion seam so the turn handler can
    // make Ctrl+B background a running foreground subagent. The executor
    // implements `SubagentControl`; the keyboard layer sees only that interface.
    subagentControl: subagentExecutor,
    // #2542/#2735: Detach registry shared with every per-query dispatcher so
    // Ctrl+B can free the model's turn while a bash process keeps running.
    detachRegistry, processJobs,
    ...(bgSummarizer !== undefined ? { bgSummarizer } : {}),
    requestResume,
    // Default to false so any code path that reads getInFlight before
    // interactive.ts overrides it (e.g. an early /resume call triggered
    // in a firstTurnHook) does not accidentally see undefined and
    // misclassify the in-flight state.
    getInFlight: () => false,
    ...(mcpManager !== undefined ? { mcpManager } : {}),
    // The session credential (`apiKey`) is deliberately NOT threaded to the
    // ghost-text suggest engine: its model may belong to another provider, so
    // it resolves its own credential per suggestion model
    // (src/cli/input/suggest-credential.ts).
    // Mirror the main session's OpenAI-compatible endpoint: the suggest engine
    // forwards `suggestBaseUrl` as an `openaiBaseUrl` provider hint
    // (suggest.ts:355), and parseProvider above (line 352) wires the live
    // session from `cliConfig.openaiBaseUrl` — NOT `cliConfig.baseUrl` (that is
    // the distinct Anthropic-shim endpoint, config.ts:48 vs :59). Using
    // openaiBaseUrl here keeps side-channel completions on the same local/proxy
    // endpoint the session uses instead of falling back to api.openai.com.
    ...(cliConfig.openaiBaseUrl !== undefined ? { suggestBaseUrl: cliConfig.openaiBaseUrl } : {}),
    ...(cliConfig.interactive?.suggestGhost !== undefined
      ? { suggestGhostConfig: cliConfig.interactive.suggestGhost }
      : {}),
    hookRegistry,
    addPreviewDiffRef,
  };

  finishBootstrapWiring(ctx, trustedSkillLedger, startupProvider, setTranscriptPathGetter, bootstrapStartedAt);

  return ctx;
}

/** Best-effort process-scoped cross-surface registration. */
function registerReplSession(
  session: ReturnType<typeof buildAgentSession>,
  sharedDeps: ReturnType<typeof buildSharedDeps>,
  sdkSessionId: string | undefined,
): void {
  // Step 7: register this REPL session in the cross-surface session registry so
  // it appears alongside Telegram/daemon sessions. Best-effort (never throws).
  // Process-scoped — the in-memory registry dies with the REPL — so no dispose
  // is wired here (unlike the long-running daemon, which archives on close).
  registerSurfaceSession(session, {
    surface: 'cli',
    model: sharedDeps.model,
    ...(sharedDeps.cwd !== undefined ? { cwd: sharedDeps.cwd } : {}),
    ...(sdkSessionId !== undefined
      ? { sdkSessionId }
      : {}),
  });

}
/** Install the surface callbacks only after ctx and slash commands exist. */
function finishBootstrapWiring(
  ctx: InteractiveCtx,
  trustedSkillLedger: ReturnType<typeof createReplSurface>['trustedSkillLedger'],
  startupProvider: ReturnType<typeof createReplProviders>['startupProvider'],
  setTranscriptPathGetter: ReturnType<typeof createReplHookRegistry>['setTranscriptPathGetter'],
  bootstrapStartedAt: number,
): void {
  // Trusted-skill event subscriptions — emit in-flight + completion badges
  // inline at the invocation point via completionWriter (routed to
  // compositor.commitAbove during a live turn; falls back to console.log
  // outside a turn). Recorded in the ledger on completion.
  ctx.teardownTrustedSkillEvents = wireTrustedSkillEvents(ctx.completionWriter, trustedSkillLedger);

  registerAll();

  // Wire the InteractiveCtx into /tasks so viewingTaskId is set correctly
  // when the user opens a task view (#1332).
  setTasksIctx(ctx);

  // Wire /allow-dir to the startup provider's grant API so the slash command
  // can mutate read/write roots across turns. Must run AFTER registerAll()
  // (ordering hazard: the dispatcher setter is itself a slash-command module
  // side effect target).
  wireProviderGrants(startupProvider);

  const { rl, inputSurfaceRef } = createReplInput();
  ctx.rl = rl;
  ctx.inputSurfaceRef = inputSurfaceRef;

  // Wire requestResume into slashCtx so slash commands can call it.
  ctx.slashCtx.requestResume = ctx.requestResume;
  ctx.setTranscriptPathGetter = setTranscriptPathGetter;
  // Witness layer: bootstrap complete — emit the done marker with the full
  // span measured from function entry (covers config load, manager + writer
  // construction, MCP connect, provider + session build).
  void emitSessionPhase(ctx.traceWriter, {
    phase: 'bootstrap_done',
    durationMs: Date.now() - bootstrapStartedAt,
  });

}
