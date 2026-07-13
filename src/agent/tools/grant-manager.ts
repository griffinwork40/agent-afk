/**
 * PathGrantManager — the single shared implementation of the path-grant /
 * permission-root API (issues #361/#362).
 *
 * History: this logic previously existed as three near-verbatim copies —
 * `SessionToolDispatcher` (tools/dispatcher.ts), `AnthropicDirectProvider`
 * (providers/anthropic-direct/index.ts, "GrantManager interface") and
 * `OpenAICompatibleProvider` (providers/openai-compatible/index.ts, "parity
 * with AnthropicDirectProvider"). The provider copies were byte-identical in
 * logic; the dispatcher copy diverged in three intentional, per-consumer
 * ways. Those divergences are preserved here as constructor hooks rather
 * than unified, so each consumer's observable behavior is unchanged:
 *
 *   1. Storage & init — providers lazily create shared root arrays on first
 *      use (`/allow-dir` may run before the first `query()`), the dispatcher
 *      owns eager arrays from construction. Parameterized via
 *      `getReadRoots`/`getWriteRoots` (may return `undefined` = uninitialized)
 *      plus the optional `ensureInitialized` pre-add hook.
 *   2. Non-revocable anchor — the dispatcher protects its CURRENT
 *      `resolveBase` (which `setResolveBase()` migrates on worktree rename),
 *      the providers protect the session's INITIAL resolveBase (fixed at
 *      session start, preserved across renames). Parameterized via
 *      `getProtectedRoot`, which also supplies the `resolveBase` field of
 *      `getGrants()` — both anchors double as the displayed base in their
 *      original copies.
 *   3. Audit sessionId sourcing — the dispatcher binds a sessionId at
 *      construction (`this.sessionId ?? null`), the providers thread a
 *      per-call `sessionId?` argument (`entry.sessionId ?? null`).
 *      Parameterized via the per-call argument with fallback to the optional
 *      `getDefaultSessionId` hook.
 *
 * `allowAll` in `getGrants()` likewise differs per consumer (dispatcher: live
 * `setAllowAll` boolean — the file-tool half of `/bypass`; providers: derived
 * from the current permission mode — the path-approval-hook half) and is
 * supplied via `getAllowAll`.
 *
 * Each consumer constructs its OWN instance; grant state is never shared
 * across consumers (matching the pre-consolidation copies, which each held
 * independent instance state — no module-scope state existed in any copy).
 *
 * @module agent/tools/grant-manager
 */

import path from 'path';
import { dirname } from 'path';
import { appendFileSync, mkdirSync } from 'fs';
import { getSessionGrantsPath } from '../../paths.js';

/** Audit-log actions emitted to `session-grants.jsonl`. */
export type GrantAuditAction = 'grant-read' | 'grant-write' | 'revoke';

/** Provenance of a grant mutation: `/allow-dir` slash command or tool flow. */
export type GrantSource = 'slash' | 'tool';

/** Snapshot shape returned by {@link PathGrantManager.getGrants}. */
export interface GrantSnapshot {
  resolveBase: string | undefined;
  readRoots: string[];
  writeRoots: string[];
  allowAll: boolean;
}

/**
 * Consumer-supplied hooks that parameterize the per-consumer divergences
 * documented in the module header. All accessors are called fresh on every
 * operation so live consumer state (mode toggles, cwd migration, lazy array
 * init) is always reflected.
 */
export interface PathGrantManagerHooks {
  /**
   * Live read-root array, or `undefined` when not yet initialized (provider
   * lazy-init pattern). Mutated IN PLACE by add/revoke so callers sharing the
   * array by reference (per-query dispatchers) see changes immediately.
   */
  getReadRoots(): string[] | undefined;
  /** Live write-root array — same contract as {@link getReadRoots}. */
  getWriteRoots(): string[] | undefined;
  /**
   * Called before any add operation. Providers use this to lazily create the
   * shared root arrays (`ensureSharedRoots`); the dispatcher omits it (its
   * arrays are eager constructor state).
   */
  ensureInitialized?(): void;
  /**
   * The non-revocable root at revoke time, doubling as the `resolveBase`
   * reported by `getGrants()`. Dispatcher: current `resolveBase` (migrates on
   * rename). Providers: initial resolveBase (fixed at session start).
   */
  getProtectedRoot(): string | undefined;
  /** The `allowAll` value reported by `getGrants()` (see module header). */
  getAllowAll(): boolean;
  /**
   * Fallback sessionId for audit entries when no per-call sessionId is given.
   * Dispatcher: the construction-bound sessionId. Providers: omitted (their
   * callers thread sessionId per call).
   */
  getDefaultSessionId?(): string | undefined;
}

/**
 * Shared path-grant state machine. Composed (instance field + delegating
 * methods) into `SessionToolDispatcher`, `AnthropicDirectProvider` and
 * `OpenAICompatibleProvider`, whose public grant surfaces are unchanged.
 */
export class PathGrantManager {
  private readonly hooks: PathGrantManagerHooks;

  constructor(hooks: PathGrantManagerHooks) {
    this.hooks = hooks;
  }

  /**
   * Grant read access to `absPath`. No-op if already present.
   *
   * Invariant: the audit append fires ONLY when `p` is newly added. Re-granting
   * an already-granted path is a state no-op and must not emit a duplicate
   * ledger record — the previous unconditional append let per-tool-call
   * re-grants of the same root balloon `session-grants.jsonl` ~196x (1,143
   * unique grants → 224k rows before this fix).
   */
  addReadRoot(absPath: string, source: GrantSource = 'slash', sessionId?: string): void {
    this.hooks.ensureInitialized?.();
    const readRoots = this.hooks.getReadRoots();
    if (!readRoots) return;
    const p = path.resolve(absPath);
    if (!readRoots.includes(p)) {
      readRoots.push(p);
      this.appendAuditLog({ action: 'grant-read', path: p, source, sessionId });
    }
  }

  /**
   * Grant read + write access to `absPath`. Ensures path is in BOTH lists.
   * Audits `grant-write` only when `p` is newly added to the write roots, so a
   * read→write upgrade still records (new to writeRoots) while a repeat
   * write-grant is silent. See `addReadRoot` for the dedup rationale.
   */
  addWriteRoot(absPath: string, source: GrantSource = 'slash', sessionId?: string): void {
    this.hooks.ensureInitialized?.();
    const readRoots = this.hooks.getReadRoots();
    const writeRoots = this.hooks.getWriteRoots();
    if (!readRoots || !writeRoots) return;
    const p = path.resolve(absPath);
    if (!readRoots.includes(p)) {
      readRoots.push(p);
    }
    if (!writeRoots.includes(p)) {
      writeRoots.push(p);
      this.appendAuditLog({ action: 'grant-write', path: p, source, sessionId });
    }
  }

  /**
   * Remove `absPath` from both root lists. The protected root (see
   * {@link PathGrantManagerHooks.getProtectedRoot}) is non-revocable:
   * attempts to revoke it are silently ignored. When the read-root array is
   * uninitialized (provider called before any init), this is a silent no-op
   * that emits NO audit record — matching the prior provider copies.
   */
  revokeRoot(absPath: string, source: GrantSource = 'slash', sessionId?: string): void {
    const readRoots = this.hooks.getReadRoots();
    if (!readRoots) return;
    const p = path.resolve(absPath);
    const protectedRoot = this.hooks.getProtectedRoot();
    if (protectedRoot !== undefined && p === protectedRoot) return;

    const rIdx = readRoots.indexOf(p);
    if (rIdx !== -1) readRoots.splice(rIdx, 1);

    const writeRoots = this.hooks.getWriteRoots();
    if (writeRoots) {
      const wIdx = writeRoots.indexOf(p);
      if (wIdx !== -1) writeRoots.splice(wIdx, 1);
    }

    this.appendAuditLog({ action: 'revoke', path: p, source, sessionId });
  }

  /** Returns a snapshot of current grant state (for /allow-dir display). */
  getGrants(): GrantSnapshot {
    return {
      resolveBase: this.hooks.getProtectedRoot(),
      readRoots: this.hooks.getReadRoots()?.slice() ?? [],
      writeRoots: this.hooks.getWriteRoots()?.slice() ?? [],
      allowAll: this.hooks.getAllowAll(),
    };
  }

  private appendAuditLog(entry: {
    action: GrantAuditAction;
    path: string;
    source: GrantSource;
    sessionId?: string;
  }): void {
    try {
      const logPath = getSessionGrantsPath();
      mkdirSync(dirname(logPath), { recursive: true });
      // Contract: emit a stable `{ timestamp, sessionId, action, path, source }`
      // shape — `sessionId` key is always present, coalesced to `null` when
      // neither a per-call sessionId nor a consumer default is bound. This
      // preserves the schema symmetry the three pre-consolidation emission
      // sites converged on (see dispatcher-audit-log.test.ts).
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: entry.sessionId ?? this.hooks.getDefaultSessionId?.() ?? null,
        action: entry.action,
        path: entry.path,
        source: entry.source,
      });
      appendFileSync(logPath, line + '\n');
    } catch {
      // Audit log is best-effort — never fail a grant operation due to log I/O.
    }
  }
}
