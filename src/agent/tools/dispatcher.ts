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
import { HookBlockedError } from '../../utils/errors.js';
import type { HookRegistry, PreToolUseContext, PostToolUseContext } from '../hooks.js';
import type { AnthropicToolDef } from '../providers/anthropic-direct/types.js';
import type { ToolDispatcher } from '../providers/anthropic-direct/tool-dispatcher.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import { dispatchPreToolUse, dispatchPostToolUse } from '../subagent-hooks.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { SkillExecutor } from './skill-executor.js';
import type { ComposeExecutor } from './compose-executor.js';
import type { ToolHandler, ToolHandlerContext, ConcurrencyClassifier } from './types.js';
import { checkToolPermission, type ToolPermissionConfig } from './permissions.js';
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
  hookRegistry?: HookRegistry;
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
  /** Optional per-session env injected into the Bash handler's spawn env. */
  private readonly _env: Record<string, string> | undefined;
  private readonly sessionId: string | undefined;
  private readonly parentSessionId: string | undefined;
  private readonly traceWriter: TraceWriter | undefined;

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
   */
  private get handlerContext(): ToolHandlerContext {
    return {
      cwd: this.resolveBase,
      resolveBase: this.resolveBase,
      readRoots: this._readRoots.slice(),
      writeRoots: this._writeRoots.slice(),
      ...(this._env !== undefined ? { env: this._env } : {}),
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
  getGrants(): { resolveBase: string | undefined; readRoots: string[]; writeRoots: string[] } {
    return {
      resolveBase: this.resolveBase,
      readRoots: this._readRoots.slice(),
      writeRoots: this._writeRoots.slice(),
    };
  }

  /**
   * Update the dispatcher's resolveBase to `newCwd`, propagating to:
   *   1. `this.resolveBase` (used by the `handlerContext` getter, /allow-dir
   *      non-revocable guard, and grant-API equality checks).
   *   2. `_readRoots` / `_writeRoots` — any entry that equals the prior
   *      resolveBase is replaced in place with `newCwd`. Other grants
   *      (added via /allow-dir) are preserved.
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

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.signal.aborted) {
      return { content: 'Tool call aborted', isError: true };
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
      };
    }

    // 3. Agent tool — provider-level dispatch
    if (call.name === 'agent') {
      if (!this.subagentExecutor) {
        return {
          content: 'Agent tool is not available in this session configuration',
          isError: true,
        };
      }
      let result: ToolResult;
      try {
        result = await this.subagentExecutor.execute(call);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { content: `Agent tool error: ${message}`, isError: true };
      }
      // PostToolUse hook fires for agent calls too.
      // Fire-and-forget: mirrors executeCore() — hook latency must not block
      // the tool result from being returned to the model on the critical path.
      this.firePostToolUse(call.name, result.content, call.signal);
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
      try {
        result = await this.skillExecutor.execute(call);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { content: `Skill tool error: ${message}`, isError: true };
      }
      // Fire-and-forget: mirrors executeCore() — hook + trace-write latency
      // must not add to per-tool round-trip time on the single-call path.
      this.firePostToolUse(call.name, result.content, call.signal);
      return result;
    }

    // 3c. Compose tool — DAG-based parallel subagent dispatch
    if (call.name === 'compose') {
      const result = await this.executeCompose(call);
      this.firePostToolUse(call.name, result.content, call.signal);
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
    try {
      result = await handler(call.input, call.signal, this.handlerContext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { content: `Tool execution error: ${message}`, isError: true };
    }

    // 6. PostToolUse hook — fire-and-forget to align with executeCore().
    // Errors are caught inside firePostToolUse (.catch(() => {})), so
    // hook failures never surface as tool errors (same behaviour as before).
    this.firePostToolUse(call.name, result.content, call.signal);

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
        results[i] = { content: 'Tool call aborted', isError: true };
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
        };
        blocked.add(i);
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
                result: { content: 'Tool call aborted', isError: true } as ToolResult,
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
            results[originalIndex] = { content: 'Tool call aborted', isError: true };
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
      try {
        result = await this.subagentExecutor.execute(call);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { content: `Agent tool error: ${message}`, isError: true };
      }
      this.firePostToolUse(call.name, result.content, call.signal);
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
      try {
        result = await this.skillExecutor.execute(call);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { content: `Skill tool error: ${message}`, isError: true };
      }
      this.firePostToolUse(call.name, result.content, call.signal);
      return result;
    }

    // Compose tool — DAG-based parallel subagent dispatch
    if (call.name === 'compose') {
      const result = await this.executeCompose(call);
      this.firePostToolUse(call.name, result.content, call.signal);
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
    try {
      result = await handler(call.input, call.signal, this.handlerContext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { content: `Tool execution error: ${message}`, isError: true };
    }

    this.firePostToolUse(call.name, result.content, call.signal);
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
  private firePostToolUse(toolName: string, output: string, signal: AbortSignal): void {
    if (!this.hookRegistry) return;
    const postCtx: PostToolUseContext = {
      event: 'PostToolUse',
      toolName,
      output,
    };
    void dispatchPostToolUse(this.hookRegistry, postCtx, {
      signal,
      ...(this.traceWriter ? { traceWriter: this.traceWriter } : {}),
    }).catch(() => {});
  }

}
