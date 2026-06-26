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

import path from 'path';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'node:crypto';
import { debugLog } from '../../utils/debug.js';
import { HookBlockedError } from '../../utils/errors.js';
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
import { classifyBashCommand } from './readonly-bash.js';
import { getSessionGrantsPath } from '../../paths.js';
import type { TraceWriter } from '../trace/index.js';
import { builtinToolSchemas, agentTool, skillTool, composeTool } from './schemas.js';
import { memoryToolSchemas } from '../memory/memory-tools.js';
import { getRuntimeStateTool } from '../awareness/index.js';

/**
 * Derived at module load from the union of all built-in tool schemas.
 * A tool is concurrency-safe when its schema declares `concurrencySafe: true`.
 * This replaces the former hand-maintained list and stays automatically in sync
 * with schema changes.
 *
 * External constraint: schemas.ts and memory-tools.ts are the single source
 * of truth. Mutations to those files propagate here without any secondary edit.
 */
const SAFE_TOOLS: ReadonlySet<string> = new Set(
  [
    ...builtinToolSchemas,
    agentTool,
    skillTool,
    composeTool,
    ...memoryToolSchemas,
    getRuntimeStateTool,
  ]
    .filter((s) => s.concurrencySafe === true)
    .map((s) => s.name),
);

export function defaultConcurrencyClassifier(toolName: string): boolean {
  return SAFE_TOOLS.has(toolName);
}

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
 * Stable fingerprint of a tool call for repeat detection: sha256 over
 * `name \0 JSON(input)`. Hashing bounds retained state to 64 hex chars
 * regardless of input size. Identical tool_use blocks from the model
 * serialize identically, so byte-identical calls collide as intended.
 */
function repeatCallFingerprint(call: ToolCall): string {
  let input: string;
  try {
    input = JSON.stringify(call.input) ?? 'null';
  } catch {
    input = String(call.input);
  }
  return createHash('sha256').update(call.name).update('\u0000').update(input).digest('hex');
}

interface Batch {
  isConcurrencySafe: boolean;
  indices: number[];
}

function partitionIntoBatches(
  calls: ToolCall[],
  classifier: ConcurrencyClassifier,
): Batch[] {
  return calls.reduce<Batch[]>((acc, call, i) => {
    const safe = classifier(call.name, call.input);
    const last = acc[acc.length - 1];
    if (last && safe && last.isConcurrencySafe) {
      last.indices.push(i);
    } else {
      acc.push({ isConcurrencySafe: safe, indices: [i] });
    }
    return acc;
  }, []);
}

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
  subagentExecutor?: SubagentExecutor;
  skillExecutor?: SkillExecutor;
  composeExecutor?: ComposeExecutor;
  concurrencyClassifier?: ConcurrencyClassifier;
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
}

export class SessionToolDispatcher implements ToolDispatcher {
  private readonly handlers: Map<string, ToolHandler>;
  private readonly schemas: AnthropicToolDef[];
  private readonly hookRegistry: HookRegistry | undefined;
  private readonly permissions: ToolPermissionConfig | undefined;
  private readonly subagentExecutor: SubagentExecutor | undefined;
  private readonly skillExecutor: SkillExecutor | undefined;
  private readonly composeExecutor: ComposeExecutor | undefined;
  private readonly classifier: ConcurrencyClassifier;
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
  private readonly traceWriter: TraceWriter | undefined;
  /** When true, mutating `bash` commands are blocked (read-only skill child). */
  private readonly readOnlyBash: boolean;
  /**
   * Repeat-loop circuit breaker state. The dispatcher is built per `query()`,
   * so this naturally tracks CONSECUTIVE byte-identical calls within a single
   * turn (across the loop's tool rounds) and resets between turns via
   * dispatcher reconstruction. See {@link checkRepeatCircuitBreaker}.
   */
  private repeatBreaker: { fingerprint: string; count: number } | null = null;

  constructor(opts: SessionToolDispatcherOptions) {
    this.handlers = opts.handlers;
    this.schemas = opts.schemas;
    this.hookRegistry = opts.hookRegistry;
    this.permissions = opts.permissions;
    this.subagentExecutor = opts.subagentExecutor;
    this.skillExecutor = opts.skillExecutor;
    this.composeExecutor = opts.composeExecutor;
    this.classifier = opts.concurrencyClassifier ?? defaultConcurrencyClassifier;
    this.resolveBase = opts.cwd;
    this._env = opts.env;
    this.sessionId = opts.sessionId;
    this.parentSessionId = opts.parentSessionId;
    this.traceWriter = opts.traceWriter;
    this.readOnlyBash = opts.readOnlyBash === true;
    this._allowAll = opts.allowAll === true;

    // When caller passes arrays by reference (provider sharing pattern), use
    // them directly so mutations are visible without rebuilding. Otherwise
    // create fresh arrays from the cwd default.
    const defaultRoots = opts.cwd ? [opts.cwd] : [];
    this._readRoots = opts.readRoots ?? defaultRoots.slice();
    this._writeRoots = opts.writeRoots ?? defaultRoots.slice();
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
  // Grant API
  // ---------------------------------------------------------------------------

  /**
   * Grant read access to `absPath`. No-op if already present.
   * `resolveBase` is always implicitly readable and need not be added.
   */
  addReadRoot(absPath: string, source: 'slash' | 'tool' = 'slash'): void {
    const p = path.resolve(absPath);
    if (!this._readRoots.includes(p)) {
      this._readRoots.push(p);
    }
    this.appendAuditLog({ action: 'grant-read', path: p, source });
  }

  /**
   * Grant read + write access to `absPath`. Ensures path is in BOTH lists.
   */
  addWriteRoot(absPath: string, source: 'slash' | 'tool' = 'slash'): void {
    const p = path.resolve(absPath);
    if (!this._readRoots.includes(p)) {
      this._readRoots.push(p);
    }
    if (!this._writeRoots.includes(p)) {
      this._writeRoots.push(p);
    }
    this.appendAuditLog({ action: 'grant-write', path: p, source });
  }

  /**
   * Remove `absPath` from both root lists. The initial `resolveBase` is
   * non-revocable: attempts to revoke it are silently ignored.
   */
  revokeRoot(absPath: string, source: 'slash' | 'tool' = 'slash'): void {
    const p = path.resolve(absPath);
    // resolveBase is non-revocable
    if (p === this.resolveBase) return;

    const rIdx = this._readRoots.indexOf(p);
    if (rIdx !== -1) this._readRoots.splice(rIdx, 1);

    const wIdx = this._writeRoots.indexOf(p);
    if (wIdx !== -1) this._writeRoots.splice(wIdx, 1);

    this.appendAuditLog({ action: 'revoke', path: p, source });
  }

  /** Returns a snapshot of current grant state (for /allow-dir display). */
  getGrants(): { resolveBase: string | undefined; readRoots: string[]; writeRoots: string[]; allowAll: boolean } {
    return {
      resolveBase: this.resolveBase,
      readRoots: this._readRoots.slice(),
      writeRoots: this._writeRoots.slice(),
      allowAll: this._allowAll,
    };
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

  private appendAuditLog(entry: {
    action: 'grant-read' | 'grant-write' | 'revoke';
    path: string;
    source: 'slash' | 'tool';
  }): void {
    try {
      const logPath = getSessionGrantsPath();
      mkdirSync(dirname(logPath), { recursive: true });
      // Schema symmetry with AnthropicDirectProvider.appendProviderAuditLog:
      // coalesce missing sessionId to `null` so consumers see a stable
      // `{ timestamp, sessionId, action, path, source }` shape from both
      // emission sites — `sessionId` key is always present.
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId ?? null,
        action: entry.action,
        path: entry.path,
        source: entry.source,
      });
      appendFileSync(logPath, line + '\n');
    } catch {
      // Audit log is best-effort — never fail a grant operation due to log I/O.
    }
  }

  get toolDefs(): readonly AnthropicToolDef[] {
    return this.schemas;
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
  private checkReadOnlyBash(call: ToolCall): ToolResult | null {
    if (!this.readOnlyBash || call.name !== 'bash') return null;
    const input = call.input;
    const command =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)['command']
        : undefined;
    if (typeof command !== 'string') return null;
    const verdict = classifyBashCommand(command);
    if (!verdict.mutating) return null;
    return {
      content:
        `Bash command blocked: read-only skill may not run mutating commands ` +
        `(${verdict.reason ?? 'mutation detected'}). Allowed: read-only recon ` +
        `(git status/log/diff, ls, cat, find, grep).`,
      isError: true,
      failureClass: 'permission-denied',
    };
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

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.signal.aborted) {
      return { content: 'Tool call aborted', isError: true, failureClass: 'abort' };
    }

    // 1. PreToolUse hook — can block. Routed through dispatchPreToolUse
    // so the witness-layer hook_decision event lands automatically.
    if (this.hookRegistry) {
      const preCtx: PreToolUseContext = {
        event: 'PreToolUse',
        toolName: call.name,
        input: call.input,
        ...(this.parentSessionId !== undefined
          ? { parentSessionId: this.parentSessionId }
          : {}),
      };
      try {
        await dispatchPreToolUse(this.hookRegistry, preCtx, {
          signal: call.signal,
          ...(this.traceWriter ? { traceWriter: this.traceWriter } : {}),
        });
      } catch (err) {
        if (err instanceof HookBlockedError) {
          return {
            content: `Tool "${call.name}" blocked by PreToolUse hook: ${err.message}`,
            isError: true,
            failureClass: 'hook-block',
          };
        }
        throw err;
      }
    }

    // 2. Permission check
    const permResult = checkToolPermission(call.name, this.permissions);
    if (!permResult.allowed) {
      return {
        content: permResult.reason ?? `Tool "${call.name}" is not permitted`,
        isError: true,
        failureClass: 'permission-denied',
      };
    }

    // 2b. Read-only-skill bash gate. Runs after the permission check so the
    // allowlist denial (if any) takes precedence; blocks mutating bash while
    // letting read-only recon through.
    const bashBlock = this.checkReadOnlyBash(call);
    if (bashBlock) return bashBlock;

    // 2c. Repeat-loop circuit breaker. Short-circuits no-progress loops where
    // the model calls the same tool with byte-identical input N times in a row.
    const repeatBlock = this.checkRepeatCircuitBreaker(call);
    if (repeatBlock) return repeatBlock;

    // 3. Agent tool — provider-level dispatch
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
      // PostToolUse hook fires for agent calls too.
      // Fire-and-forget: mirrors executeCore() — hook latency must not block
      // the tool result from being returned to the model on the critical path.
      if (agentThrew) {
        this.firePostToolUseFailure(call.name, agentErrMsg, call.signal, call.input);
      } else {
        this.firePostToolUse(call.name, result.content, call.signal, call.input);
      }
      return result;
    }

    // 3b. Skill tool — provider-level dispatch
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
      // Fire-and-forget: mirrors executeCore() — hook + trace-write latency
      // must not add to per-tool round-trip time on the single-call path.
      if (skillThrew) {
        this.firePostToolUseFailure(call.name, skillErrMsg, call.signal, call.input);
      } else {
        this.firePostToolUse(call.name, result.content, call.signal, call.input);
      }
      return result;
    }

    // 3c. Compose tool — DAG-based parallel subagent dispatch
    if (call.name === 'compose') {
      const result = await this.executeCompose(call);
      this.firePostToolUse(call.name, result.content, call.signal, call.input);
      return result;
    }

    // 4. Handler lookup
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return {
        content: `Unknown tool "${call.name}". Available tools: ${[...this.handlers.keys()].join(', ')}`,
        isError: true,
      };
    }

    // 5. Execute handler
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

    // 6. PostToolUse on success; PostToolUseFailure on thrown handler.
    // Invariant: exactly one of the two fires per execution — never both.
    if (handlerThrew) {
      this.firePostToolUseFailure(call.name, handlerErrMsg, call.signal, call.input);
    } else {
      this.firePostToolUse(call.name, result.content, call.signal, call.input);
    }

    return result;
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

      if (this.hookRegistry) {
        const preCtx: PreToolUseContext = {
          event: 'PreToolUse',
          toolName: call.name,
          input: call.input,
          ...(this.parentSessionId !== undefined
            ? { parentSessionId: this.parentSessionId }
            : {}),
        };
        try {
          await dispatchPreToolUse(this.hookRegistry, preCtx, {
            signal: call.signal,
            ...(this.traceWriter ? { traceWriter: this.traceWriter } : {}),
          });
        } catch (err) {
          if (err instanceof HookBlockedError) {
            results[i] = {
              content: `Tool "${call.name}" blocked by PreToolUse hook: ${err.message}`,
              isError: true,
              failureClass: 'hook-block',
            };
            blocked.add(i);
            continue;
          }
          throw err;
        }
      }

      const permResult = checkToolPermission(call.name, this.permissions);
      if (!permResult.allowed) {
        results[i] = {
          content: permResult.reason ?? `Tool "${call.name}" is not permitted`,
          isError: true,
          failureClass: 'permission-denied',
        };
        blocked.add(i);
        continue;
      }

      // Read-only-skill bash gate — mirror the permission-denied branch:
      // set the result and add to `blocked` so this call is excluded from
      // execution in phase 2.
      const bashBlock = this.checkReadOnlyBash(call);
      if (bashBlock) {
        results[i] = bashBlock;
        blocked.add(i);
        continue;
      }

      // Repeat-loop circuit breaker — same block-and-record shape as the bash
      // gate. Counting here (in the sequential phase-1 loop) keeps the
      // consecutive-call count correct even for parallel-safe batches.
      const repeatBlock = this.checkRepeatCircuitBreaker(call);
      if (repeatBlock) {
        results[i] = repeatBlock;
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
        const settled = await Promise.allSettled(
          batch.indices.map(async (batchIdx) => {
            const { call, originalIndex } = executableCalls[batchIdx]!;
            if (call.signal.aborted) {
              return {
                result: { content: 'Tool call aborted', isError: true, failureClass: 'abort' } as ToolResult,
                originalIndex,
              };
            }
            const result = await this.executeCore(call);
            return { result, originalIndex };
          }),
        );
        for (const outcome of settled) {
          if (outcome.status === 'fulfilled') {
            results[outcome.value.originalIndex] = outcome.value.result;
          } else {
            // Invariant: this branch is unreachable today. `executeCore` wraps
          // its entire body in try/catch and returns an isError ToolResult
          // rather than propagating — so the Promise passed to allSettled
          // always fulfills. The rejection path exists as a latent safety net
          // for future refactors that might let executeCore propagate. If that
          // happens, `firePostToolUseFailure` must be called here to preserve
          // the "exactly one of PostToolUse/PostToolUseFailure fires per call"
          // invariant documented at the executeCore dispatch site below.
          const msg = outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
            // Find the original index from the batch — allSettled preserves order
            const batchIdx = batch.indices[settled.indexOf(outcome)]!;
            results[executableCalls[batchIdx]!.originalIndex] = {
              content: `Tool execution error: ${msg}`,
              isError: true,
            };
          }
        }
      } else {
        for (const batchIdx of batch.indices) {
          const { call, originalIndex } = executableCalls[batchIdx]!;
          if (call.signal.aborted) {
            results[originalIndex] = { content: 'Tool call aborted', isError: true, failureClass: 'abort' };
            continue;
          }
          results[originalIndex] = await this.executeCore(call);
        }
      }
    }

    return results;
  }

  /**
   * Core execution: agent routing + handler dispatch + PostToolUse hook.
   * Shared by both `execute()` (single-tool path) and `executeBatch()`
   * (after pre-hooks and permissions are already handled).
   */
  private async executeCore(call: ToolCall): Promise<ToolResult> {
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
        this.firePostToolUse(call.name, result.content, call.signal, call.input);
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
        this.firePostToolUse(call.name, result.content, call.signal, call.input);
      }
      return result;
    }

    // Compose tool — DAG-based parallel subagent dispatch
    if (call.name === 'compose') {
      const result = await this.executeCompose(call);
      this.firePostToolUse(call.name, result.content, call.signal, call.input);
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
      this.firePostToolUse(call.name, result.content, call.signal, call.input);
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
   */
  private firePostToolUse(
    toolName: string,
    output: string,
    signal: AbortSignal,
    input?: unknown,
  ): void {
    if (!this.hookRegistry) return;
    const postCtx: PostToolUseContext = {
      event: 'PostToolUse',
      toolName,
      output,
      ...(input !== undefined ? { input } : {}),
      ...(this.parentSessionId !== undefined ? { parentSessionId: this.parentSessionId } : {}),
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
