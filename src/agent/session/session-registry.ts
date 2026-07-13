/**
 * Surface-agnostic session registry — AFK's durable session-identity layer.
 *
 * The registry is the single source of truth for "what sessions exist and how
 * each surface reaches them". It holds durable METADATA + BINDINGS only; the
 * live `IAgentSession` objects stay owned by each surface adapter (e.g. the
 * Telegram `SessionManager`), keyed by `SessionHandle.id`. This keeps the
 * registry pure, testable, and persistable.
 *
 * Identity model:
 *   - `SessionHandle.id` is the registry's own primary key, minted at create()
 *     time (UUID) and STABLE for the session's life. Live-session maps key on
 *     this — NOT on the SDK sessionId, which is late-bound (undefined until the
 *     provider stream emits it mid-first-turn; see session-state.ts
 *     `updateSessionIdentity`).
 *   - `SessionHandle.sdkSessionId` is that late-bound attribute, attached via
 *     `attachSdkSessionId()` once known. Used only for the sidecar filename and
 *     `--resume` continuity — never for routing.
 *   - A `SessionBinding` maps an opaque, adapter-owned `key` on a `surface` to a
 *     handle. MANY bindings can point at ONE handle (a CLI REPL and a Telegram
 *     tab tailing the same session). `resolve(surface, key)` is the router.
 *
 * This module is intentionally dependency-light (no `AgentSession` import) so it
 * can back telemetry, the Telegram adapter, and the CLI resume path without
 * pulling in the heavy session runtime. Step 1 ships an in-memory impl; a
 * persistence-backed impl (over the sidecar store) implements the same
 * `SessionRegistry` interface in a later step.
 *
 * @module agent/session/session-registry
 */

import { randomUUID } from 'node:crypto';
import type { AgentModelInput } from '../types.js';

/** User-facing surface that owns a binding. Aligns with session-identity's TraceOrigin (minus 'unknown'). */
export type SessionSurface = 'cli' | 'telegram' | 'daemon';

/** Lifecycle state of a handle. `archived` handles never `resolve()` for routing. */
export type SessionStatus = 'active' | 'archived';

/**
 * Branded primary key for a registry handle. Distinct from a bare `string` (and
 * from a Telegram `chatId: number`) so a cross-session mis-key is a type error,
 * not a runtime leak. Construct via {@link asHandleId} or `create()`.
 */
export type HandleId = string & { readonly __brand: 'HandleId' };

/** Assert an opaque string is a HandleId (rehydration from persistence, tests). */
export function asHandleId(id: string): HandleId {
  return id as HandleId;
}

/** An adapter's routing reference: an opaque `key` scoped to a `surface`. */
export interface BindingRef {
  surface: SessionSurface;
  key: string;
}

/** A stored binding: a {@link BindingRef} plus registry-managed timestamps. */
export interface SessionBinding extends BindingRef {
  boundAt: number;
  lastActiveAt: number;
}

/** The durable record for one session. Metadata + bindings; no live runtime state. */
export interface SessionHandle {
  /** Registry primary key — minted at create(), stable for life. */
  id: HandleId;
  /** Late-bound SDK/provider session id (sidecar filename + --resume). Absent until attached. */
  sdkSessionId?: string;
  /** Origin surface that created the handle. */
  surface: SessionSurface;
  /** Human-readable label (auto from first turn, or set via a /name-style command). */
  name?: string;
  model: AgentModelInput;
  cwd?: string;
  createdAt: number;
  lastActiveAt: number;
  status: SessionStatus;
  /** ≥1 while active. Many bindings may point at this one handle (cross-surface). */
  bindings: SessionBinding[];
}

/** Options for {@link SessionRegistry.create}. */
export interface CreateSessionOptions {
  surface: SessionSurface;
  model: AgentModelInput;
  /** Initial binding key on `surface` (e.g. Telegram routeKey, CLI resume-name). */
  key: string;
  cwd?: string;
  name?: string;
  sdkSessionId?: string;
  /** Rehydration only: reuse a persisted id instead of minting one. */
  id?: HandleId;
  /** Rehydration only: reuse a persisted creation time instead of now(). */
  createdAt?: number;
}

/** Filter for {@link SessionRegistry.list}. */
export interface ListFilter {
  surface?: SessionSurface;
  status?: SessionStatus;
}

/**
 * Surface-agnostic session registry. All accessors return SNAPSHOTS (deep-ish
 * clones); callers mutate registry state only through the mutator methods.
 */
export interface SessionRegistry {
  create(opts: CreateSessionOptions): SessionHandle;
  get(id: HandleId): SessionHandle | undefined;
  getBySdkSessionId(sdkSessionId: string): SessionHandle | undefined;
  /** Router: the active handle bound to (surface, key), or undefined. Never resolves an archived handle. */
  resolve(surface: SessionSurface, key: string): SessionHandle | undefined;
  /** Add or refresh a binding on a handle. Re-points the key away from any prior owner (last-writer-wins). */
  bind(id: HandleId, ref: BindingRef): void;
  /** Remove a binding by (surface, key) from whichever handle owns it. */
  unbind(surface: SessionSurface, key: string): void;
  /** Attach (or update) the late-bound SDK session id and index it for reverse lookup. */
  attachSdkSessionId(id: HandleId, sdkSessionId: string): void;
  rename(id: HandleId, name: string): void;
  /** Bump lastActiveAt (e.g. on each turn) for list ordering. */
  touch(id: HandleId): void;
  /** Mark archived and free all its binding keys (so future messages create a fresh handle). Handle is retained for list/resume. */
  archive(id: HandleId): void;
  list(filter?: ListFilter): SessionHandle[];
}

/** Thrown when a mutator targets an id that is not registered. */
export class SessionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionRegistryError';
  }
}

/** In-memory {@link SessionRegistry}. The Step-1 impl; persistence backs it later. */
export class InMemorySessionRegistry implements SessionRegistry {
  private readonly byId = new Map<HandleId, SessionHandle>();
  private readonly byBinding = new Map<string, HandleId>();
  private readonly bySdk = new Map<string, HandleId>();
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  create(opts: CreateSessionOptions): SessionHandle {
    const now = this.now();
    const id = opts.id ?? asHandleId(randomUUID());
    if (this.byId.has(id)) {
      throw new SessionRegistryError(`session handle already exists: ${id}`);
    }
    const binding: SessionBinding = {
      surface: opts.surface,
      key: opts.key,
      boundAt: now,
      lastActiveAt: now,
    };
    const handle: SessionHandle = {
      id,
      surface: opts.surface,
      model: opts.model,
      createdAt: opts.createdAt ?? now,
      lastActiveAt: now,
      status: 'active',
      bindings: [binding],
    };
    if (opts.name !== undefined) handle.name = opts.name;
    if (opts.cwd !== undefined) handle.cwd = opts.cwd;
    if (opts.sdkSessionId !== undefined) handle.sdkSessionId = opts.sdkSessionId;

    this.byId.set(id, handle);
    this.pointBinding(this.bindingKey(binding.surface, binding.key), id);
    if (handle.sdkSessionId !== undefined) this.bySdk.set(handle.sdkSessionId, id);
    return this.clone(handle);
  }

  get(id: HandleId): SessionHandle | undefined {
    const h = this.byId.get(id);
    return h ? this.clone(h) : undefined;
  }

  getBySdkSessionId(sdkSessionId: string): SessionHandle | undefined {
    const id = this.bySdk.get(sdkSessionId);
    if (id === undefined) return undefined;
    const h = this.byId.get(id);
    return h ? this.clone(h) : undefined;
  }

  resolve(surface: SessionSurface, key: string): SessionHandle | undefined {
    const id = this.byBinding.get(this.bindingKey(surface, key));
    if (id === undefined) return undefined;
    const h = this.byId.get(id);
    // Invariant: archived handles never route. archive() frees their keys, but
    // guard here too so a stale index entry can never cross-route a message.
    if (!h || h.status !== 'active') return undefined;
    return this.clone(h);
  }

  bind(id: HandleId, ref: BindingRef): void {
    const h = this.require(id);
    const now = this.now();
    const k = this.bindingKey(ref.surface, ref.key);
    const existing = h.bindings.find((b) => this.bindingKey(b.surface, b.key) === k);
    if (existing) {
      existing.lastActiveAt = now;
    } else {
      h.bindings.push({ surface: ref.surface, key: ref.key, boundAt: now, lastActiveAt: now });
    }
    this.pointBinding(k, id);
    h.lastActiveAt = now;
  }

  unbind(surface: SessionSurface, key: string): void {
    const k = this.bindingKey(surface, key);
    const id = this.byBinding.get(k);
    this.byBinding.delete(k);
    if (id === undefined) return;
    const h = this.byId.get(id);
    if (h) h.bindings = h.bindings.filter((b) => this.bindingKey(b.surface, b.key) !== k);
  }

  attachSdkSessionId(id: HandleId, sdkSessionId: string): void {
    const h = this.require(id);
    if (h.sdkSessionId !== undefined && h.sdkSessionId !== sdkSessionId) {
      if (this.bySdk.get(h.sdkSessionId) === id) this.bySdk.delete(h.sdkSessionId);
    }
    h.sdkSessionId = sdkSessionId;
    this.bySdk.set(sdkSessionId, id);
    h.lastActiveAt = this.now();
  }

  rename(id: HandleId, name: string): void {
    const h = this.require(id);
    h.name = name;
    h.lastActiveAt = this.now();
  }

  touch(id: HandleId): void {
    const h = this.require(id);
    h.lastActiveAt = this.now();
  }

  archive(id: HandleId): void {
    const h = this.require(id);
    h.status = 'archived';
    h.lastActiveAt = this.now();
    // Free every key this handle held so a future message on the same route
    // creates a fresh handle instead of resolving the archived one. bindings[]
    // is retained on the handle as a historical record.
    for (const b of h.bindings) {
      const k = this.bindingKey(b.surface, b.key);
      if (this.byBinding.get(k) === id) this.byBinding.delete(k);
    }
  }

  list(filter?: ListFilter): SessionHandle[] {
    const out: SessionHandle[] = [];
    for (const h of this.byId.values()) {
      if (filter?.surface !== undefined && h.surface !== filter.surface) continue;
      if (filter?.status !== undefined && h.status !== filter.status) continue;
      out.push(this.clone(h));
    }
    out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return out;
  }

  private bindingKey(surface: SessionSurface, key: string): string {
    // NUL separator — cannot appear in a surface literal or a sane binding key.
    return `${surface}\u0000${key}`;
  }

  private require(id: HandleId): SessionHandle {
    const h = this.byId.get(id);
    if (!h) throw new SessionRegistryError(`unknown session handle: ${id}`);
    return h;
  }

  /** Point a binding key at `id`, detaching it from any different prior owner. */
  private pointBinding(k: string, id: HandleId): void {
    const prev = this.byBinding.get(k);
    if (prev !== undefined && prev !== id) {
      const prevHandle = this.byId.get(prev);
      if (prevHandle) {
        prevHandle.bindings = prevHandle.bindings.filter(
          (b) => this.bindingKey(b.surface, b.key) !== k,
        );
      }
    }
    this.byBinding.set(k, id);
  }

  /** Return a snapshot so callers can never mutate internal state directly. */
  private clone(h: SessionHandle): SessionHandle {
    return { ...h, bindings: h.bindings.map((b) => ({ ...b })) };
  }
}

/** Construct an isolated registry (tests, DI). */
export function createSessionRegistry(opts?: { now?: () => number }): SessionRegistry {
  return new InMemorySessionRegistry(opts);
}

/** Process-wide default registry singleton (used by surface adapters). */
export const sessionRegistry: SessionRegistry = new InMemorySessionRegistry();
