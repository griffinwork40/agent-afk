/**
 * Fork-time option/parameter types for `SubagentManager`.
 *
 * Extracted verbatim from `../subagent.ts` (#829) to keep that module focused
 * on the `SubagentManager` class. Every type here is re-exported from
 * `../subagent.ts`, so this move is invisible to existing importers.
 *
 * @module agent/subagent/fork-types
 */

import type { ZodType } from 'zod';
import type { CanUseTool } from '../types/sdk-types.js';
import type { WorkspaceStore } from '../workspace/workspace-store.js';
import type { HookRegistry } from '../hooks.js';
import type { AgentConfig, IAgentSession } from '../types.js';
import type { SubagentProgressSink, OutputEvent } from '../types/session-types.js';
import type { TraceSink } from '../trace/index.js';
import type { Surface } from '../awareness/types.js';
import type { PhaseRole } from '../tools/nesting.js';
import type { MessageJournal } from '../journal/index.js';

export interface ForkParent {
  sessionId?: string;
  /**
   * Parent session id used to tag outgoing SubagentStart/SubagentStop
   * dispatches so consumers can correlate events. Optional — falls back
   * to `sessionId` when not set.
   */
  id?: string;
  /** See {@link JournalParent}. */
  readonly messageJournal?: MessageJournal;
}

/**
 * Optional message-journal view of a forking parent. When present, the child
 * journals to `parent.messageJournal.forSubagent(childId)`
 * (`sessions/<parentId>/subagents/<childId>.jsonl`); when absent (stub parents,
 * DAG nodes) the child runs unjournaled. Never the parent's own journal: see
 * the invariant in ./fork-child-config.ts.
 */
export interface JournalParent {
  readonly messageJournal?: MessageJournal;
  /**
   * Live id of the forking parent, when the view is backed by a mutable stub
   * that is backfilled after its own fork returns (#2442). Read lazily by the
   * nested SkillExecutor factory so skill forks inside a sub-agent get a real
   * `parentSessionId`. Absent on plain journal-only views.
   */
  readonly sessionId?: string | undefined;
}

export interface ForkSubagentOptions<T = unknown> {
  /**
   * Parent session to fork from. If it has a `sessionId`, the child resumes + forks it.
   * Optional `getInputStreamRef` unlocks `SubagentStop` context injection; optional
   * `abortSignal` makes that injection respect parent abort (skip when aborted).
   * Optional `hookRegistry` is the production wiring path for subagent-lifecycle
   * hooks: when neither `config.hookRegistry` nor the manager's registry is set
   * (the common case — the registry is built after the manager), the parent's
   * registry is used to dispatch SubagentStart/SubagentStop and is threaded into
   * the child config. This is why the shadow-verify nudge reaches the parent.
   */
  parent: Pick<IAgentSession, 'sessionId'> &
    Partial<Pick<IAgentSession, 'getInputStreamRef' | 'abortSignal' | 'hookRegistry'>> &
    JournalParent;
  /** Child config. `resume`/`forkSession` are managed by this module. */
  config: AgentConfig;
  /** Optional prefix to help identify subagents in logs. */
  idPrefix?: string;
  /**
   * Optional Zod schema for validating structured output. When provided,
   * {@link SubagentHandle.runToResult} attempts to extract JSON from the final
   * assistant message and parse it through the schema.
   */
  outputSchema?: ZodType<T>;
  /**
   * Required display label used by the CLI renderer to title the synthesized
   * `Agent(<label>)` tool-lane entry for this subagent. Use to give
   * compose-spawned nodes human-readable labels (e.g. `"diagnose [1/3]"`)
   * without polluting `idPrefix` — which is also threaded into routing
   * telemetry.
   *
   * Invariant: every `forkSubagent` callsite must supply an explicit label.
   * The type is `required` (not optional) so future omissions are caught at
   * compile time rather than silently falling back to the raw `idPrefix` at
   * render time. Callers that have no better label than `idPrefix` should
   * pass `agentType: idPrefix` explicitly to document that choice.
   *
   * Runtime: empty strings are normalized to `undefined` before use, so
   * `forkSubagent` still falls back to `idPrefix` if the caller passes `''`.
   * See `SubagentManager.forkSubagent` (this file, `effectiveAgentType`).
   */
  agentType: string;
  /**
   * The resolved *registered* agent type for this fork — the clean, enumerable
   * counterpart to the {@link agentType} render label. Callers set this ONLY
   * when the dispatch named an `agent_type` that resolved to a registry entry
   * (see SubagentExecutor). Absent for bare/unnamed dispatches, compose node
   * labels, and skill id_prefix forks. Flows verbatim into the
   * `subagent_lifecycle.started` trace event and the routing-decision row so
   * cross-session telemetry can group by real type without the label noise.
   */
  resolvedAgentType?: string;
  /**
   * Optional parent identifier for the renderer's nesting machinery. When
   * provided, overrides the default of `parent.sessionId`. Used by the
   * `compose` tool to pass its own `tool_use_id` so spawned subagents render
   * nested under the compose tool-lane entry rather than as top-level
   * siblings. Does not affect execution — purely a rendering hint.
   *
   * **Contract**: when present, this value MUST be a `tool_use_id` (i.e. the
   * Anthropic-format id of a `tool_use` content block, e.g.
   * `"toolu_01Abc…"`). It is emitted verbatim as `parentToolUseId` on the
   * `subagent_lifecycle` SSE event consumed by renderers and live surfaces.
   * Passing a session UUID or any other id type will silently corrupt the
   * topology links those consumers rely on to reconstruct the subagent tree.
   */
  parentId?: string;
  /**
   * Optional first-80-chars slice of the dispatch prompt, forwarded verbatim
   * into the `subagent_lifecycle.started` trace event's `promptHead` field for
   * at-a-glance forensics (WHAT was the child asked to do). The prompt itself
   * is not a `forkSubagent` argument — it arrives later via `handle.run(prompt)`
   * — so the raw agent-dispatch site (which HAS the prompt) passes this
   * pre-sliced hint. Purely observational: never affects execution. Omitted for
   * fork sites with no prompt in scope.
   */
  promptHead?: string;
  /**
   * When true, overrides `config.onElicitation` with `DENY_ELICITATION` so
   * background subagents never stall on an interactive permission prompt.
   * Propagates transitively: a bg parent's DENY_ELICITATION is inherited by
   * grandchildren via the `...options.config` spread in `childConfig` unless
   * overridden by a deeper `denyElicitations: true`.
   */
  denyElicitations?: boolean;

  /**
   * When true, the child's tool surface gains the `emit_progress` tool,
   * letting it push structured progress events to the parent at the parent's
   * next user-turn boundary. Events are buffered in a ring buffer (capacity 20)
   * on the handle and delivered via `queueFrameworkContext`.
   *
   * Opt-in per fork — omit (or set false) to keep the child's default surface.
   * The tool is EXCLUDED (not silently no-oped) when this is not set.
   */
  progressEvents?: boolean;

  /**
   * Enforce a per-phase permission boundary on the forked subagent.
   *
   * - `'read-only'`: construct a provider whose `permissions.allowedTools`
   *   is restricted to {@link READ_ONLY_PHASE_TOOLS} (read_file, glob, grep,
   *   list_directory, memory_search). The dispatcher rejects any other tool
   *   call with `'not in the configured allowlist'` — enforced at the
   *   provider's `SessionToolDispatcher.checkToolPermission` gate, not at
   *   the telemetry layer. Required posture for skill phases that must not
   *   mutate the repo before user approval (e.g. mint spec/research/plan).
   * - `'read-write'` (default when omitted): no enforcement; the child
   *   inherits the host's default permissive surface.
   *
   * Contract: mutually exclusive with `config.provider`. The manager
   * throws synchronously if both are supplied — a caller's explicit
   * provider would silently override the phase-restricted one, which
   * is the exact failure mode this option exists to prevent.
   *
   * See `src/agent/tools/nesting.ts buildPhaseRestrictedProvider` for
   * the construction and `src/agent/tool-category.ts READ_ONLY_PHASE_TOOLS`
   * for the canonical allowlist.
   */
  phaseRole?: PhaseRole;
  /**
   * The nested-dispatch allowlist for the child this fork creates. Derived from
   * `resolvedAccess.nestedAgentTypes` in `buildChildConfig` and threaded here so
   * `assembleChildConfig` can surface it in the identity preamble. When present,
   * the preamble tells the child which `agent_type` values it may dispatch.
   *
   * Invariant: this value MUST equal what `SubagentExecutorContext.nestedAgentAllowlist`
   * is set to for the child's executor (child-config.ts). Text and enforcement
   * derive from one value. See identity-preamble.ts `SubagentIdentityFacts.nestedAgentAllowlist`.
   *
   * Undefined = unscoped (no restriction emitted). Empty array = deny-all.
   */
  nestedAgentAllowlist?: readonly string[];
}

/**
 * A credential paired with the model it was resolved for.
 *
 * Bundling these two fields prevents the key/provider mismatch that caused the
 * compose 401 (#2844): `applyManagerApiKeyFallback` derives `parentProvider`
 * from `sourceModel`, so both values come from a single authoritative source
 * rather than being supplied as independent options that can be mismatched.
 *
 * Use this instead of the separate `apiKey` + `parentModel` options whenever
 * a credential is available at construction time. The getter form of `key` is
 * preferred for long-lived managers (fix #2471): it lets the credential be
 * re-read at fork time so a mid-session `/reauth` or usage-limit hot-swap is
 * reflected in every child forked after it.
 */
export interface ParentCredential {
  /** The API key (or OAuth token) the parent session runs with. */
  key: string | (() => string | undefined);
  /** The model the credential was resolved for (provider source of truth). */
  sourceModel: string;
}

export interface SubagentManagerOptions {
  /**
   * Parent permission handler forwarded to all spawned children.
   * When a child has no explicit `canUseTool` of its own, tool-permission
   * requests bubble up to this callback.
   */
  canUseTool?: CanUseTool;
  /**
   * External abort signal. When it fires, the manager aborts its root
   * (cascading to all subagents). Use to wire a parent session's
   * {@link IAgentSession.abortSignal} into nested managers.
   */
  parentAbortSignal?: AbortSignal;
  /**
   * Harness hook registry. When provided, `forkSubagent` dispatches
   * `SubagentStart` before creating the child session (block => throw);
   * `cancel()` dispatches `SubagentStop` before tearing the child down
   * (non-blocking). If the caller does not set `config.hookRegistry` on
   * the fork, this registry is threaded into the child's config so the
   * child session dispatches SessionStart/SessionEnd against the same
   * registry.
   */
  hookRegistry?: HookRegistry;
  /**
   * Optional sink for streaming subagent progress events. When set, all
   * forked subagents will forward their OutputEvent stream to this sink.
   * Falls back to the ambient sink from AsyncLocalStorage if not provided.
   */
  progressSink?: SubagentProgressSink;
  /**
   * Paired credential — the API key (or token) together with the model it was
   * resolved for. Prefer this over the separate `apiKey` + `parentModel`
   * options (#2844): bundling them makes a key/provider mismatch impossible to
   * express at the type level, ensuring `applyManagerApiKeyFallback` always
   * uses the credential's real provider.
   *
   * When both `parentCredential` and the legacy `apiKey`/`parentModel` are
   * supplied, `parentCredential` takes precedence.
   *
   * The getter form of `key` is preferred for long-lived managers (fix #2471):
   * it lets the credential be re-read at fork time so a mid-session `/reauth`
   * or usage-limit hot-swap is reflected in every child forked after it.
   */
  parentCredential?: ParentCredential;
  /**
   * API key (or OAuth token) inherited by all forked children whose
   * `config.apiKey` is missing or empty. Mirrors the hookRegistry /
   * permissionBubbler auto-fill pattern in {@link SubagentManager.forkSubagent}.
   *
   * May be a plain string (backward-compatible) or a zero-arg getter.
   * The getter form is preferred for long-lived managers (fix #2471): it
   * lets the credential be re-read at fork time so a mid-session `/reauth`
   * or usage-limit hot-swap is reflected in every child forked after it.
   *
   * @deprecated Use {@link parentCredential} instead — pairing the key with its
   * source model prevents provider mismatches (#2844). This option remains
   * backward-compatible but degrades to key-shape inference when `parentModel`
   * is also absent.
   */
  apiKey?: string | (() => string | undefined);
  /**
   * Local-server base URL inherited by all forked children whose
   * `config.baseUrl` is missing. Ensures subagents spawned by the `agent`
   * tool hit the same local server as the parent rather than silently
   * falling back to api.anthropic.com.
   */
  baseUrl?: string;
  /**
   * The model the parent session runs — i.e. the model {@link apiKey} was
   * resolved for. The manager derives the parent's *provider* from it (via
   * `providerForModel`) exactly once, and uses that to gate the fork-time
   * credential fallback: a parent credential is inherited only by a
   * same-provider child, so an Anthropic key never reaches an OpenAI child and
   * an OpenAI key never reaches an Anthropic child. When omitted, the fallback
   * degrades to key-shape inference (forward guard only) — pass this wherever
   * `apiKey` is provided to get both-direction protection. See
   * `applyManagerApiKeyFallback` in ./tools/child-credential.ts.
   *
   * @deprecated Use {@link parentCredential} instead — `parentCredential.sourceModel`
   * provides the same information atomically paired with the key (#2844).
   */
  parentModel?: string;
  /**
   * Working directory inherited by all forked children whose `config.cwd`
   * is unset. Without this, subagents forked from a session running in an
   * `afk interactive -w` worktree fall back to the Node host's
   * `process.cwd()` and run their bash/grep tool calls in the main repo —
   * defeating worktree isolation across sibling sessions. Typically set
   * by callers that hold a parent {@link IAgentSession} to the parent's
   * `config.cwd`.
   */
  cwd?: string;
  /**
   * The parent session's effective READ roots, used to derive a forked child's
   * inherited read scope (see ./subagent-read-scope). `undefined` means "derive
   * from {@link cwd}": a defined `cwd` is treated as the parent's containment
   * base, an undefined `cwd` as an UNCONFINED parent (reads anywhere → read-open
   * child). Pass an explicit array only when the parent is confined to roots
   * that differ from its cwd — chiefly to propagate a read-open or `/allow-dir`-
   * widened scope transitively to grandchildren. A caller (e.g. `afk farm`) that
   * pins each fork's `config.readRoots` suppresses inheritance entirely, so this
   * never widens a deliberately-confined worker.
   */
  parentReadRoots?: string[];
  /**
   * Root (depth-0) session id of the forking parent, forwarded from its own
   * {@link AgentConfig.rootSessionId}. Undefined when the forking parent is a
   * top-level session. Passed through to {@link assembleChildConfig} so
   * grandchild forks inherit the REAL root id, not the intermediate parent's id.
   */
  parentRootSessionId?: string;
  /**
   * Witness-layer trace writer. Threaded into the manager's {@link AbortGraph}
   * so cascade aborts emit `abort` events, AND auto-inherited by every forked
   * child whose `config.traceWriter` is unset — so all worker sessions write
   * into the same trace file without per-call plumbing. When omitted, AbortGraph
   * runs without trace emission and child sessions emit no traces (useful for
   * tests and harnesses that don't need the witness layer).
   */
  traceWriter?: TraceSink;
  /**
   * Execution surface inherited by all forked children whose `config.surface`
   * is unset. Governs the `origin` field (`cli` / `telegram` / `daemon`) in
   * every child session's trace events. Set by each top-level entrypoint (farm
   * → `'cli'`, daemon → `'daemon'`, telegram → `'telegram'`) so worker sessions
   * report the correct origin without per-call plumbing.
   */
  surface?: Surface;
  /**
   * Optional callback invoked after each forked subagent reaches
   * `succeeded` status. Receives the subagent's token usage and optional
   * USD cost so a parent session can accumulate them into the
   * `session_sealed` rollup without a direct reference to `AgentSession`.
   *
   * Intended wiring: `AgentSession.recordSubagentCompletion` bound to the
   * session instance. The callback fires synchronously on the
   * `SubagentHandleImpl.run()` success path before `onTerminal()`.
   */
  onSubagentSucceeded?: (
    usage: import('./result.js').SubagentTrace['usage'],
    costUsd: number | undefined,
  ) => void;
  /**
   * Shared workspace store inherited by all forked children. When provided,
   * child configs are augmented with a workspace context preamble containing
   * relevant entries published by sibling agents.
   */
  workspaceStore?: WorkspaceStore;
  /**
   * Session label used as the directory key for subagent log files
   * (`~/.afk/state/subagent-logs/<sessionLabel>/<subagentId>.jsonl`).
   * Must match the label passed to `setTasksRegistry` so the writer and
   * reader agree on the directory.  Defaults to `options.parent.sessionId`
   * when absent (old behaviour, kept for backwards compatibility).
   */
  sessionLabel?: string;
  /**
   * Optional sink for subagent lifecycle `OutputEvent`s (type
   * `'subagent_lifecycle'`). When set, `forkSubagent` emits a `started` event
   * immediately after the handle enters the active map, and a terminal
   * event (`succeeded` / `failed` / `cancelled`) when the handle reaches its
   * final state. Wired at bootstrap time to push into the parent session's
   * `outputBroadcast` so live surfaces (web-UI SSE, CLI TUI) see subagent
   * lifecycle without scraping the witness trace.
   *
   * Late-bindable via {@link SubagentManager.setOutputEventSink} — use that
   * setter when the session is not available at manager construction time.
   */
  outputEventSink?: (event: OutputEvent) => void;
  /**
   * Tree-wide delegation budget. When provided, `forkSubagent` calls
   * `canSpawn` before forking and throws if the budget is exhausted.
   * `recordSpawn` is called on admission; `release` is called when the child
   * reaches a terminal state; `rollback` is called when fork construction
   * itself throws before the child ever runs.
   *
   * Opt-in: `undefined` disables all budget enforcement (the common case
   * when no `AFK_MAX_*` env vars are set). Pass the same `DelegationBudget`
   * instance that the agent-tool / compose / DAG paths share so inline skill
   * phase forks count against the same tree-wide counters.
   */
  delegationBudget?: import('../tools/delegation-budget.js').DelegationBudget;
}

/**
 * Resolve the effective `(key, sourceModel)` pair from `SubagentManagerOptions`.
 *
 * Precedence: `parentCredential` wins over separate `apiKey` + `parentModel`.
 * See `SubagentManagerOptions.parentCredential` for the rationale (#2844).
 */
export function resolveParentCredential(options: SubagentManagerOptions): {
  effectiveKey: string | (() => string | undefined) | undefined;
  effectiveModel: string | undefined;
} {
  if (options.parentCredential !== undefined) {
    return { effectiveKey: options.parentCredential.key, effectiveModel: options.parentCredential.sourceModel };
  }
  return { effectiveKey: options.apiKey, effectiveModel: options.parentModel };
}
