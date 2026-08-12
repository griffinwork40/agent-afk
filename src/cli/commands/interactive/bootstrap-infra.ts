import type { SessionRef } from '../../../agent/session-ref.js';
import {
  explicitProviderHints,
  getApiKeyForModel,
  getModel,
  getDefaultSubagentModel,
} from '../../shared-helpers.js';
import type { CliConfig } from '../../config.js';
import { wireExecutors } from '../../../agent/session/wire-executors.js';
import type { SubagentExecutor } from '../../../agent/tools/subagent-executor.js';
import type { SkillExecutor } from '../../../agent/tools/skill-executor.js';
import type { ComposeExecutor } from '../../../agent/tools/compose-executor.js';
import type { SubagentManager } from '../../../agent/subagent.js';
import { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import { BackgroundSummarizer } from '../../../agent/background-summarizer.js';
import { setBgsubRegistry, setBgsubSummarizer } from '../../slash/commands/bgsub.js';
import { createDefaultTraceWriter } from '../../../agent/trace/factory.js';
import { emitSessionPhase } from '../../../agent/trace/emit.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import type { CliOptions } from './shared.js';
import { recordBootWarning } from './boot-warning-recorder.js';

/** Wired infra bundle returned by {@link createBootstrapInfra}. */
export interface BootstrapInfra {
  trace: ReturnType<typeof createDefaultTraceWriter>;
  apiKey: string | undefined;
  backgroundRegistry: BackgroundAgentRegistry;
  bgSummarizer: BackgroundSummarizer | undefined;
  rootManager: SubagentManager;
  subagentExecutor: SubagentExecutor;
  skillExecutor: SkillExecutor;
  composeExecutor: ComposeExecutor;
}

/**
 * Construct the witness trace writer, the background-agent registry (+
 * optional summarizer), the deferred-parent proxy, and the `agent`/`skill`/
 * `compose` executor trio (via {@link wireExecutors}).
 *
 * Ordering invariants preserved from the original inline sequence:
 *   1. `trace` is opened BEFORE `BackgroundAgentRegistry` and BEFORE
 *      `wireExecutors` — the root manager inherits the writer (fork lifecycle
 *      events depend on that inheritance), and `bootstrap_start` fires only
 *      once the writer exists.
 *   2. `deferredParent` reads through `a.sessionRef.current` (never captures
 *      `session` by value) so a mid-session `/resume` swap — which mutates
 *      `sessionRef.current` — stays transparent to every child executor that
 *      holds this proxy.
 *   3. `bootWarnings` is the SAME array instance the caller owns — never
 *      copied — so `agentRegistryWarn` pushes are visible to the caller after
 *      this function returns (and even if a later phase throws).
 */
export function createBootstrapInfra(a: {
  sessionRef: SessionRef;
  // Unused in this phase's own body today — kept on the signature to match
  // the extraction contract (every phase receives the full options bag) and
  // to avoid a signature change if a future option needs to reach this phase.
  options: CliOptions;
  cliConfig: CliConfig;
  sessionModel: string;
  basePrompt: string | undefined;
  effectiveCwd: string | undefined;
  resumeTarget: ResolvedResumeTarget | undefined;
  bootWarnings: string[];
}): BootstrapInfra {
  // Witness layer: open trace BEFORE the root SubagentManager and the
  // executor so (a) the manager inherits the writer — the `agent`-tool path
  // relies on manager-level inheritance for its forks' lifecycle events
  // (see forkSubagent's effectiveTraceWriter) — and (b) the
  // BackgroundAgentRegistry can be constructed with the writer in hand.
  // The trace path is logged after `bootstrapSession` returns (caller-side
  // banner), so we open the file here but defer the log line until later
  // to preserve startup-message ordering.
  const traceSessionLabel = a.resumeTarget?.stored?.sessionId;
  const trace = createDefaultTraceWriter(
    traceSessionLabel ? { sessionLabel: traceSessionLabel } : {},
  );

  // Match session credential family to --provider when set (anti-leak for
  // --provider xai with a Claude default model).
  const providerHints = explicitProviderHints(a.options.provider);
  const apiKey = getApiKeyForModel(getModel(), providerHints);
  // Witness layer: trace writer is now live — emit the bootstrap_start marker.
  // (Total bootstrap span is reported by bootstrap_done, measured from the
  // function-entry timestamp captured in bootstrap.ts.)
  void emitSessionPhase(trace?.writer, { phase: 'bootstrap_start' });

  // BackgroundAgentRegistry — owns the lifecycle of every job spawned by
  // `agent` tool with mode="background". Constructed before the executor
  // so we can pass it via SubagentExecutorContext. Cancel-all is invoked
  // by the interactive teardown path so detached jobs do not outlive
  // their parent process.
  const backgroundRegistry = new BackgroundAgentRegistry(
    trace ? { traceWriter: trace.writer } : {},
  );
  setBgsubRegistry(backgroundRegistry);

  // Opt-in background summarizer — only constructed when bgSummaries: true.
  const bgSummariesEnabled = a.cliConfig.bgSummaries === true;
  const bgSummarizer = bgSummariesEnabled && apiKey
    ? new BackgroundSummarizer({
        registry: backgroundRegistry,
        apiKey,
        maxCallsPerSession: a.cliConfig.maxSummaryCallsPerSession ?? 200,
      })
    : undefined;
  bgSummarizer?.start();
  setBgsubSummarizer(bgSummarizer);

  // External constraint: deferredParent reads through sessionRef.current so
  // a mid-session swap (mutating sessionRef.current) is transparent to all
  // child executors — they hold a reference to this proxy object, which
  // always delegates to the currently-active session.
  const deferredParent = {
    get sessionId() { return a.sessionRef.current?.sessionId; },
    getInputStreamRef() { return a.sessionRef.current?.getInputStreamRef?.() ?? { pushUserMessage: () => {} }; },
    get abortSignal() {
      return a.sessionRef.current?.abortSignal ?? new AbortController().signal;
    },
    // Expose the live session's registry so forked subagents resolve it via
    // SubagentManager.forkSubagent's parent fallback — the production path for
    // SubagentStart/Stop (incl. the shadow-verify nudge) and child-config
    // inheritance. The registry is constructed after this proxy, so reading
    // it lazily through sessionRef.current is required.
    get hookRegistry() { return a.sessionRef.current?.hookRegistry; },
  };

  // Invariant: ONE root manager per session, shared by all three executors.
  // Constructed here (not earlier) so it can be created together with the
  // executors that close over it; the SubagentManager constructor is pure —
  // it emits no trace events — so this placement does not reorder the
  // witness trace relative to `bootstrap_start` above.
  const { rootManager, subagentExecutor, skillExecutor, composeExecutor } = wireExecutors({
    // Origin attribution: the REPL is a `cli` entrypoint, so forked children
    // inherit origin 'cli' (not 'unknown'). See session-identity.ts.
    surface: 'cli',
    parentSession: deferredParent,
    apiKey,
    model: a.sessionModel,
    // `apiKey` is getApiKey(), which keys off getModel() (AFK_MODEL), so the
    // manager's credential-fallback provider must be derived from THAT model —
    // not the possibly-resumed session model — or the fallback can cross the
    // provider boundary.
    managerParentModel: getModel(),
    // OpenAI-routed parents default dispatched subagents to the parent model
    // rather than the legacy `'sonnet'` literal, which would silently route
    // local-only sessions to api.anthropic.com. Claude parents still get 'sonnet'.
    defaultSubagentModel: getDefaultSubagentModel(a.sessionModel),
    resolveApiKeyForModel: getApiKeyForModel,
    // Raw base prompt (pre-assembly): children and compose nodes stay task
    // workers, without ROUTING_DIRECTIVE / TOOL_SYSTEM_PROMPT.
    ...(a.basePrompt !== undefined ? { systemPrompt: a.basePrompt } : {}),
    ...(a.cliConfig.baseUrl !== undefined ? { baseUrl: a.cliConfig.baseUrl } : {}),
    ...(a.cliConfig.openaiBaseUrl !== undefined ? { openaiBaseUrl: a.cliConfig.openaiBaseUrl } : {}),
    // Worktree cwd (`afk i --worktree`, or a resumed session's restored cwd)
    // propagates to every depth so subagents' resolveBase + readRoots anchor
    // to the worktree, not the Node host's process.cwd().
    ...(a.effectiveCwd !== undefined ? { cwd: a.effectiveCwd, nestedCwd: a.effectiveCwd } : {}),
    ...(trace?.writer !== undefined
      ? { traceWriter: trace.writer, skillTraceWriter: trace.writer }
      : {}),
    // Background dispatch (`agent` with mode:"background") is REPL-only; the
    // registry must reach every depth of the skill/agent fork chain.
    backgroundRegistry,
    // `warn` routes into bootWarnings rather than stderr: the built-in-shadow
    // warning is a safety signal and the startup screen clear eats stderr.
    // Also emits a durable `boot_warning` trace event via the shared
    // recorder (#754) — at PUSH time, so the record survives even if a
    // later bootstrap phase throws before either drain site runs.
    agentRegistryWarn: (message: string) =>
      recordBootWarning({
        bootWarnings: a.bootWarnings,
        traceWriter: trace?.writer,
        producer: 'agent-registry',
        message,
      }),
  });

  return {
    trace,
    apiKey,
    backgroundRegistry,
    bgSummarizer,
    rootManager,
    subagentExecutor,
    skillExecutor,
    composeExecutor,
  };
}
