/**
 * Session-level tool dispatcher.
 *
 * Implements the `ToolDispatcher` interface from the provider boundary. Wraps
 * the hook system (`PreToolUse`/`PostToolUse`), permission gate, and handler
 * routing into a single `execute()` call. Injected into the provider at
 * construction — the provider's `loop.ts` calls `execute()` without knowing
 * about hooks or permissions.
 *
 * @module agent/tools/dispatcher
 */

import {
  DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS,
  resolveMaxConcurrentSafeToolCalls,
} from '../../config/concurrency.js';
import { abortFailureClass } from '../abort-reason.js';

import type { HookRegistry } from '../hooks.js';
import type { AnthropicToolDef } from '../providers/anthropic-direct/types.js';
import type { ToolDispatcher } from '../providers/anthropic-direct/tool-dispatcher.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { SkillExecutor } from './skill-executor.js';
import type { ComposeExecutor } from './compose-executor.js';
import type { ToolHandler, ToolHandlerContext, ConcurrencyClassifier } from './types.js';
import type { ToolActivityReporter } from '../providers/shared/tool-activity.js';
import type { SpawnedPidRegistry } from './handlers/pid-registry.js';
import type { ToolPermissionConfig } from './permissions.js';
import type { CanUseTool } from '../types/sdk-types.js';
import { PathGrantManager, type GrantSnapshot, type GrantManager } from './grant-manager.js';

import type { TraceSink } from '../trace/index.js';
import { defaultConcurrencyClassifier } from './dispatch-batching.js';

import type { SuspectedLoopWindow } from './suspected-loop-detector.js';
import { RepeatFailureGuard } from './repeat-failure-guard.js';
import { executeBatchImpl } from './dispatcher.execute-batch.js';
import {
  runPreDispatchGates as _runPreDispatchGates,
  resetDenialBreaker as _resetDenialBreaker,
} from './dispatcher.pre-dispatch-gates.js';
import type {
  PreDispatchGateMutableState,
  PreDispatchGateDeps,
  RunPreDispatchGatesOpts,
} from './dispatcher.pre-dispatch-gates.js';
import {
  executeCore as _executeCore,
  isRegisteredTool as _isRegisteredTool,
  denialReason as _denialReason,
} from './dispatcher.core-exec.js';
import type { CoreExecDeps } from './dispatcher.core-exec.js';

// Re-exported for backward compatibility: external importers (dispatcher.test.ts,
// schema-classification.test.ts) historically import this from './dispatcher.js'.
export { defaultConcurrencyClassifier } from './dispatch-batching.js';

/**
 * Repeat-loop circuit breaker threshold.
 *
 * `improve` telemetry caught sessions where a tool (e.g. get_runtime_state)
 * was invoked 49–69 times CONSECUTIVELY with byte-identical input — a model
 * stuck in a no-progress loop, burning tokens on a result that never changes.
 * The breaker trips when the same (toolName, input) fingerprint is seen this
 * many times in a row on one dispatcher (i.e. within a single turn), returning
 * a synthetic isError nudge instead of re-running the tool.
 *
 * Set above any plausible legitimate consecutive-identical pattern: the first
 * 7 identical calls still execute; the 8th onward is short-circuited.
 */
export const REPEAT_CIRCUIT_BREAKER_THRESHOLD = 8;

/**
 * Tools exempt from the repeat circuit breaker, for cases where repeated
 * byte-identical calls are legitimately intentional (e.g. genuine polling).
 * Empty by default: at {@link REPEAT_CIRCUIT_BREAKER_THRESHOLD}=8, eight
 * consecutive byte-identical calls is itself a runaway signal for every
 * current tool. Add a name here only if a real false-trip surfaces.
 */
const REPEAT_BREAKER_EXEMPT_TOOLS: ReadonlySet<string> = new Set<string>();

/**
 * Default ceiling on concurrency-safe tool calls run simultaneously within one
 * batched round (see {@link SessionToolDispatcher.executeBatch}). Safe batches
 * include agent/skill/compose subagent forks, not just cheap reads; unbounded,
 * a wide fan-out (a compose layer, or a turn issuing many subagent calls) can
 * exhaust memory or storm the provider rate limit. This is the engine-level
 * safety ceiling — 8 sits above typical read-fan-out width so ordinary reads
 * are never throttled, while bounding a runaway subagent fan-out (cf. the
 * background-job ceiling of 10). Must stay >= 2 or parallel-timing tests
 * regress. Operators can lower it with AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS;
 * injectable via SessionToolDispatcherOptions.maxConcurrentSafeCalls.
 */
export { DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS, resolveMaxConcurrentSafeToolCalls };

export interface SessionToolDispatcherOptions {
  handlers: Map<string, ToolHandler>;
  schemas: AnthropicToolDef[];
  /**
   * Session hook registry. REQUIRED KEY (value-nullable): every dispatcher
   * construction must explicitly thread the registry or `undefined`. When this
   * was optional, provider code could silently drop `config.hookRegistry`,
   * disabling the plan-mode write gate (c6892c6). Resolve via
   * `resolveSessionHookRegistry` — never re-implement the precedence.
   */
  hookRegistry: HookRegistry | undefined;
  permissions?: ToolPermissionConfig;
  /**
   * Optional in-process permission callback. When set it is consulted on every
   * tool call AFTER the static allowlist (`permissions`) but BEFORE the
   * read-only-bash gate, so an allowlist hard-deny still wins. A `deny` result
   * short-circuits the call with a permission-denied error; an `allow` result
   * may carry `updatedInput` to rewrite the call's input before the handler
   * runs. `ask` is resolved inside the callback (see `createCanUseToolHook`),
   * so the dispatcher only ever observes a final allow/deny. No-op when unset.
   */
  canUseTool?: CanUseTool;
  subagentExecutor?: SubagentExecutor;
  skillExecutor?: SkillExecutor;
  composeExecutor?: ComposeExecutor;
  concurrencyClassifier?: ConcurrencyClassifier;
  /**
   * Ceiling on simultaneously in-flight concurrency-safe tool calls within one
   * batched round. Defaults to {@link DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS}
   * (8). A wide safe batch drains through a pool of at most this many at a time;
   * results and their order are unaffected. Values < 1 (or non-finite) fall
   * back to the default. Injected by tests to assert the cap.
   */
  maxConcurrentSafeCalls?: number;
  /** Session working directory forwarded to every handler invocation. */
  cwd?: string;
  /**
   * Allowed roots for read-class tools. Defaults to `[cwd]` when unset.
   * When provided as an array reference, mutations to the array are reflected
   * on the next handler call (used by `AnthropicDirectProvider` to share state
   * across per-query dispatcher instances).
   */
  readRoots?: string[];
  /**
   * Allowed roots for write-class tools. Defaults to `[cwd]` when unset.
   * Same shared-reference semantics as `readRoots`.
   */
  writeRoots?: string[];
  /**
   * When true, the per-call `ToolHandlerContext` carries `allowAll: true`,
   * disabling ALL path containment (bypassPermissions mode). Derived by the
   * provider's `buildDispatcher` from the session permission mode.
   */
  allowAll?: boolean;
  /**
   * Extra environment variables surfaced on every `ToolHandlerContext.env`.
   * Consumed by the Bash handler to inject `PLUGIN_ROOT` (and any future
   * per-session overrides) without mutating `process.env`. Captured by
   * reference — currently snapshotted on each `handlerContext` read so a
   * later object-identity swap wouldn't take effect; that matches the
   * shared-array semantics for readRoots/writeRoots.
   */
  env?: Record<string, string>;
  /** Stable session identifier written to audit-log entries. */
  sessionId?: string;
  /**
   * Parent session id when this dispatcher belongs to a forked subagent.
   * Surfaced on every PreToolUse context so session-scoped gates (e.g. the
   * plan-mode gate, a main-session affordance) can self-skip subagent tool
   * calls. Undefined for top-level sessions.
   */
  parentSessionId?: string;
  /**
   * This fork's own subagent id, when the dispatcher belongs to a forked child.
   * Stamped onto every `hook_decision` this dispatcher emits so a block can be
   * ATTRIBUTED to the child that provoked it, mirroring what `tool_call`
   * already records. Undefined for top-level sessions.
   */
  subagentId?: string;
  /**
   * The PROVIDER that owns this dispatcher (it implements {@link GrantManager}).
   * The provider's `buildDispatcher` passes `this`; the dispatcher injects it
   * onto every PreToolUse/PostToolUse context as `context.grantManager` so
   * path-scoped hooks resolve THIS session's live grants rather than a stale
   * process-global ref (#435/#514, retired in #528). Optional: test dispatchers
   * that construct directly leave it unset and the hooks fail open (no grant
   * manager → no containment prompt, handler resolveAndContain still enforces).
   */
  sessionGrantManager?: GrantManager;
  /** Witness-layer trace writer. When provided, every PreToolUse and
   *  PostToolUse dispatch records a `hook_decision` event. */
  traceWriter?: TraceSink;
  /**
   * When true, this dispatcher belongs to a read-only skill's forked subagent:
   * any `bash` call whose command is classified as MUTATING (see
   * `classifyBashCommand`) is blocked with an isError result before the
   * handler runs. Read-only bash (git status/log/diff, ls, cat, find, grep,
   * etc.) is allowed through. This is the bash half of read-only-skill
   * enforcement — the tool-allowlist half (no `write_file`/`edit_file`) is set
   * via `permissions.allowedTools = RECON_ALLOWED_TOOLS` at provider
   * construction. Set by `createChildProviderFactory` / `buildReadOnlyReconProvider`.
   * Defaults to false.
   */
  readOnlyBash?: boolean;
  /**
   * Central per-result output cap, in UTF-8 bytes. When set, `executeCore`
   * reduces any tool result whose `content` exceeds this to head+tail via
   * {@link headAndTail} (and stamps `truncated: true`) as the FINAL step before
   * returning — a crash-class backstop that bounds EVERY tool's output (MCP
   * bridges, browser dumps, read_file of a huge file, …), not just the ones
   * that self-cap. Idempotent: content already within budget (e.g. web_scrape
   * already capped it) is returned unchanged, so there is no double-truncation.
   * Never touches `result.image`.
   *
   * Fork-scoped by design: the SubagentManager/provider path sets this to
   * {@link import('./handlers/_output-cap.js').MODEL_CAP_BYTES} for FORKED
   * children only (keyed on `parentSessionId`). The TOP-LEVEL session leaves it
   * `undefined` ⇒ no central capping ⇒ behavior unchanged. Because a forked
   * child that overflows its context window crashes the whole turn (issue #661),
   * containing the class at the child dispatcher is the narrow, high-value fix.
   */
  maxOutputBytes?: number;
  /**
   * Session-scoped PID registry. When provided, the `wait_for` process
   * condition restricts probing to PIDs registered here (i.e. child processes
   * the bash tool actually spawned in this session). Optional for back-compat;
   * new session construction paths should always supply one.
   */
  spawnedPidRegistry?: SpawnedPidRegistry;
  /**
   * Live bash output tail reporter factory (issue #1506).
   *
   * When present, `callHandlerContext` calls this factory with the
   * `toolUseId` of each dispatched bash call and attaches the returned
   * callback as `context.onBashOutputTail`. The bash handler feeds
   * streaming stdout/stderr to a RollingTailBuffer that fires the callback
   * (throttled ~300 ms) so the TUI can render in-flight progress.
   *
   * The factory is called once per tool invocation — the returned callback
   * is bound to that call's `toolUseId` and drives the TUI's
   * {@link ToolLane.setBashOutputTail} for that specific lane entry.
   *
   * Optional: when absent, bash behaves as before (no live tail).
   */
  bashOutputTailReporter?: (toolUseId: string) => (tail: string | undefined) => void;
}

export class SessionToolDispatcher implements ToolDispatcher {
  private readonly handlers: Map<string, ToolHandler>;
  private readonly schemas: AnthropicToolDef[];
  private readonly hookRegistry: HookRegistry | undefined;
  private readonly permissions: ToolPermissionConfig | undefined;
  private readonly canUseTool: CanUseTool | undefined;
  private readonly subagentExecutor: SubagentExecutor | undefined;
  private readonly skillExecutor: SkillExecutor | undefined;
  private readonly composeExecutor: ComposeExecutor | undefined;
  private readonly classifier: ConcurrencyClassifier;
  /** Ceiling on simultaneously in-flight concurrency-safe calls per batch. */
  private readonly maxConcurrentSafeCalls: number;
  // `resolveBase` tracks the CURRENT working directory — mutated only via
  // `setResolveBase()`. Used for `ToolHandlerContext.resolveBase`/`.cwd` and
  // for the `_readRoots`/`_writeRoots` migration in `setResolveBase`. Made
  // mutable in 2026-05-26 to fix the worktree-rename race: when a session's
  // worktree is moved mid-turn, the in-flight `runInput.toolDispatcher`
  // reference (captured by `loop.ts`) must observe the new cwd on its NEXT
  // `handlerContext` read so bash/grep/glob spawn with the post-rename path
  // instead of the deleted old one.
  //
  // The NON-REVOCABLE anchor is `resolveBase` itself (Option A / migrating
  // anchor). After a `setResolveBase` call the anchor migrates with the cwd
  // so the NEW worktree root is protected, matching provider semantics.
  private resolveBase: string | undefined;
  /** Mutable read-root list. Mutated in place by `addReadRoot`/`revokeRoot`/`setResolveBase`. */
  private readonly _readRoots: string[];
  /** Mutable write-root list. Mutated in place by `addWriteRoot`/`revokeRoot`/`setResolveBase`. */
  private readonly _writeRoots: string[];
  /**
   * When true, all path containment is bypassed (bypassPermissions mode).
   * Mutable so a live `/bypass` toggle can flip it mid-session via
   * `setAllowAll()` — read fresh per call by the `handlerContext` getter.
   */
  private _allowAll: boolean;
  /** Optional per-session env injected into the Bash handler's spawn env. */
  private readonly _env: Record<string, string> | undefined;
  private readonly sessionId: string | undefined;
  private readonly parentSessionId: string | undefined;
  private readonly subagentId: string | undefined;
  /**
   * Provider that owns this dispatcher (implements GrantManager). Injected onto
   * PreToolUse/PostToolUse contexts so path-scoped hooks read THIS session's
   * live grants. See {@link SessionToolDispatcherOptions.sessionGrantManager}.
   */
  private readonly sessionGrantManager: GrantManager | undefined;
  private readonly traceWriter: TraceSink | undefined;
  /** When true, mutating `bash` commands are blocked (read-only skill child). */
  private readonly readOnlyBash: boolean;
  /**
   * Central per-result output byte cap (see
   * {@link SessionToolDispatcherOptions.maxOutputBytes}). `undefined` ⇒ no
   * central capping (top-level default). Set to MODEL_CAP_BYTES for forked
   * children so the whole tool-output-overflow crash class is contained (#661).
   */
  private readonly maxOutputBytes: number | undefined;
  /** Session-scoped PID registry for wait_for process condition gating (#1430). */
  private readonly spawnedPidRegistry: SpawnedPidRegistry | undefined;
  /** Live bash output tail reporter factory (issue #1506). */
  private readonly bashOutputTailReporter:
    | ((toolUseId: string) => (tail: string | undefined) => void)
    | undefined;
  /**
   * Mutable state for the pre-dispatch gate chain. Owned by the dispatcher;
   * passed by reference into {@link PreDispatchGateDeps} on each call so the
   * extracted free functions in `dispatcher.pre-dispatch-gates.ts` can read and
   * write it without holding a class reference. The three fields mirror the
   * three private fields that lived here before the extraction:
   *   - `repeatBreaker`       — repeat-loop circuit breaker
   *   - `suspectedLoopWindow` — OBSERVE-ONLY loop telemetry window
   *   - `denialBreaker`       — denial circuit breaker (#546)
   */
  private readonly gateState: PreDispatchGateMutableState = {
    repeatBreaker: null,
    suspectedLoopWindow: null as SuspectedLoopWindow | null,
    denialBreaker: null,
  };

  /**
   * Enforcing failure-streak guard (#723). Separate from `gateState.repeatBreaker`:
   * that one nudges on byte-identical calls regardless of outcome, this one
   * refuses execution after consecutive FAILURES of the same normalized call.
   */
  private readonly repeatFailureGuard = new RepeatFailureGuard();



  /**
   * Shared grant-state machine (issues #361/#362). The hooks bind the
   * dispatcher's per-consumer behavior: CURRENT `resolveBase` as the
   * non-revocable anchor (migrates on `setResolveBase`), live `_allowAll`
   * boolean for the bypass flag, and the construction-bound `sessionId` for
   * audit entries. See grant-manager.ts for the divergence catalogue.
   */
  private readonly grantManager: PathGrantManager;

  constructor(opts: SessionToolDispatcherOptions) {
    this.handlers = opts.handlers;
    this.schemas = opts.schemas;
    this.hookRegistry = opts.hookRegistry;
    this.permissions = opts.permissions;
    this.canUseTool = opts.canUseTool;
    this.subagentExecutor = opts.subagentExecutor;
    this.skillExecutor = opts.skillExecutor;
    this.composeExecutor = opts.composeExecutor;
    this.classifier = opts.concurrencyClassifier ?? defaultConcurrencyClassifier;
    this.maxConcurrentSafeCalls =
      typeof opts.maxConcurrentSafeCalls === 'number' &&
      Number.isFinite(opts.maxConcurrentSafeCalls) &&
      opts.maxConcurrentSafeCalls >= 1
        ? Math.floor(opts.maxConcurrentSafeCalls)
        : resolveMaxConcurrentSafeToolCalls();
    this.resolveBase = opts.cwd;
    this._env = opts.env;
    this.sessionId = opts.sessionId;
    this.parentSessionId = opts.parentSessionId;
    this.subagentId = opts.subagentId;
    this.sessionGrantManager = opts.sessionGrantManager;
    this.traceWriter = opts.traceWriter;
    this.readOnlyBash = opts.readOnlyBash === true;
    // Central output cap: only a positive finite number arms the backstop; any
    // other value (undefined, 0, negative, NaN) leaves it off — matching the
    // top-level default of "no central capping".
    this.maxOutputBytes =
      typeof opts.maxOutputBytes === 'number' &&
      Number.isFinite(opts.maxOutputBytes) &&
      opts.maxOutputBytes > 0
        ? opts.maxOutputBytes
        : undefined;
    this._allowAll = opts.allowAll === true;
    this.spawnedPidRegistry = opts.spawnedPidRegistry;
    this.bashOutputTailReporter = opts.bashOutputTailReporter;

    // When caller passes arrays by reference (provider sharing pattern), use
    // them directly so mutations are visible without rebuilding. Otherwise
    // create fresh arrays from the cwd default.
    const defaultRoots = opts.cwd ? [opts.cwd] : [];
    this._readRoots = opts.readRoots ?? defaultRoots.slice();
    this._writeRoots = opts.writeRoots ?? defaultRoots.slice();

    this.grantManager = new PathGrantManager({
      getReadRoots: () => this._readRoots,
      getWriteRoots: () => this._writeRoots,
      // Option A (migrating anchor): the non-revocable anchor is the CURRENT
      // resolveBase — it migrates with `setResolveBase` so the active worktree
      // root is always protected. Providers use the same semantics.
      // See grant-manager-divergence.md §Finding 2.
      getProtectedRoot: () => this.resolveBase,
      getAllowAll: () => this._allowAll,
      getDefaultSessionId: () => this.sessionId,
    });
  }

  /**
   * Returns a fresh snapshot of the current handler context. Called for every
   * handler invocation so grant mutations are always reflected.
   *
   * Note: `toolUseId` and `traceWriter` are NOT included here — they are
   * per-call values added inline by `execute()` and `executeCore()` via
   * `callHandlerContext(call)` so the getter stays call-agnostic and can be
   * used safely by code that doesn't have a live ToolCall reference.
   */
  private get handlerContext(): ToolHandlerContext {
    return {
      cwd: this.resolveBase,
      resolveBase: this.resolveBase,
      readRoots: this._readRoots.slice(),
      writeRoots: this._writeRoots.slice(),
      ...(this._allowAll ? { allowAll: true } : {}),
      ...(this._env !== undefined ? { env: this._env } : {}),
      // Lets human-blocking handlers tell the elicitation router WHICH session's
      // presence file to mark as waiting-on-a-human.
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      // #1430: PID registry gates wait_for process condition to session-owned PIDs.
      ...(this.spawnedPidRegistry !== undefined ? { spawnedPidRegistry: this.spawnedPidRegistry } : {}),
    };
  }

  /**
   * Returns a per-call handler context that augments the base `handlerContext`
   * with the tool-call-specific fields (`toolUseId`, `traceWriter`, and
   * the per-call bash output tail callback when the reporter factory is set).
   */
  private callHandlerContext(call: ToolCall): ToolHandlerContext {
    const tailCallback =
      call.name === 'bash' && this.bashOutputTailReporter !== undefined && call.id
        ? this.bashOutputTailReporter(call.id)
        : undefined;
    return {
      ...this.handlerContext,
      toolUseId: call.id,
      ...(this.traceWriter !== undefined ? { traceWriter: this.traceWriter } : {}),
      ...(tailCallback !== undefined ? { onBashOutputTail: tailCallback } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Grant API — delegates to the shared PathGrantManager (see grant-manager.ts).
  // ---------------------------------------------------------------------------

  /**
   * Grant read access to `absPath`. No-op if already present.
   * `resolveBase` is always implicitly readable and need not be added.
   *
   * Invariant: the audit append fires ONLY when the path is newly added —
   * see {@link PathGrantManager.addReadRoot} for the 196x dedup rationale.
   */
  addReadRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.grantManager.addReadRoot(absPath, source, sessionId);
  }

  /**
   * Grant read + write access to `absPath`. Ensures path is in BOTH lists.
   * Audits `grant-write` only when the path is newly added to `_writeRoots` —
   * see {@link PathGrantManager.addWriteRoot}.
   */
  addWriteRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.grantManager.addWriteRoot(absPath, source, sessionId);
  }

  /**
   * Remove `absPath` from both root lists. The CURRENT `resolveBase` is
   * non-revocable: attempts to revoke it are silently ignored. After a
   * `setResolveBase` call the new cwd becomes the protected root (Option A /
   * migrating anchor), matching provider semantics. See grant-manager.ts
   * module header and the `getProtectedRoot` hook at `grantManager` construction.
   */
  revokeRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
    this.grantManager.revokeRoot(absPath, source, sessionId);
  }

  /** Returns a snapshot of current grant state (for /allow-dir display). */
  getGrants(): GrantSnapshot {
    return this.grantManager.getGrants();
  }

  /**
   * Flip the bypass (`allowAll`) flag in place. Mutates rather than rebuilding
   * so callers holding this dispatcher by reference (e.g. `loop.ts` captured
   * `runInput.toolDispatcher` for an in-flight turn) see the new value on their
   * next `handlerContext`/`getGrants()` read. This is the file-tool half of a
   * live `/bypass` toggle; the path-approval-hook half is the provider's
   * `_currentPermissionMode` (see the query handle's `setPermissionMode`).
   */
  setAllowAll(allow: boolean): void {
    this._allowAll = allow;
  }

  /**
   * Update the dispatcher's resolveBase to `newCwd`, propagating to:
   *   1. `this.resolveBase` (used by the `handlerContext` getter and grant-API
   *      containment checks). The non-revocable anchor migrates with this update
   *      (Option A) — the new cwd becomes the protected root.
   *   2. `_readRoots` / `_writeRoots` — any entry that equals the prior
   *      resolveBase is replaced in place with `newCwd`. Other grants
   *      (added via /allow-dir) are preserved.
   *   3. The forked sub-agent / skill executors this dispatcher owns are
   *      re-anchored via their `setCwd` so child `agent` / skill tool calls
   *      land in `newCwd` (the worktree) instead of the host `process.cwd()`.
   *      This is the openai-compatible provider's ONLY executor re-anchor hook
   *      (its `query.setCwd` routes straight here); anthropic-direct re-anchors
   *      the same instances again in `cwdDependentsFactory` (idempotent).
   *
   * Mutates in place. Callers must keep the same dispatcher reference; the
   * point of this method is that callers holding the dispatcher by reference
   * (e.g. `loop.ts:419` captured `runInput.toolDispatcher` for an in-flight
   * turn) see the updated cwd on the next `handlerContext` read without
   * needing the reference to be swapped.
   *
   * This is the supported escape hatch for cwd mutation (worktree rename,
   * `/cwd <path>` slash command). It is NOT a grant API — it does not write
   * an audit-log entry and is not exposed through `/allow-dir`.
   *
   * No-op when `newCwd` matches the current `resolveBase`.
   */
  setResolveBase(newCwd: string): void {
    const oldCwd = this.resolveBase;
    if (oldCwd === newCwd) return;

    this.resolveBase = newCwd;

    // Migrate the prior resolveBase entry in the shared roots so containment
    // checks (read_file/glob/grep/_cwd-utils.resolveAndContain) accept paths
    // under the new cwd. Operates in place so any other dispatcher sharing
    // these arrays (provider pattern) sees the same change.
    if (oldCwd !== undefined) {
      const rIdx = this._readRoots.indexOf(oldCwd);
      if (rIdx !== -1) {
        this._readRoots[rIdx] = newCwd;
      } else if (!this._readRoots.includes(newCwd)) {
        this._readRoots.push(newCwd);
      }
      const wIdx = this._writeRoots.indexOf(oldCwd);
      if (wIdx !== -1) {
        this._writeRoots[wIdx] = newCwd;
      } else if (!this._writeRoots.includes(newCwd)) {
        this._writeRoots.push(newCwd);
      }
    } else {
      // No prior resolveBase — just ensure newCwd is in both lists.
      if (!this._readRoots.includes(newCwd)) this._readRoots.push(newCwd);
      if (!this._writeRoots.includes(newCwd)) this._writeRoots.push(newCwd);
    }

    // Re-anchor the forked executors this dispatcher dispatches to (item 3
    // above) so child `agent` / skill / compose tool calls follow the cwd
    // change instead of staying frozen on the launch dir — the
    // openai-compatible provider's only re-anchor path (anthropic-direct also
    // does this in cwdDependentsFactory on the same instances). No-op when the
    // executors are absent (sub-agents, the eval-run probe dispatcher); `setCwd`
    // is idempotent, so the anthropic-direct double-set is harmless.
    this.subagentExecutor?.setCwd(newCwd);
    this.skillExecutor?.setCwd(newCwd);
    this.composeExecutor?.setCwd(newCwd);
  }

  // Contract: advertised schema MUST mirror the enforced allowlist.
  // When an allowlist is configured, return only the schemas whose name is
  // in that set — the model must not be shown tools the permission gate will
  // reject (read-only / recon forks call bash, get "not in the configured
  // allowlist", and waste turns).  An undefined allowlist means full access
  // (all schemas returned unchanged), preserving the default unrestricted path.
  // MCP tool visibility is preserved because the allowlist is already unioned
  // with live MCP wire-names before reaching the dispatcher (see
  // permissions.ts:withMcpToolsAllowed).
  get toolDefs(): readonly AnthropicToolDef[] {
    const available = this.subagentExecutor?.supportsBackgroundJobs?.()
      ? this.schemas
      : this.schemas.filter(
          (schema) =>
            schema.name !== 'cancel_background_job' && schema.name !== 'send_message_to_agent' && schema.name !== 'get_background_job_health',
        );
    const allowed = this.permissions?.allowedTools;
    if (!allowed) return available;
    const set = new Set(allowed);
    return available.filter((s) => set.has(s.name));
  }

  /**
   * Model-visible reason text for an allowlist denial.
   *
   * Invariant: the permission gate runs BEFORE the handler lookup in
   * `executeCoreInner`, so a name the model INVENTED is rejected here as an
   * allowlist denial and never reaches that branch's `Unknown tool "X".
   * Available tools: ...` enumeration. Because every surface configures an
   * allowlist (`CHILD_ALLOWED_TOOLS` / `topLevelSurfaceAllowedTools`), that
   * enumeration was unreachable for exactly the case it was written for, and
   * the model instead saw a denial that reads like "you lack permission" — no
   * signal that the tool does not exist. Models carry a strong post-training
   * prior for Anthropic's native tool names (e.g. `str_replace_based_edit_tool`,
   * the text-editor tool this codebase does not implement) and re-emit them
   * under long edit-heavy runs, burning a round each time.
   *
   * A missing registration is the discriminator: registered-but-denied is a
   * real permission decision and keeps its original message, while an
   * unregistered name does not exist at all and gets the tool list instead.
   * Registrations include both ordinary handlers and the executor-backed
   * `agent`, `skill`, and `compose` tools, which are routed before handler
   * lookup in `executeCoreInner`. Suggestions come
   * from `toolDefs` (NOT `handlers`) to honour the contract on that getter —
   * never show the model a tool the gate will reject.
   *
   * `failureClass` stays `permission-denied` at the call site: it is a trace
   * union consumed by receipt/detector code, and widening it is out of scope
   * for a message fix.
   */
  /**
   * Build the {@link PreDispatchGateDeps} bundle for the current call context.
   * Called inline in `execute()` and `executeBatch()` so both paths always
   * observe the current `resolveBase` and grant-manager reference.
   */
  private gateDeps(): PreDispatchGateDeps {
    const cDeps = this.coreExecDeps();
    return {
      state: this.gateState,
      hookRegistry: this.hookRegistry,
      permissions: this.permissions,
      canUseTool: this.canUseTool,
      readOnlyBash: this.readOnlyBash,
      repeatFailureGuard: this.repeatFailureGuard,
      sessionId: this.sessionId,
      parentSessionId: this.parentSessionId,
      subagentId: this.subagentId,
      sessionGrantManager: this.sessionGrantManager,
      resolveBase: this.resolveBase,
      traceWriter: this.traceWriter,
      isRegisteredTool: (name) => _isRegisteredTool(name, cDeps),
      denialReason: (name, reason) => _denialReason(name, reason, cDeps),
    };
  }

  /**
   * Build the {@link CoreExecDeps} bundle for the current call context.
   * Called by {@link gateDeps} and directly by {@link executeCore} delegation.
   *
   * History: isRegisteredTool, denialReason, unknownToolMessage, applyOutputCap,
   * executeCompose, executeCoreInner, executeCore, firePostToolUse, and
   * firePostToolUseFailure were extracted to dispatcher.core-exec.ts to bring
   * dispatcher.ts below the 350-code-line ceiling. The class delegates via
   * _executeCore imported from that module, threaded through coreExecDeps().
   */
  private coreExecDeps(): CoreExecDeps {
    return {
      handlers: this.handlers,
      hookRegistry: this.hookRegistry,
      sessionId: this.sessionId,
      parentSessionId: this.parentSessionId,
      sessionGrantManager: this.sessionGrantManager,
      traceWriter: this.traceWriter,
      maxOutputBytes: this.maxOutputBytes,
      subagentExecutor: this.subagentExecutor,
      skillExecutor: this.skillExecutor,
      composeExecutor: this.composeExecutor,
      callHandlerContext: (call) => this.callHandlerContext(call),
      gateDeps: () => this.gateDeps(),
      toolDefs: this.toolDefs,
    };
  }

  // History: runPreDispatchGates, checkReadOnlyBash, emitPreToolUseBlock,
  // checkRepeatCircuitBreaker, checkRepeatFailureGuard, observeSuspectedLoop,
  // recordForkReadDenial, resetDenialBreaker, and runCanUseTool were extracted
  // to dispatcher.pre-dispatch-gates.ts to bring dispatcher.ts below the
  // 350-code-line ceiling. The class delegates via `_runPreDispatchGates` and
  // `_resetDenialBreaker` imported from that module, threaded through `gateDeps()`.
  private async runPreDispatchGates(
    call: ToolCall,
    opts?: RunPreDispatchGatesOpts,
  ): Promise<ToolResult | null> {
    return _runPreDispatchGates(
      call,
      this.gateDeps(),
      REPEAT_BREAKER_EXEMPT_TOOLS,
      REPEAT_CIRCUIT_BREAKER_THRESHOLD,
      opts,
    );
  }

  private resetDenialBreaker(): void {
    _resetDenialBreaker(this.gateState);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.signal.aborted) {
      return { content: 'Tool call aborted', isError: true, failureClass: abortFailureClass(call.signal) };
    }

    const gateResult = await this.runPreDispatchGates(call);
    if (gateResult) return gateResult;

    // 3. Agent routing + handler dispatch + PostToolUse. Hoisting coreExecDeps()
    // here avoids the duplicate allocation that occurred when executeCore() called
    // it again internally (gateDeps() already called it once inside
    // runPreDispatchGates). executeBatch() is unaffected — it uses its own
    // gateDeps()/executeCore() sequence per tool, which is correct for batches.
    const cDeps = this.coreExecDeps();
    const coreResult = await _executeCore(call, cDeps);
    this.repeatFailureGuard.note(call, coreResult);
    // Reset-on-success: a completed (non-error) tool call is progress, so the
    // denial breaker's consecutive-denial count restarts. See recordForkReadDenial.
    if (coreResult.isError !== true) this.resetDenialBreaker();
    return coreResult;
  }

  // History: executeBatch's Phase 1 gate loop, Phase 2 batch-partition loop, and
  // the reset-on-success denial-breaker reset were extracted to
  // dispatcher.execute-batch.ts to bring dispatcher.ts below the 350-code-line
  // ceiling. The class delegates via executeBatchImpl imported from that module,
  // threaded through an ExecuteBatchDeps bundle wired here.
  async executeBatch(calls: ToolCall[], onActivity?: ToolActivityReporter): Promise<ToolResult[]> {
    return executeBatchImpl(calls, {
      execute: (call) => this.execute(call),
      classifier: this.classifier,
      runPreDispatchGates: (call, opts) => this.runPreDispatchGates(call, opts),
      resetDenialBreaker: () => this.resetDenialBreaker(),
      repeatFailureGuard: this.repeatFailureGuard,
      repeatBreakerExemptTools: REPEAT_BREAKER_EXEMPT_TOOLS,
      executeCore: (call) => this.executeCore(call),
      subagentExecutor: this.subagentExecutor,
      sessionId: this.sessionId,
      maxConcurrentSafeCalls: this.maxConcurrentSafeCalls,
      gateDeps: () => this.gateDeps(),
      traceWriter: this.traceWriter,
    }, onActivity);
  }

  /**
   * Core execution + central output-cap backstop. Delegates to the extracted
   * {@link executeCore} free function in `dispatcher.core-exec.ts`. The single
   * result path both `execute()` and `executeBatch()` call per tool.
   *
   * Ordering: the cap is applied AFTER handler + PostToolUse fire. See the
   * long comment in `dispatcher.core-exec.ts` on {@link executeCore}.
   */
  private async executeCore(call: ToolCall): Promise<ToolResult> {
    return _executeCore(call, this.coreExecDeps());
  }

}
