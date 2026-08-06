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
import { debugLog } from '../../utils/debug.js';
import { HookBlockedError } from '../../utils/errors.js';
import { settleWithConcurrencyLimit } from '../concurrency-pool.js';
import type { HookRegistry, PreToolUseContext, PostToolUseContext, PostToolUseFailureContext } from '../hooks.js';
import type { AnthropicToolDef } from '../providers/anthropic-direct/types.js';
import type { ToolDispatcher } from '../providers/anthropic-direct/tool-dispatcher.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import { dispatchPreToolUse, dispatchPostToolUse, dispatchPostToolUseFailure } from '../subagent-hooks.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { SkillExecutor } from './skill-executor.js';
import type { ComposeExecutor } from './compose-executor.js';
import type { ToolHandler, ToolHandlerContext, ConcurrencyClassifier } from './types.js';
import { checkToolPermission, type ToolPermissionConfig } from './permissions.js';
import type { CanUseTool, PermissionResult } from '../types/sdk-types.js';
import { classifyBashCommand } from './readonly-bash.js';
import { headAndTail } from './handlers/_output-cap.js';
import { PathGrantManager, type GrantSnapshot } from './grant-manager.js';
import type { GrantManager } from '../../cli/slash/commands/allow-dir.js';
import { emitHookDecision, emitSessionPhase } from '../trace/emit.js';
import type { TraceWriter } from '../trace/index.js';
import { defaultConcurrencyClassifier, partitionIntoBatches } from './dispatch-batching.js';
import { repeatCallFingerprint } from './repeat-circuit-breaker.js';
import {
  DENIAL_CIRCUIT_BREAKER_THRESHOLD,
  DENIAL_BREAKER_FAILURE_CLASS,
  READ_PATH_TOOLS,
  isSubagentContainmentDenial,
  extractDeniedReadPath,
  buildDenialBreakerMessage,
} from './denial-circuit-breaker.js';
import {
  createSuspectedLoopWindow,
  fingerprintToolCall,
  observeToolCall,
  SUSPECTED_LOOP_WINDOW_SIZE,
  type SuspectedLoopWindow,
} from './suspected-loop-detector.js';
import {
  REPEAT_FAILURE_REFUSAL_THRESHOLD,
  RepeatFailureGuard,
  repeatFailureFingerprint,
} from './repeat-failure-guard.js';

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
   * path-scoped hooks resolve THIS session's live grants instead of the
   * process-global `pathApprovalGrantRef` — which is pinned to the top-level
   * session and blind to a forked child's own writeRoots (#435/#514). Optional:
   * test dispatchers that construct directly leave it unset and the hooks fall
   * back to their ref, preserving prior behavior.
   */
  sessionGrantManager?: GrantManager;
  /** Witness-layer trace writer. When provided, every PreToolUse and
   *  PostToolUse dispatch records a `hook_decision` event. */
  traceWriter?: TraceWriter;
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
  // Invariant: `resolveBase` is the dispatcher's anchor for relative-path
  // resolution AND the value emitted as `ToolHandlerContext.resolveBase` /
  // `.cwd` on every dispatch. Mutated only via `setResolveBase()` so the
  // /allow-dir non-revocable guard remains correct (revokeRoot still uses
  // `this.resolveBase` for the equality check; updates land atomically).
  // Made mutable in 2026-05-26 to fix the worktree-rename race: when a
  // session's worktree is moved mid-turn, the in-flight `runInput.toolDispatcher`
  // reference (captured by `loop.ts`) must observe the new cwd on its NEXT
  // `handlerContext` read so bash/grep/glob spawn with the post-rename path
  // instead of the deleted old one.
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
  private readonly traceWriter: TraceWriter | undefined;
  /** When true, mutating `bash` commands are blocked (read-only skill child). */
  private readonly readOnlyBash: boolean;
  /**
   * Central per-result output byte cap (see
   * {@link SessionToolDispatcherOptions.maxOutputBytes}). `undefined` ⇒ no
   * central capping (top-level default). Set to MODEL_CAP_BYTES for forked
   * children so the whole tool-output-overflow crash class is contained (#661).
   */
  private readonly maxOutputBytes: number | undefined;
  /**
   * Repeat-loop circuit breaker state. The dispatcher is built per `query()`,
   * so this naturally tracks CONSECUTIVE byte-identical calls within a single
   * turn (across the loop's tool rounds) and resets between turns via
   * dispatcher reconstruction. See {@link checkRepeatCircuitBreaker}.
   */
  private repeatBreaker: { fingerprint: string; count: number } | null = null;

  /**
   * Enforcing failure-streak guard (#723). Separate from `repeatBreaker` above:
   * that one nudges on byte-identical calls regardless of outcome, this one
   * refuses execution after consecutive FAILURES of the same normalized call.
   */
  private readonly repeatFailureGuard = new RepeatFailureGuard();

  /**
   * Denial circuit breaker state (#546). Counts CONSECUTIVE path-approval READ
   * denials on a FORKED child (one dispatcher per forked `query()`), reset to
   * `null` on any successful tool result — so only a fork making zero progress
   * trips. When `count` reaches {@link DENIAL_CIRCUIT_BREAKER_THRESHOLD} the
   * dispatcher tags the tripping result `failureClass: 'denial-breaker'`, which
   * the provider loop surfaces as a loud `error` event. `null` when no denial
   * has been seen since the last success. See {@link recordForkReadDenial}.
   */
  private denialBreaker: { count: number; deniedPaths: string[] } | null = null;

  /**
   * OBSERVE-ONLY suspected-loop telemetry window (see
   * {@link import('./suspected-loop-detector.js')}). Per-dispatcher (one per
   * forked `query()`), so it tracks the last {@link SUSPECTED_LOOP_WINDOW_SIZE}
   * tool-call fingerprints within a single turn and resets between turns via
   * dispatcher reconstruction — exactly like the two breakers above.
   *
   * Lazily created on the first FORKED tool call (see
   * {@link observeSuspectedLoop}); stays `null` for top-level sessions, which are
   * never observed. Its ONLY effect is emitting a `suspected_loop` session-phase
   * event on first detection — it NEVER aborts, sets a failureClass, or alters a
   * result. This is pure data-gathering, not enforcement.
   */
  private suspectedLoopWindow: SuspectedLoopWindow | null = null;

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

    // When caller passes arrays by reference (provider sharing pattern), use
    // them directly so mutations are visible without rebuilding. Otherwise
    // create fresh arrays from the cwd default.
    const defaultRoots = opts.cwd ? [opts.cwd] : [];
    this._readRoots = opts.readRoots ?? defaultRoots.slice();
    this._writeRoots = opts.writeRoots ?? defaultRoots.slice();

    this.grantManager = new PathGrantManager({
      getReadRoots: () => this._readRoots,
      getWriteRoots: () => this._writeRoots,
      // Dispatcher semantics: the CURRENT resolveBase is the non-revocable
      // anchor (and the getGrants() display base) — after a setResolveBase
      // migration the NEW cwd is protected, not the launch dir.
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
    };
  }

  /**
   * Returns a per-call handler context that augments the base `handlerContext`
   * with the tool-call-specific fields (`toolUseId`, `traceWriter`). Used by
   * `execute()` and `executeCore()` when dispatching to a named handler.
   */
  private callHandlerContext(call: ToolCall): ToolHandlerContext {
    return {
      ...this.handlerContext,
      toolUseId: call.id,
      ...(this.traceWriter !== undefined ? { traceWriter: this.traceWriter } : {}),
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
  addReadRoot(absPath: string, source: 'slash' | 'tool' = 'slash'): void {
    this.grantManager.addReadRoot(absPath, source);
  }

  /**
   * Grant read + write access to `absPath`. Ensures path is in BOTH lists.
   * Audits `grant-write` only when the path is newly added to `_writeRoots` —
   * see {@link PathGrantManager.addWriteRoot}.
   */
  addWriteRoot(absPath: string, source: 'slash' | 'tool' = 'slash'): void {
    this.grantManager.addWriteRoot(absPath, source);
  }

  /**
   * Remove `absPath` from both root lists. The CURRENT `resolveBase` is
   * non-revocable: attempts to revoke it are silently ignored. (Note: after a
   * `setResolveBase` migration the protected anchor is the NEW cwd — this
   * differs from the providers, which protect the session's INITIAL
   * resolveBase; see grant-manager.ts module header, divergence #2.)
   */
  revokeRoot(absPath: string, source: 'slash' | 'tool' = 'slash'): void {
    this.grantManager.revokeRoot(absPath, source);
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
   *   1. `this.resolveBase` (used by the `handlerContext` getter, /allow-dir
   *      non-revocable guard, and grant-API equality checks).
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
    const allowed = this.permissions?.allowedTools;
    if (!allowed) return this.schemas;
    const set = new Set(allowed);
    return this.schemas.filter((s) => set.has(s.name));
  }

  /**
   * Read-only-skill bash gate. Returns an isError {@link ToolResult} when the
   * dispatcher is in `readOnlyBash` mode AND `call` is a `bash` invocation
   * whose command classifies as MUTATING; otherwise returns `null` (allow).
   *
   * Invariant: this runs AFTER the permission check at both call sites
   * (`execute()` single-path and `executeBatch()` phase-1), mirroring a
   * PreToolUse gate but living in the dispatcher because — unlike the hook
   * registry — it needs the raw `call.input.command` string. The input shape
   * is guarded: a non-object input or missing/non-string `command` is treated
   * as a no-op pass-through (the handler will surface its own validation
   * error), so we never throw here.
   */
  private async checkReadOnlyBash(call: ToolCall): Promise<ToolResult | null> {
    if (!this.readOnlyBash || call.name !== 'bash') return null;
    const input = call.input;
    const command =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)['command']
        : undefined;
    if (typeof command !== 'string') return null;
    const verdict = classifyBashCommand(command);
    if (!verdict.mutating) return null;
    // Reason text is shared by the model-visible result and the trace event so
    // the two can never drift; the command string itself is deliberately NOT
    // recorded (ADR 0001 §G.4 keeps raw commands out of telemetry).
    const reason =
      `Bash command blocked: read-only skill may not run mutating commands ` +
      `(${verdict.reason ?? 'mutation detected'}). Allowed: read-only recon ` +
      `(git status/log/diff/show/ls-remote, ls, cat, find, grep, gh pr view/diff). ` +
      `For a remote ref you have not fetched, \`gh pr diff <n>\`, \`gh pr view <n>\` ` +
      `and \`git ls-remote\` need no local ref — \`git fetch\` is blocked. ` +
      `Do NOT retry variants of a blocked command: if the task genuinely requires a ` +
      `mutation, stop and report that requirement to your caller instead.`;
    await this.emitPreToolUseBlock(call.name, reason);
    return { content: reason, isError: true, failureClass: 'permission-denied' };
  }

  /**
   * Emit a PreToolUse `hook_decision` block, stamped with this dispatcher's
   * `subagentId` when it belongs to a fork.
   *
   * Invariant: EVERY path that returns an isError {@link ToolResult} to the
   * model for a POLICY reason must call this. A denial the model can see but the
   * trace cannot is unattributable after the fact — child tool arguments and
   * error text are persisted nowhere, so this event is the only durable record
   * that the denial happened and which child provoked it. Three sites
   * (read-only bash gate, and the static allowlist check on both the single and
   * batch paths) previously returned silently; an audit of 12,108 traces
   * (2026-07-26) consequently misattributed 268 child `bash` denials to path
   * containment when they came from the read-only gate.
   */
  private async emitPreToolUseBlock(blockedTool: string, reason: string): Promise<void> {
    await emitHookDecision(this.traceWriter, {
      hookEvent: 'PreToolUse',
      decision: 'block',
      blockedTool,
      reason,
      ...(this.subagentId !== undefined ? { subagentId: this.subagentId } : {}),
    });
  }

  /**
   * Repeat-loop circuit breaker. Increments a per-dispatcher consecutive-call
   * counter keyed on the (toolName, input) fingerprint; when the same call is
   * seen {@link REPEAT_CIRCUIT_BREAKER_THRESHOLD} times in a row, returns a
   * synthetic isError nudge so the model breaks the loop instead of receiving
   * the (unchanging) tool result. Returns null otherwise.
   *
   * Invariant: must be called exactly once per tool call, on the sequential
   * pre-execution path (execute() and executeBatch phase 1) so the count
   * reflects call order. Mirrors checkReadOnlyBash's gate placement — it runs
   * after the permission/abort gates, so denied or aborted calls (which never
   * execute) do not advance the counter.
   */
  private checkRepeatCircuitBreaker(call: ToolCall): ToolResult | null {
    if (REPEAT_BREAKER_EXEMPT_TOOLS.has(call.name)) return null;
    const fingerprint = repeatCallFingerprint(call);
    if (this.repeatBreaker !== null && this.repeatBreaker.fingerprint === fingerprint) {
      this.repeatBreaker.count += 1;
    } else {
      this.repeatBreaker = { fingerprint, count: 1 };
    }
    if (this.repeatBreaker.count < REPEAT_CIRCUIT_BREAKER_THRESHOLD) return null;
    return {
      content:
        `Loop circuit breaker: "${call.name}" has been called ${this.repeatBreaker.count} times ` +
        `in a row with byte-identical input. The result will not change. Stop repeating this ` +
        `call — reuse the previous result, change the input, try a different tool, or end the turn.`,
      isError: true,
      circuitBreaker: true,
    };
  }

  /**
   * Enforcing repeat-FAILURE guard (#723). Returns a refusal — and emits the
   * telemetry the issue requires — when this exact call has already failed
   * REPEAT_FAILURE_REFUSAL_THRESHOLD times in a row. Honours the same
   * exempt-tool list as the advisory breaker, so a tool whose repeated identical
   * calls are legitimate is never refused either.
   */
  private checkRepeatFailureGuard(call: ToolCall): ToolResult | null {
    if (REPEAT_BREAKER_EXEMPT_TOOLS.has(call.name)) return null;
    const verdict = this.repeatFailureGuard.check(call);
    if (verdict === null) return null;
    // Measurement (#723 requires the behaviour be observable) rides the
    // EXISTING per-call `tool_call` trace event via `failureClass:
    // 'repeat-failure'`, which `src/improve/scan/detectors/tool-failure-density.ts`
    // already consumes. Deliberately no new `session_phase` name: that union is
    // closed in two places (trace/types.ts + the hand-listed zod enum in
    // trace/events.ts), and this file's own output-cap comment records the
    // precedent that widening it for a diagnostic is out of scope.
    debugLog(
      `[repeat-failure-guard #723] refused ${verdict.tool} after ${verdict.count} identical failures`,
    );
    return verdict.result;
  }

  /**
   * OBSERVE-ONLY suspected-loop telemetry (see
   * {@link import('./suspected-loop-detector.js')}). Pushes this call's
   * normalized fingerprint into the per-dispatcher sliding window and, on the
   * FIRST time a fingerprint recurs past the threshold within the window,
   * fire-and-forgets a `suspected_loop` session-phase event carrying
   * `{ tool, count, windowSize }`.
   *
   * CRITICAL INVARIANT — this method has NO effect on dispatch. It returns
   * `void`, never a `ToolResult`; it never aborts, never sets a `failureClass`,
   * never mutates or delays the tool result, and never changes control flow.
   * The trace write is `void`-ed (fire-and-forget) so a slow witness write can
   * never delay a tool call. It exists purely to gather data on whether real
   * (tool, args) busy-loops occur in forked sub-agents.
   *
   * Scope: FORKED children only (`parentSessionId` set), mirroring the denial
   * breaker — interactive sessions, where the operator drives repetition, are
   * never observed and the window stays `null`.
   *
   * Placement: called once per tool call on the sequential pre-execution path
   * (execute() step 2d and executeBatch() phase 1), AFTER the repeat breaker —
   * so a call the repeat breaker already short-circuited is not double-counted
   * here, and the fingerprint order reflects real call order. Because it is
   * observe-only, it does not matter whether the underlying call later succeeds
   * or errors; we are measuring the REPETITION, not the outcome.
   */
  private observeSuspectedLoop(call: ToolCall): void {
    // Top-level sessions are out of scope: never observed, no window allocated.
    if (this.parentSessionId === undefined) return;
    if (this.suspectedLoopWindow === null) {
      this.suspectedLoopWindow = createSuspectedLoopWindow();
    }
    const fingerprint = fingerprintToolCall(call);
    const observation = observeToolCall(this.suspectedLoopWindow, fingerprint);
    if (!observation.fired) return;
    // Fire-and-forget: emission must never delay or perturb dispatch, and
    // emitSessionPhase already swallows writer errors internally.
    void emitSessionPhase(this.traceWriter, {
      phase: 'suspected_loop',
      metadata: {
        tool: call.name,
        count: observation.count,
        windowSize: SUSPECTED_LOOP_WINDOW_SIZE,
      },
    });
  }

  /**
   * Denial circuit breaker (#546). Called from the `HookBlockedError` catch with
   * the block `reason` and the just-built `hook-block` result. Counts the denial
   * ONLY when ALL of:
   *   - it is a forked child (`parentSessionId` set — only forks auto-deny reads;
   *     an interactive session gets a prompt instead), AND
   *   - the tool is a {@link READ_PATH_TOOLS} read (so write-confinement is never
   *     counted), AND
   *   - the block is a genuine path-approval CONTAINMENT denial per {@link
   *     isSubagentContainmentDenial} — NOT the credential/secret read-denylist
   *     floor or an arbitrary user-defined `PreToolUse` hook, whose denials the
   *     breaker's "widen readRoots" remedy would misdirect.
   * Below the threshold the original block result is returned unchanged; at the
   * threshold a `denial-breaker` result is returned instead, which the provider
   * loop converts into a loud `error` event so the parent gets a structured,
   * actionable failure rather than a fork that burns its wall-clock budget.
   *
   * Invariant: consecutive — {@link resetDenialBreaker} clears the count on any
   * successful tool result, so a fork that probes a couple of out-of-scope
   * paths and then makes progress never trips.
   */
  private recordForkReadDenial(
    call: ToolCall,
    blockReason: string | undefined,
    blockResult: ToolResult,
  ): ToolResult {
    if (
      this.parentSessionId === undefined ||
      !READ_PATH_TOOLS.has(call.name) ||
      !isSubagentContainmentDenial(blockReason)
    ) {
      return blockResult;
    }
    const breaker = this.denialBreaker ?? { count: 0, deniedPaths: [] };
    breaker.count += 1;
    const deniedPath = extractDeniedReadPath(call);
    if (!breaker.deniedPaths.includes(deniedPath)) breaker.deniedPaths.push(deniedPath);
    this.denialBreaker = breaker;
    if (breaker.count < DENIAL_CIRCUIT_BREAKER_THRESHOLD) return blockResult;
    return {
      content: buildDenialBreakerMessage(breaker.deniedPaths, breaker.count),
      isError: true,
      failureClass: DENIAL_BREAKER_FAILURE_CLASS,
    };
  }

  /**
   * Clear the denial breaker's consecutive-denial count. Called on any
   * successful tool result so the breaker tracks "read denials since the last
   * progress", not lifetime denials. See {@link recordForkReadDenial}.
   */
  private resetDenialBreaker(): void {
    this.denialBreaker = null;
  }

  /**
   * Consult the optional `canUseTool` permission callback for a single call.
   * Returns a permission-denied {@link ToolResult} to short-circuit when the
   * policy denies (or throws — fail-closed), or `null` to proceed. On an
   * `allow` result carrying `updatedInput`, the call's input is rewritten in
   * place so both the handler and the PostToolUse hook observe the new value.
   *
   * Invariant: callers MUST invoke this AFTER `checkToolPermission` (the static
   * allowlist wins) and BEFORE the read-only-bash gate, in BOTH `execute()` and
   * the `executeBatch()` phase-1 loop, so parallel tool calls are gated too.
   */
  private async runCanUseTool(call: ToolCall): Promise<ToolResult | null> {
    if (!this.canUseTool) return null;
    let result: PermissionResult;
    try {
      result = await this.canUseTool(call.name, (call.input ?? {}) as Record<string, unknown>, {
        signal: call.signal,
        toolUseID: call.id,
      });
    } catch (err) {
      // Fail closed: a throwing policy denies the call rather than crashing the
      // turn. The message names the cause so the denial is never silent.
      const reason = `Tool "${call.name}" denied by canUseTool (threw): ${
        err instanceof Error ? err.message : String(err)
      }`;
      await this.emitPreToolUseBlock(call.name, reason);
      return { content: reason, isError: true, failureClass: 'permission-denied' };
    }
    if (result.behavior === 'deny') {
      const reason = result.message || `Tool "${call.name}" denied by permission policy`;
      await this.emitPreToolUseBlock(call.name, reason);
      return { content: reason, isError: true, failureClass: 'permission-denied' };
    }
    // allow — apply an optional input rewrite in place.
    if (result.updatedInput !== undefined) {
      call.input = result.updatedInput;
    }
    return null;
  }

  /**
   * Shared 7-step pre-dispatch gate chain used by both {@link execute} and
   * {@link executeBatch}'s phase-1 admission loop: PreToolUse hook, static
   * allowlist, in-process `canUseTool` callback, read-only-bash gate, repeat
   * circuit-breaker, repeat-failure guard, and suspected-loop telemetry.
   *
   * Invariant: the precedence order below is load-bearing (see the per-step
   * comments) — the static allowlist deny wins over `canUseTool`, which runs
   * before the bash gate, which runs before the repeat-breaker/failure-guard
   * pair, which runs before the observe-only loop telemetry. Do not reorder.
   *
   * Returns `null` if the call should proceed to execution, or the blocking
   * `ToolResult` if a gate short-circuited it. The suspected-loop step never
   * blocks (observe-only) and always runs last when nothing else did.
   */
  private async runPreDispatchGates(call: ToolCall): Promise<ToolResult | null> {
    // 1. PreToolUse hook — can block. Routed through dispatchPreToolUse
    // so the witness-layer hook_decision event lands automatically.
    if (this.hookRegistry) {
      const preCtx: PreToolUseContext = {
        event: 'PreToolUse',
        toolName: call.name,
        input: call.input,
        // Lets the path-approval prompt mark THIS session's presence file as
        // blocked-on-human while the operator decides.
        ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
        ...(this.resolveBase !== undefined ? { cwd: this.resolveBase } : {}),
        ...(this.parentSessionId !== undefined
          ? { parentSessionId: this.parentSessionId }
          : {}),
        // Inject THIS session's provider so path-scoped hooks resolve the real
        // (possibly forked-child) grants instead of the process-global ref.
        ...(this.sessionGrantManager !== undefined
          ? { grantManager: this.sessionGrantManager }
          : {}),
      };
      try {
        await dispatchPreToolUse(this.hookRegistry, preCtx, {
          signal: call.signal,
          ...(this.traceWriter ? { traceWriter: this.traceWriter } : {}),
        });
      } catch (err) {
        if (err instanceof HookBlockedError) {
          return this.recordForkReadDenial(call, err.reason, {
            content: `Tool "${call.name}" blocked by PreToolUse hook: ${err.message}`,
            isError: true,
            failureClass: 'hook-block',
          });
        }
        throw err;
      }
    }

    // 2. Permission check
    const permResult = checkToolPermission(call.name, this.permissions);
    if (!permResult.allowed) {
      const reason = permResult.reason ?? `Tool "${call.name}" is not permitted`;
      await this.emitPreToolUseBlock(call.name, reason);
      return { content: reason, isError: true, failureClass: 'permission-denied' };
    }

    // 2a. In-process permission callback (canUseTool). Consulted AFTER the
    // static allowlist (a hard allowlist deny wins) and BEFORE the bash gate.
    // A `deny` short-circuits here; an `allow` may have rewritten `call.input`.
    const canUseDeny = await this.runCanUseTool(call);
    if (canUseDeny) return canUseDeny;

    // 2b. Read-only-skill bash gate. Runs after the permission check so the
    // allowlist denial (if any) takes precedence; blocks mutating bash while
    // letting read-only recon through.
    const bashBlock = await this.checkReadOnlyBash(call);
    if (bashBlock) return bashBlock;

    // 2c. Repeat-loop circuit breaker. Short-circuits no-progress loops where
    // the model calls the same tool with byte-identical input N times in a row.
    const repeatBlock = this.checkRepeatCircuitBreaker(call);
    if (repeatBlock) return repeatBlock;

    // 2c-bis. Enforcing repeat-FAILURE guard (#723). Unlike the advisory
    // breaker above, this one stops execution: a call that has already failed
    // identically N times is refused with the prior error quoted back.
    const failureRefusal = this.checkRepeatFailureGuard(call);
    if (failureRefusal) return failureRefusal;

    // 2d. OBSERVE-ONLY suspected-loop telemetry (forked children only). Records
    // the fingerprint and emits a `suspected_loop` trace signal on first
    // recurrence past threshold. Pure observability — never blocks, never
    // alters the result, never changes control flow. Runs after the repeat
    // breaker so a short-circuited call is not counted twice.
    this.observeSuspectedLoop(call);

    return null;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.signal.aborted) {
      return { content: 'Tool call aborted', isError: true, failureClass: 'abort' };
    }

    const gateResult = await this.runPreDispatchGates(call);
    if (gateResult) return gateResult;

    // 3. Agent routing + handler dispatch + PostToolUse. Delegates to
    // executeCore() — the shared core executeBatch() already calls per-tool
    // (see lines ~936/972). execute() previously inlined a verbatim copy of
    // that body (agent/skill/compose special-cases + handler lookup +
    // PostToolUse firing); the duplicate only added drift risk with no
    // behavioral difference, so the single-call path now delegates too.
    const coreResult = await this.executeCore(call);
    this.repeatFailureGuard.note(call, coreResult);
    // Reset-on-success: a completed (non-error) tool call is progress, so the
    // denial breaker's consecutive-denial count restarts. See recordForkReadDenial.
    if (coreResult.isError !== true) this.resetDenialBreaker();
    return coreResult;
  }

  /**
   * Execute a batch of tool calls with parallel dispatch for concurrency-safe
   * tools. Unsafe tools run sequentially. Results are returned in the same
   * order as the input `calls` array regardless of completion order.
   *
   * Hook ordering: PreToolUse fires sequentially for every call BEFORE any
   * execution starts. Blocked calls get an immediate error result and are
   * excluded from execution. PostToolUse fires per-tool after completion.
   */
  async executeBatch(calls: ToolCall[]): Promise<ToolResult[]> {
    if (calls.length === 0) return [];
    if (calls.length === 1) return [await this.execute(calls[0]!)];

    const results: ToolResult[] = new Array(calls.length);
    const blocked = new Set<number>();

    // Phase 1: sequential PreToolUse + permission for all calls.
    // Blocked calls get error results immediately and skip execution.
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;

      if (call.signal.aborted) {
        results[i] = { content: 'Tool call aborted', isError: true, failureClass: 'abort' };
        blocked.add(i);
        continue;
      }

      const gateResult = await this.runPreDispatchGates(call);
      if (gateResult) {
        results[i] = gateResult;
        blocked.add(i);
        continue;
      }
    }

    // Phase 2: partition non-blocked calls into batches and execute.
    const executableCalls = calls
      .map((call, i) => ({ call, originalIndex: i }))
      .filter((_, i) => !blocked.has(i));

    if (executableCalls.length === 0) return results;

    const batches = partitionIntoBatches(
      executableCalls.map((e) => e.call),
      this.classifier,
    );

    for (const batch of batches) {
      // Per-call abort check, not batch-level: each ToolCall carries its own
      // `signal` and they are not type-constrained to be identical across a
      // batch. Checking only `calls[0]!.signal` was correct by coincidence
      // because the provider loop currently assigns the same per-turn signal
      // to every call, but a future refactor to per-tool signals would
      // silently misbehave in both directions — falsely aborting fresh calls
      // when call[0] is stale, and falsely dispatching aborted calls when
      // call[0] is fresh. See the parallel-branch parity below.
      if (batch.isConcurrencySafe) {
        // Admit calls in waves. Each normalized fingerprint gets only enough
        // slots to reach the threshold, so a duplicate fan-out cannot run past
        // the guard before its earlier results are known. Independent calls
        // retain the existing bounded concurrency.
        let pending = [...batch.indices];
        while (pending.length > 0) {
          const admittedByFingerprint = new Map<string, number>();
          const wave: number[] = [];
          const deferred: number[] = [];
          for (const batchIdx of pending) {
            const { call, originalIndex } = executableCalls[batchIdx]!;
            const refusal = this.checkRepeatFailureGuard(call);
            if (refusal) {
              results[originalIndex] = refusal;
              continue;
            }
            if (REPEAT_BREAKER_EXEMPT_TOOLS.has(call.name)) {
              wave.push(batchIdx);
              continue;
            }
            const fingerprint = repeatFailureFingerprint(call);
            const capacity =
              REPEAT_FAILURE_REFUSAL_THRESHOLD - this.repeatFailureGuard.streakFor(call);
            const admitted = admittedByFingerprint.get(fingerprint) ?? 0;
            if (admitted < capacity) {
              admittedByFingerprint.set(fingerprint, admitted + 1);
              wave.push(batchIdx);
            } else {
              deferred.push(batchIdx);
            }
          }
          pending = deferred;

          // Bounded concurrency remains in force within each admission wave.
          const settled = await settleWithConcurrencyLimit(
            wave,
            this.maxConcurrentSafeCalls,
            async (batchIdx) => {
              const { call, originalIndex } = executableCalls[batchIdx]!;
              if (call.signal.aborted) {
                return {
                  result: {
                    content: 'Tool call aborted',
                    isError: true,
                    failureClass: 'abort',
                  } as ToolResult,
                  originalIndex,
                };
              }
              const result = await this.executeCore(call);
              return { result, originalIndex };
            },
          );
          for (const outcome of settled) {
            if (outcome.status === 'fulfilled') {
              results[outcome.value.originalIndex] = outcome.value.result;
            } else {
              // Invariant: executeCore catches today; retain this safety net
              // for a future refactor that permits a rejection to escape.
              const msg =
                outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
              const batchIdx = wave[settled.indexOf(outcome)]!;
              results[executableCalls[batchIdx]!.originalIndex] = {
                content: `Tool execution error: ${msg}`,
                isError: true,
              };
            }
          }
          // Apply observations only after every handler settles, and in the
          // batch's original call order rather than completion order.
          for (const batchIdx of wave) {
            const { call, originalIndex } = executableCalls[batchIdx]!;
            const result = results[originalIndex];
            if (result !== undefined && result.failureClass !== 'abort') {
              this.repeatFailureGuard.note(call, result);
            }
          }
        }
      } else {
        for (const batchIdx of batch.indices) {
          const { call, originalIndex } = executableCalls[batchIdx]!;
          if (call.signal.aborted) {
            results[originalIndex] = { content: 'Tool call aborted', isError: true, failureClass: 'abort' };
            continue;
          }
          const refusal = this.checkRepeatFailureGuard(call);
          if (refusal) {
            results[originalIndex] = refusal;
            continue;
          }
          const result = await this.executeCore(call);
          results[originalIndex] = result;
          this.repeatFailureGuard.note(call, result);
        }
      }

      // Stamp batch membership onto each result so downstream consumers
      // (TUI tool-lane render + `tool_call` completed trace event) can tell a
      // genuine parallel wave apart from back-to-back sequential dispatches —
      // which are otherwise indistinguishable once a fast root commits to
      // scrollback ahead of a slow one. 1-based `batchIndex` = ordinal within
      // the batch; `batchSize` = number of calls dispatched together. A
      // concurrency-unsafe tool (bash, write_file, …) is always its own
      // singleton batch, so it lands batchSize=1 and is never badged. Blocked
      // / short-circuited calls (permission, read-only-bash gate, circuit
      // breaker) are excluded from `executableCalls`, so they correctly carry
      // no batch info at all.
      const batchSize = batch.indices.length;
      batch.indices.forEach((batchIdx, pos) => {
        const r = results[executableCalls[batchIdx]!.originalIndex];
        if (r) {
          r.batchIndex = pos + 1;
          r.batchSize = batchSize;
        }
      });
    }

    // Reset-on-success (#546): if any call in this batch executed successfully,
    // the fork made progress, so the denial breaker's consecutive-denial count
    // restarts. Blocked/denied calls carry isError:true and never reset. See
    // recordForkReadDenial.
    if (results.some((r) => r !== undefined && r.isError !== true)) {
      this.resetDenialBreaker();
    }

    return results;
  }

  /**
   * Core execution + central output-cap backstop. The single result path both
   * `execute()` and `executeBatch()` call per tool, so applying the cap here
   * (after {@link executeCoreInner} has run the handler AND fired PostToolUse)
   * bounds EVERY tool result exactly once, regardless of which entry path
   * dispatched it. See {@link SessionToolDispatcherOptions.maxOutputBytes}.
   *
   * Ordering rationale: the cap is applied AFTER `executeCoreInner` returns —
   * i.e. after PostToolUse has already observed the full, uncapped `content`
   * (fired fire-and-forget inside the inner method). Hooks and the model see
   * consistent truncation: the model-facing `content` is the capped view, and
   * `truncated: true` is the structured signal for non-model consumers.
   */
  private async executeCore(call: ToolCall): Promise<ToolResult> {
    const result = await this.executeCoreInner(call);
    return this.applyOutputCap(result);
  }

  /**
   * Reduce `result.content` to head+tail when a central `maxOutputBytes` cap is
   * armed AND the content exceeds it; otherwise return the result untouched.
   *
   * - No-op when `this.maxOutputBytes` is undefined (top-level default) or the
   *   content already fits — {@link headAndTail} itself returns short input
   *   byte-for-byte, so this is idempotent and never double-truncates content a
   *   handler (e.g. web_scrape) already capped.
   * - NEVER touches `result.image`: the cap governs the text budget only; an
   *   attached screenshot rides through unchanged.
   * - Mutates and returns the same object (results are freshly constructed per
   *   call, never shared), setting `truncated: true` — the same structured flag
   *   bash/web_scrape set — so trace/hook consumers need not scan `content`.
   */
  private applyOutputCap(result: ToolResult): ToolResult {
    const cap = this.maxOutputBytes;
    if (cap === undefined) return result;
    const originalBytes = Buffer.byteLength(result.content, 'utf8');
    if (originalBytes <= cap) return result;
    result.content = headAndTail(result.content, cap);
    result.truncated = true;
    // Observability (#661): fork-side truncation is otherwise invisible — the
    // `truncated` flag is a structured signal for downstream consumers, but the
    // ORIGINAL-vs-capped byte delta (how much a fork's tool actually
    // overflowed) is dropped. Emit it via the file's existing lightweight
    // logger (debugLog, gated on AFK_DEBUG/DEBUG). Deliberately NOT a witness
    // trace event: no existing trace kind carries an original+capped byte pair,
    // and adding one would expand the closed trace schema (types.ts + events.ts
    // zod union + tests) for a non-blocking diagnostic — out of scope here. The
    // per-call `tool_call.completed` trace event already records the final
    // (capped) `resultBytes` + `truncated`; this line adds the original size
    // the cap ate, which that event does not carry.
    debugLog(
      `[output-cap #661] fork tool result capped: original=${originalBytes}B ` +
        `capped=${Buffer.byteLength(result.content, 'utf8')}B (cap=${cap}B)`,
    );
    return result;
  }

  /**
   * Core execution: agent routing + handler dispatch + PostToolUse hook.
   * Shared by both `execute()` (single-tool path) and `executeBatch()`
   * (after pre-hooks and permissions are already handled). Wrapped by
   * {@link executeCore}, which applies the central output-cap backstop to
   * whatever result this returns.
   */
  private async executeCoreInner(call: ToolCall): Promise<ToolResult> {
    // Agent tool — provider-level dispatch
    if (call.name === 'agent') {
      if (!this.subagentExecutor) {
        return {
          content: 'Agent tool is not available in this session configuration',
          isError: true,
        };
      }
      let result: ToolResult;
      let agentThrew = false;
      let agentErrMsg = '';
      try {
        result = await this.subagentExecutor.execute(call);
      } catch (err) {
        agentThrew = true;
        agentErrMsg = err instanceof Error ? err.message : String(err);
        result = { content: `Agent tool error: ${agentErrMsg}`, isError: true };
      }
      if (agentThrew) {
        this.firePostToolUseFailure(call.name, agentErrMsg, call.signal, call.input);
      } else {
        this.firePostToolUse(call.name, result.content, call.signal, call.input, result);
      }
      return result;
    }

    // Skill tool — provider-level dispatch
    if (call.name === 'skill') {
      if (!this.skillExecutor) {
        return {
          content: 'Skill tool is not available in this session configuration',
          isError: true,
        };
      }
      let result: ToolResult;
      let skillThrew = false;
      let skillErrMsg = '';
      try {
        result = await this.skillExecutor.execute(call);
      } catch (err) {
        skillThrew = true;
        skillErrMsg = err instanceof Error ? err.message : String(err);
        result = { content: `Skill tool error: ${skillErrMsg}`, isError: true };
      }
      if (skillThrew) {
        this.firePostToolUseFailure(call.name, skillErrMsg, call.signal, call.input);
      } else {
        this.firePostToolUse(call.name, result.content, call.signal, call.input, result);
      }
      return result;
    }

    // Compose tool — DAG-based parallel subagent dispatch
    if (call.name === 'compose') {
      const result = await this.executeCompose(call);
      this.firePostToolUse(call.name, result.content, call.signal, call.input, result);
      return result;
    }

    // Handler lookup
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return {
        content: `Unknown tool "${call.name}". Available tools: ${[...this.handlers.keys()].join(', ')}`,
        isError: true,
      };
    }

    let result: ToolResult;
    let handlerThrew = false;
    let handlerErrMsg = '';
    try {
      result = await handler(call.input, call.signal, this.callHandlerContext(call));
    } catch (err) {
      handlerThrew = true;
      handlerErrMsg = err instanceof Error ? err.message : String(err);
      result = { content: `Tool execution error: ${handlerErrMsg}`, isError: true };
    }

    // Invariant: exactly one of PostToolUse / PostToolUseFailure fires per call.
    if (handlerThrew) {
      this.firePostToolUseFailure(call.name, handlerErrMsg, call.signal, call.input);
    } else {
      this.firePostToolUse(call.name, result.content, call.signal, call.input, result);
    }
    return result;
  }

  private async executeCompose(call: ToolCall): Promise<ToolResult> {
    if (!this.composeExecutor) {
      return {
        content: 'Compose tool is not available in this session configuration',
        isError: true,
      };
    }
    try {
      return await this.composeExecutor.execute(call);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Compose tool error: ${message}`, isError: true };
    }
  }

  /**
   * Fire-and-forget PostToolUse dispatch. Used by `executeCore` and the
   * compose path where the caller does not need to await the hook's
   * completion. Routes through `dispatchPostToolUse` so the
   * witness-layer `hook_decision` event lands automatically.
   *
   * `resultFlags` is an OPTIONAL trailing parameter (additive, back-compat):
   * callers that omit it get byte-identical behavior to before this field
   * existed — no new keys land on `postCtx`. Callers that have the full
   * `ToolResult` in scope (the agent/skill/compose/handler success paths in
   * `executeCoreInner`) pass it so a PostToolUse hook can read
   * `incomplete`/`incompleteReason` — the structured counterpart to the
   * `[⚠ PARTIAL RESULT…]` banner already in `output` — without substring-
   * matching that banner text.
   */
  private firePostToolUse(
    toolName: string,
    output: string,
    signal: AbortSignal,
    input?: unknown,
    resultFlags?: Pick<ToolResult, 'incomplete' | 'incompleteReason'>,
  ): void {
    if (!this.hookRegistry) return;
    const postCtx: PostToolUseContext = {
      event: 'PostToolUse',
      toolName,
      output,
      ...(input !== undefined ? { input } : {}),
      ...(this.parentSessionId !== undefined ? { parentSessionId: this.parentSessionId } : {}),
      // Mirror PreToolUse so the path-approval "Once"-grant revoke mutates the
      // SAME grant manager the Pre containment check consulted.
      ...(this.sessionGrantManager !== undefined
        ? { grantManager: this.sessionGrantManager }
        : {}),
      ...(resultFlags?.incomplete === true ? { incomplete: true } : {}),
      ...(resultFlags?.incompleteReason ? { incompleteReason: resultFlags.incompleteReason } : {}),
    };
    void dispatchPostToolUse(this.hookRegistry, postCtx, {
      signal,
      ...(this.traceWriter ? { traceWriter: this.traceWriter } : {}),
    }).catch(() => {});
  }

  /**
   * Fire-and-forget PostToolUseFailure dispatch. Mirrors firePostToolUse.
   * Called only from the catch paths where a tool handler threw — never from
   * the success path. Errors inside the hook are swallowed so a broken
   * failure-observer cannot propagate back to the tool dispatcher.
   */
  private firePostToolUseFailure(
    toolName: string,
    errorMessage: string,
    signal: AbortSignal,
    input?: unknown,
  ): void {
    if (!this.hookRegistry) return;
    const ctx: PostToolUseFailureContext = {
      event: 'PostToolUseFailure',
      toolName,
      error: errorMessage,
      ...(input !== undefined ? { input } : {}),
      ...(this.parentSessionId !== undefined ? { parentSessionId: this.parentSessionId } : {}),
    };
    void dispatchPostToolUseFailure(this.hookRegistry, ctx, {
      signal,
      ...(this.traceWriter ? { traceWriter: this.traceWriter } : {}),
    }).catch((err: unknown) => {
      debugLog(`firePostToolUseFailure outer catch (tool=${toolName}): ${String(err)}`);
    });
  }

}
