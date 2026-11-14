/**
 * Construction options for {@link SessionToolDispatcher}.
 *
 * Extracted from `dispatcher.ts` (one whole concern) to keep that file within
 * the 350-code-line ceiling. Re-exported from `dispatcher.ts`, so existing
 * importers of `SessionToolDispatcherOptions` are unaffected.
 *
 * @module agent/tools/dispatcher.options
 */

import type { HookRegistry } from '../hooks.js';
import type { AnthropicToolDef } from '../providers/anthropic-direct/types.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { SkillExecutor } from './skill-executor.js';
import type { ComposeExecutor } from './compose-executor.js';
import type { ToolHandler, ConcurrencyClassifier } from './types.js';
import type { SpawnedPidRegistry } from './handlers/pid-registry.js';
import type { ToolPermissionConfig } from './permissions.js';
import type { CanUseTool } from '../types/sdk-types.js';
import type { GrantManager } from './grant-manager.js';
import type { TraceSink } from '../trace/index.js';
import type { GetMcpServerStates } from './dispatcher.mcp-states.js';
import type { UserAttention } from './user-yield.js';
import type { DetachableToolRegistry } from './detach-bash.js';
import type { ProcessJobRegistry } from '../shell-jobs/process-jobs.js';
import type { ToolCallLedgerWiring } from './dispatcher.ledger.js';

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
  /** Live MCP server states. MCP-aware unknown-tool messages (#4064). */
  getMcpServerStates?: GetMcpServerStates;
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
   * Root (depth-0) session id, inherited from {@link AgentConfig.rootSessionId}.
   * Undefined for top-level (depth-0) sessions. Stamped on PostToolUse so
   * child-attribution credits artifacts to the root record regardless of depth.
   */
  rootSessionId?: string;
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
   * that construct directly leave it unset; path-approval then fails open (no
   * containment prompt, handler resolveAndContain still enforces) and the bash
   * restriction hook treats the context as headless (unfiltered floor, #2302).
   *
   * Presence of a grant manager is NOT an "interactive surface" signal: both
   * production providers wire it on every surface (daemon, `afk chat`, forks
   * included). Use {@link isNonInteractive} for that.
   */
  sessionGrantManager?: GrantManager;
  /**
   * `isHeadlessSession(config)` of the owning session: no human can approve
   * a prompt (`afk chat`, every daemon task including pull, forks by default). Injected
   * onto every PreToolUse context as `context.nonInteractive` (only when true)
   * so the bash-restriction hook applies its unfiltered headless floor even
   * though a grant manager is wired (#2302). Default false.
   */
  isNonInteractive?: boolean;
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
   * Operator-attention probe for the yield contract (`./user-yield.ts`).
   * Attached per call to yieldable tools only; see `callHandlerContext`.
   */
  userAttention?: UserAttention;
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
  /**
   * Detach registry for the Ctrl+B backgrounding contract (#2542).
   *
   * When present, `callHandlerContext` injects it into the context of every
   * handler-backed tool in {@link DETACHABLE_TOOLS} (currently `bash`) so those
   * handlers can register their in-flight calls and respond to detachment.
   * `compose` is also in `DETACHABLE_TOOLS` but bypasses `callHandlerContext` —
   * it receives the registry directly via `coreExecDeps().detachRegistry`.
   * Absent for headless surfaces, subagent children, and one-shot CLI runs
   * that have no REPL to inject the result into.
   */
  detachRegistry?: DetachableToolRegistry;
  /**
   * Background process registry (`bash run_in_background`). Root interactive
   * sessions only; handed to `bash` and to the background health/cancel tools
   * for `proc-` ids. Never propagated to subagent children.
   */
  processJobs?: ProcessJobRegistry;
  /**
   * Session-scoped tool-call ledger wiring (#4476). Providers pass ONE instance
   * per session so the ledger and its round counter survive per-query
   * dispatcher rebuilds; omitted ⇒ the dispatcher creates its own. Never shared
   * with forked children — each child provider owns its own.
   */
  toolCallLedger?: ToolCallLedgerWiring;
}
