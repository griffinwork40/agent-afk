/**
 * Assembles the `AgentConfig` for a forked child session.
 *
 * Extracted from `SubagentManager.forkSubagent` (#919) — the dense ~190-LOC
 * config spread literal that was the primary bulk of that function. Every
 * concern that the spread encodes (seal ownership, output cap, credential
 * gating, non-interactive default, anti-hang constraints, scope inheritance,
 * phase-role enforcement) is preserved verbatim together with its `Invariant:`
 * and `External constraint:` comments, which document externally-governed
 * ordering that must never be re-derived from first principles.
 *
 * Takes EXPLICIT parameters — not a closure over forkSubagent's locals — so
 * a reader of this module can understand every input without tracing back to
 * the caller.
 *
 * @module agent/subagent/fork-child-config
 */

import type { AgentConfig, AgentModelInput } from '../types.js';
import type { BundledProviderName } from '../providers/index.js';
import type { CanUseTool } from '../types/sdk-types.js';
import type { TraceSink } from '../trace/index.js';
import type { Surface } from '../awareness/types.js';
import type { HookRegistry } from '../hooks.js';
import type { ForkSubagentOptions } from './fork-types.js';
import { providerForModel } from '../providers/index.js';
import { buildPhaseRestrictedProvider } from '../tools/nesting.js';
import { MODEL_CAP_BYTES } from '../tools/handlers/_output-cap.js';
import { applyManagerApiKeyFallback } from '../tools/child-credential.js';
import { injectToolBudgetPreamble } from './budget-preamble.js';
import { injectSubagentIdentityPreamble } from './identity-preamble.js';
import { injectWorkspacePreamble } from '../workspace/index.js';
import type { WorkspaceStore } from '../workspace/workspace-store.js';
import { DENY_ELICITATION, SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS } from './constants.js';
import { resolveSoftDeadlineMs } from '../providers/shared/soft-deadline.js';
import { childTmpEnvPatch } from '../session/session-tmpdir.js';
import { resolveChildAutoResume } from './usage-limit-park-policy.js';

export interface AssembleChildConfigArgs<T> {
  options: ForkSubagentOptions<T>;
  id: string;
  resume: string | undefined;
  registry: HookRegistry | undefined;
  /** The effective child model after cross-provider coercion (#652). */
  effectiveChildModel: AgentModelInput;
  effectiveTimeoutMs: number;
  inheritedReadRoots: string[] | undefined;
  composedWriteRoots: string[] | undefined;
  childController: AbortController;
  workspaceStore?: WorkspaceStore;
  // Manager-level inherited values
  parentCwd: string | undefined;
  // Fix #2471: a getter lets forkSubagent read the live credential at fork
  // time instead of the boot-time snapshot captured by SubagentManager.
  parentApiKey: (() => string | undefined) | undefined;
  parentBaseUrl: string | undefined;
  parentProvider: BundledProviderName | undefined;
  parentTraceWriter: TraceSink | undefined;
  parentSurface: Surface | undefined;
  parentCanUseTool: CanUseTool | undefined;
  /**
   * The forking manager's own root session id (from the parent session's
   * {@link AgentConfig.rootSessionId}). Undefined at depth 0 (top-level).
   * Passed through so grandchild `inheritedParentFields` can inherit the
   * REAL root id rather than the intermediate parent's id.
   */
  parentRootSessionId: string | undefined;
  /**
   * The nested-dispatch allowlist for the CHILD being assembled. Derived from
   * `resolvedAccess.nestedAgentTypes` in `buildChildConfig` (child-config.ts)
   * and threaded here via `ForkSubagentOptions.nestedAgentAllowlist` so the
   * identity preamble can name the allowed types — the same value the child's
   * executor will enforce at every nested dispatch attempt.
   *
   * Undefined = unscoped child (no restriction emitted in the preamble).
   * Empty array = deny-all (preamble says dispatch is forbidden).
   */
  nestedAgentAllowlist?: readonly string[];
}

/**
 * Append the model-facing fork preambles to a fully resolved child config.
 *
 * Invariant (preamble order): the identity preamble is applied first, to the
 * config AFTER every default in {@link assembleChildConfig} has been resolved,
 * because it derives its lines from `isNonInteractive` (defaulted to `true`
 * there) and the threaded `depth` / `maxDepth`. The budget preamble then
 * appends after the identity preamble, and when `workspaceStore` is set
 * `injectWorkspacePreamble` appends after both — so the budget preamble is
 * the last of the fork-injected sections, not the final section of the assembled
 * system prompt. It likewise
 * reads the final resolved `maxToolUseIterations`.
 *
 * @param nestedAgentAllowlist - Forwarded from {@link AssembleChildConfigArgs}
 *   to {@link injectSubagentIdentityPreamble} so the child's preamble names
 *   the types it may dispatch. Single source: same value the executor enforces.
 */
function applyForkPreambles(config: AgentConfig, nestedAgentAllowlist?: readonly string[]): AgentConfig {
  return injectToolBudgetPreamble(injectSubagentIdentityPreamble(config, nestedAgentAllowlist));
}

/**
 * Resolve the `rootSessionId` to stamp on a forked child.
 *
 * For depth-1 children, `parentRootSessionId` is undefined (the manager's
 * parent is a top-level session with no `rootSessionId`), so we fall back to
 * `parentSessionId` — the root's own id. For depth-2+ children,
 * `parentRootSessionId` is already the root's id, so we return it unchanged.
 * Returns `{}` when neither value is defined (parent had no session id).
 */
function resolveRootSessionId(
  parentRootSessionId: string | undefined,
  parentSessionId: string | undefined,
): { rootSessionId: string } | Record<never, never> {
  const id = parentRootSessionId ?? parentSessionId;
  return id !== undefined ? { rootSessionId: id } : {};
}

/**
 * Parent-derived fields the child inherits only when the caller's
 * `options.config` left them unset (awareness topology, cwd, read/write scope,
 * trace writer, surface, private temp dir). Extracted from {@link assembleChildConfig} verbatim;
 * spread AFTER `...options.config` there, so explicit caller values still win.
 */
function inheritedParentFields<T>(args: AssembleChildConfigArgs<T>): Partial<AgentConfig> {
  return {
    // Awareness metadata: surface parent identity + phase role into the
    // child's config so the get_runtime_state tool's `self` view can report
    // the topology fields. Caller-supplied values on options.config win on
    // collision, matching the spread-then-override pattern used throughout
    // this block. `depth`/`maxDepth` are threaded by SubagentExecutor right
    // before this call — they live on the executor context, not on the
    // manager, so we leave them to the caller here.
    ...(args.options.config.parentSessionId === undefined && args.options.parent.sessionId !== undefined
      ? { parentSessionId: args.options.parent.sessionId }
      : {}),
    // Root session id: set once on depth-1 children (to the parent's sessionId),
    // then inherited unchanged by all deeper descendants so grandchildren always
    // point back to the depth-0 root — not their immediate parent. For depth-1
    // children, args.parentRootSessionId is undefined, so we fall back to
    // parent.sessionId. For depth-2+ children, args.parentRootSessionId is the
    // root's id (threaded through the manager). Child-attribution credits
    // commits/PRs to the root outcome record rather than to an intermediate
    // session id that never writes a sidecar.
    ...(args.options.config.rootSessionId === undefined
      ? resolveRootSessionId(args.parentRootSessionId, args.options.parent.sessionId)
      : {}),
    ...(args.options.config.phaseRole === undefined && args.options.phaseRole !== undefined
      ? { phaseRole: args.options.phaseRole }
      : {}),
    // Inherit the manager's cwd when the caller didn't override.
    // Required for `afk interactive -w` worktree isolation to extend
    // into forked subagents (otherwise child bash/grep falls back to
    // process.cwd() and operates on the wrong working tree).
    ...(args.options.config.cwd === undefined && args.parentCwd !== undefined
      ? { cwd: args.parentCwd }
      : {}),
    // Inherited read scope (computed in forkSubagent). Only set when the
    // caller left readRoots unset; otherwise the `...options.config` spread's
    // readRoots (or the provider's `[cwd]` default) stands.
    ...(args.inheritedReadRoots !== undefined ? { readRoots: args.inheritedReadRoots } : {}),
    // Explicit write-root pre-grant (#435): composed with cwd above. When
    // writeRoots is absent, composedWriteRoots is undefined and the
    // `...options.config` spread's writeRoots (or the provider's `[cwd]`
    // default) stands.
    ...(args.composedWriteRoots !== undefined ? { writeRoots: args.composedWriteRoots } : {}),
    // Invariant: a forked child's trace origin comes from its inherited
    // parent surface, not from any actor-role value (see session-identity.ts).
    // Inherit traceWriter + surface from the manager so every worker session
    // (e.g. farm branch workers) writes into the same trace file and reports
    // the correct origin ('cli'/'daemon'/'telegram') without per-call plumbing.
    // Guard: explicit values on options.config win (the ...options.config
    // spread above already set them); these only fill the gap when
    // the per-fork config omits them — matching the cwd inheritance pattern.
    ...(args.options.config.traceWriter === undefined && args.parentTraceWriter !== undefined
      ? { traceWriter: args.parentTraceWriter }
      : {}),
    ...(args.options.config.surface === undefined && args.parentSurface !== undefined
      ? { surface: args.parentSurface }
      : {}),
    // Private temp dir (session-tmpdir.ts): a fresh TMPDIR/TMP/TEMP nested
    // under the dispatching session's dir, merged over the caller's env so
    // `PLUGIN_ROOT` (skill forks) survives. Never the parent's or a sibling's
    // dir, so a child's `rm -rf "$TMPDIR"/tmp.*` cannot reach theirs. A
    // caller-chosen (unregistered) TMPDIR wins, like the fields above.
    ...childTmpEnvPatch(args.options.config.env, args.id),
  };
}

/**
 * Build the `AgentConfig` for a forked child, applying all fork-time defaults,
 * invariants, and inheritance rules in a single deterministic pass.
 *
 * Returns the assembled config — including the injected tool-budget preamble —
 * ready to pass directly to `new AgentSession(...)`.
 *
 * Invariant (budget disclosure): the preamble is applied HERE, wrapping the
 * whole literal, because this is the sole path to a child AgentSession —
 * agent-tool, compose/DAG, skill forks, and in-process callers all converge
 * on forkSubagent, while `tools/subagent/child-config.ts` is reached only by
 * the agent-tool paths. It wraps rather than sits inside the literal so it
 * reads the FINAL resolved `maxToolUseIterations` — the
 * `options.config.maxToolUseIterations ?? SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS`
 * default applied further down in this same literal — not the caller's
 * pre-default value. Injecting at this provider-neutral site is also what
 * stops the two providers from drifting on it — see the module header on
 * ./subagent/budget-preamble.js.
 */
export function assembleChildConfig<T>(args: AssembleChildConfigArgs<T>): AgentConfig {
  const {
    options,
    id,
    resume,
    registry,
    effectiveChildModel,
    effectiveTimeoutMs,
    childController,
    parentApiKey: parentApiKeyGetter,
    parentBaseUrl,
    parentProvider,
    parentCanUseTool,
  } = args;
  // Resolve at fork time so a mid-session /reauth or hot-swap is visible to
  // every child forked after it (fix #2471). The getter is undefined for
  // callers that never supplied an apiKey; otherwise it is called once here.
  const parentApiKey = parentApiKeyGetter?.();

  // Query the shared workspace for entries relevant to this child's task
  // and inject them as a system-prompt preamble so the child sees sibling
  // agents' findings without needing a workspace_query tool.
  //
  // Invariant: pass `null` as sessionId — the store is already scoped to one
  // root session, and children publish under their own IDs, so a session-
  // filtered query would miss sibling findings (the partition mismatch bug).
  const taskPrompt = resume ?? (typeof options.config.systemPrompt === 'string'
    ? options.config.systemPrompt
    : '');
  const workspaceEntries = args.workspaceStore
    ? args.workspaceStore.queryRelevant(null, taskPrompt)
    : [];

  const assembled = applyForkPreambles({
    ...options.config,
    // Invariant (trace seal ownership): mark this session as a fork so it
    // never seals the SHARED witness trace. The whole tree shares ONE
    // TraceWriter by reference and seal() is a one-shot hard gate — after it
    // flips, write() throws and emitSubagentLifecycle swallows the rejection,
    // so the first descendant to seal silently truncates every later
    // sibling's terminal row (the "started without terminal" orphan gap).
    // Stamped here, unconditionally, for the same reason as
    // subagentToolOutputCapBytes below: this is the single choke point every
    // fork path converges through, so no fork path can forget it. A caller
    // override is intentionally NOT honored — being a fork is not optional.
    // Grandchildren re-stamp it (and would inherit it via the spread
    // regardless), which is correct: they are forks too.
    isSubagentFork: true,
    // Effective model after the cross-provider coercion (#652). Placed
    // AFTER the spread so it overrides options.config.model; a no-op on the
    // common path where nothing was coerced.
    model: effectiveChildModel,
    resume,
    forkSession: resume ? true : options.config.forkSession,
    // Witness attribution: stamp THIS fork's own id onto its config so the
    // child's provider loop tags every `tool_call` started/completed event
    // with `subagentId: id`. Placed AFTER the `...options.config` spread so
    // the manager-assigned `id` always wins — it is authoritative and MUST
    // match the id on the `subagent_lifecycle.started` emit in forkSubagent,
    // or a trace reader could not correlate a tool call with its child. A
    // child resumes the parent's sessionId and writes into the SHARED parent
    // trace file, so without this tag the parent trace cannot say which fork
    // ran which tool (issue #612).
    subagentId: id,
    // Central output-cap signal (#661), stamped UNCONDITIONALLY on EVERY
    // fork. forkSubagent is the single choke point through which the
    // agent-tool, skill, and compose paths all create their child session
    // (subagent-executor.ts, skill-executor/fork-dispatch.ts, and
    // dag-subagent.ts all converge here), and the top-level session is always
    // built via `new AgentSession(...)` directly at the entry points — never
    // here — so this value marks "forked child" and its absence marks
    // "top-level". The provider's buildDispatcher arms the dispatcher's
    // `maxOutputBytes` backstop from this field, bounding every tool result
    // at MODEL_CAP_BYTES (100KB) via headAndTail and containing the
    // tool-output-overflow crash class (#661) for ALL forks — including
    // skill-forked descendants whose `parentSessionId` is undefined (a stub
    // parent carries no sessionId), which the prior `parentSessionId`-keyed
    // gate left uncapped. Set here (not left to the `...options.config`
    // spread) so it cannot be omitted by any fork path; a caller override is
    // intentionally NOT honored — the cap is a non-negotiable fork backstop.
    subagentToolOutputCapBytes: MODEL_CAP_BYTES,
    abortSignal: childController.signal,
    // Invariant (cross-provider credential anti-leak): the parent-credential
    // fallback below must never hand a credential across the provider
    // boundary — an Anthropic `sk-ant-…` key to an OpenAI child, nor an
    // OpenAI key to an Anthropic child. Upstream executors
    // (subagent-executor.ts, skill-executor.ts, compose-executor.ts)
    // deliberately clear `apiKey` / `baseUrl` for cross-provider children; a
    // provider-blind `|| parentApiKey` here silently undid that (both
    // auth resolvers treat an explicit config key as Tier-1 — see
    // openai-compatible/auth.ts — so the wrong token went out as a Bearer to
    // a foreign endpoint). `applyManagerApiKeyFallback` gates on
    // `parentProvider` (derived once from parentModel): explicit caller
    // keys and same-provider inheritance are preserved; only cross-provider
    // combinations resolve to undefined.
    apiKey: applyManagerApiKeyFallback({
      childModel: effectiveChildModel,
      configApiKey: options.config.apiKey,
      parentApiKey,
      parentProvider,
    }),
    // Same guard for the Anthropic-semantic `baseUrl`: an OpenAI-routed
    // child resolves its endpoint from `openaiBaseUrl` / env, never from the
    // parent's Anthropic base URL. Explicit caller values still win.
    baseUrl:
      options.config.baseUrl ??
      (providerForModel(effectiveChildModel) === 'openai-compatible'
        ? undefined
        : parentBaseUrl),
    // External constraint: a forked sub-agent has no human relationship of its
    // own — it returns findings (including Blocked/Asking) to its PARENT, which
    // owns the operator surface. Mark every fork non-interactive by default so
    // the provider strips `ask_question` from the child toolset; otherwise the
    // child could call it and reach the REPL/Telegram human via the
    // process-wide elicitation router, interleaved into the parent's turn with
    // no attribution. A caller may opt a fork back in with
    // `isNonInteractive: false`.
    isNonInteractive: options.config.isNonInteractive ?? true,
    // External constraint (anti-hang): a forked child's tool-use loop is
    // otherwise unbounded on anthropic-direct (DEFAULT_MAX_TOOL_USE_ITERATIONS
    // = 0 = no cap), so a runaway child could spin forever while the parent is
    // suspended at `await runToResult`. Give every fork a positive default
    // ceiling (parity with openai-compatible's built-in 50-round cap); the
    // caller's explicit `options.config.maxToolUseIterations` (already carried
    // by the `...options.config` spread above) wins when set, including `0` to
    // opt back into unbounded. Hitting the cap surfaces as a
    // `tool_use_loop_capped` done, returning the child's partial work.
    maxToolUseIterations:
      options.config.maxToolUseIterations ?? SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS,
    // TIME sibling of the round cap above, derived from the SAME wall-clock
    // budget the hard `withTimeout` abort in forkSubagent is armed with. The
    // round cap bounds WORK DONE and the idle watchdog bounds SILENCE; neither
    // bounds a child that is genuinely working but slow — that child previously
    // hit the hard abort and lost everything it had learned, unsynthesized. The
    // soft deadline lands earlier, at a round boundary, and spends one
    // tools-stripped round on a real answer. `resolveSoftDeadlineMs` returns
    // `0` (off, prior behaviour exactly) for unbounded budgets and for budgets
    // too short to split. An explicit caller `softDeadlineMs` wins via `??`,
    // including `0` to opt out.
    softDeadlineMs: options.config.softDeadlineMs ?? resolveSoftDeadlineMs(effectiveTimeoutMs),
    // Opt-in park-and-wait on OAuth usage-limit 429 (see usage-limit-park-policy.ts
    // for precedence rules). Precedence: explicit caller value > env var
    // AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT (ignored on the daemon surface,
    // where no human can switch accounts) > false. When false a fork fails fast
    // so the parent can decide: retry, reroute, or surface the pause itself.
    autoResumeOnUsageLimit: resolveChildAutoResume(
      options.config.autoResumeOnUsageLimit,
      options.config.surface ?? args.parentSurface,
    ),
    ...inheritedParentFields(args),
    // Invariant (message journal): a fork resumes the PARENT's session id, so
    // a journal keyed by session id would write the parent's `journal.jsonl`.
    // Every child gets the parent's per-subagent journal
    // (`sessions/<parentId>/subagents/<id>.jsonl`) or none. Stamped after the
    // spread so an inherited `options.config.messageJournal` (a caller that
    // cloned the parent's config) can never leak through; `resumeMessages` is
    // cleared for the same reason: children never reseed from the parent's
    // journal, they start from their own prompt.
    messageJournal: options.parent.messageJournal?.forSubagent(id),
    resumeMessages: undefined,
    // Child session inherits the SAME resolved registry (see `registry`
    // in forkSubagent) so its own SessionStart/SessionEnd/PreToolUse fire
    // against it. Session-scoped hooks (memory writer, plan-mode gate)
    // self-skip subagents via the `parentSessionId` guard in their handlers.
    hookRegistry: registry,
    permissionBubbler:
      options.config.permissionBubbler ??
      (parentCanUseTool !== undefined && options.config.canUseTool === undefined
        ? { canUseTool: parentCanUseTool }
        : undefined),
    // External constraint: close the MCP elicitation path too. A
    // non-interactive sub-agent must not serve `onElicitation` to the
    // operator, so deny by default (install DENY_ELICITATION) unless a caller
    // explicitly opts back in with `denyElicitations: false` (no in-tree
    // caller does). This unifies the three elicitation channels — ask_question
    // (stripped via isNonInteractive above), path-approval (auto-denied via the
    // parentSessionId guard in path-approval-hook.ts), and MCP onElicitation
    // (here) — so every fork is uniformly non-interactive. When opted out, the
    // `...options.config` spread above still propagates any parent-configured
    // handler transitively.
    ...(options.denyElicitations === false ? {} : { onElicitation: DENY_ELICITATION }),
    // Phase role enforcement: when phaseRole === 'read-only', construct a
    // provider whose permissions.allowedTools is restricted to
    // READ_ONLY_PHASE_TOOLS. This is the ONLY wiring that reaches the
    // dispatcher's permission gate (checkToolPermission). Setting
    // childConfig.tools.allowedTools would be a no-op — that field is
    // telemetry-only (emitSubagentLifecycle). The mutual-exclusion check in
    // validatePhaseRole ensures we don't clobber a caller's explicit provider.
    ...(options.phaseRole === 'read-only'
      ? { provider: buildPhaseRestrictedProvider('read-only', effectiveChildModel) }
      : {}),
  }, args.nestedAgentAllowlist);

  return args.workspaceStore
    ? injectWorkspacePreamble(assembled, workspaceEntries)
    : assembled;
}
