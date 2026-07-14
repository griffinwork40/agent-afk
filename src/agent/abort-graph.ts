/**
 * Transitive AbortController graph.
 *
 * Manages a tree of named {@link AbortController}s so that aborting a parent
 * cascades to all descendants, while a child's abort only *notifies* its
 * parent (it does not auto-abort the parent).
 *
 * Key semantics — Phase 3 hook work must not invert these:
 * - An aborted signal is terminal. Any abort-signal check is unconditional —
 *   if the signal is aborted, callers must throw {@link AbortError} even if a
 *   hook is pending or would have returned `continue: true`.
 * - Abort takes precedence over every other decision surface.
 *
 * Witness layer: when constructed with a {@link TraceWriter}, every `abort()`
 * call emits a single `abort` trace event carrying the BFS-computed
 * `cascadedTo[]` list. The origin discriminant lets readers distinguish
 * user-initiated cancellation from timeout, budget, hook-block, and cascade-
 * driven aborts. See `docs/philosophy/afk-contract.md`.
 *
 * @module agent/abort-graph
 */

import { emitAbort } from './trace/emit.js';
import type { AbortOrigin, TraceWriter } from './trace/index.js';

export interface ChildAbortedEvent {
  parentId: string;
  childId: string;
  reason?: unknown;
}

export type ChildAbortedListener = (event: ChildAbortedEvent) => void;

interface GraphNode {
  controller: AbortController;
  children: Set<string>;
  parentId?: string;
  listeners: Set<ChildAbortedListener>;
  /** Set during cascade so child-abort handlers suppress redundant parent notifications. */
  cascading: boolean;
}

export class AbortGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly traceWriter: TraceWriter | undefined;

  constructor(traceWriter?: TraceWriter) {
    this.traceWriter = traceWriter;
  }

  register(id: string, controller: AbortController): void {
    if (this.nodes.has(id)) return;
    this.nodes.set(id, {
      controller,
      children: new Set(),
      listeners: new Set(),
      cascading: false,
    });
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  getController(id: string): AbortController | undefined {
    return this.nodes.get(id)?.controller;
  }

  /**
   * Snapshot of the parent's child set. Returns `[]` if the parent is
   * not registered. Used by tests + diagnostics to verify that `dispose`
   * actually cut the parent→child edge (not just removed the child node).
   */
  childrenOf(id: string): string[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return Array.from(node.children);
  }

  /**
   * Whether `id` was aborted as part of an ancestor cascade — its `cascading`
   * flag is set by {@link linkChild} (parent already/becomes aborted) or by
   * {@link abort}'s BFS over descendants. Lets a node distinguish an INHERITED
   * abort reason (cascaded from an ancestor, e.g. an ancestor's wall-clock
   * TimeoutError) from its OWN directly-fired abort (its own budget expiry).
   * Returns false for unknown ids and for a node that fired its own abort.
   * Observational only — does not change cascade behavior.
   */
  isCascading(id: string): boolean {
    return this.nodes.get(id)?.cascading ?? false;
  }

  /**
   * Link a registered child to a registered parent.
   * - If the parent is already aborted, the child aborts synchronously with the same reason.
   * - Parent abort propagates to this child with `cascading=true`.
   * - Child abort notifies the parent's listeners unless it was a cascade.
   */
  linkChild(parentId: string, childId: string): void {
    const parent = this.nodes.get(parentId);
    const child = this.nodes.get(childId);
    if (!parent) throw new Error(`AbortGraph: parent ${parentId} not registered`);
    if (!child) throw new Error(`AbortGraph: child ${childId} not registered`);

    child.parentId = parentId;
    parent.children.add(childId);

    if (parent.controller.signal.aborted) {
      if (!child.controller.signal.aborted) {
        child.cascading = true;
        child.controller.abort(parent.controller.signal.reason);
      }
      return;
    }

    parent.controller.signal.addEventListener(
      'abort',
      () => {
        const currentChild = this.nodes.get(childId);
        // If disposed, skip — the link no longer represents the caller's intent.
        if (!currentChild || currentChild.parentId !== parentId) return;
        if (currentChild.controller.signal.aborted) return;
        currentChild.cascading = true;
        currentChild.controller.abort(parent.controller.signal.reason);
      },
      { once: true },
    );

    child.controller.signal.addEventListener(
      'abort',
      () => {
        const currentChild = this.nodes.get(childId);
        if (!currentChild || currentChild.parentId !== parentId) return;
        if (currentChild.cascading) return;
        const currentParent = this.nodes.get(parentId);
        if (!currentParent) return;
        const event: ChildAbortedEvent = {
          parentId,
          childId,
          reason: currentChild.controller.signal.reason,
        };
        for (const listener of currentParent.listeners) {
          try {
            listener(event);
          } catch {
            // listener errors are isolated
          }
        }
      },
      { once: true },
    );
  }

  /** Subscribe to child-abort events under `parentId`. Returns an unsubscribe function. */
  onChildAborted(parentId: string, listener: ChildAbortedListener): () => void {
    const node = this.nodes.get(parentId);
    if (!node) throw new Error(`AbortGraph: ${parentId} not registered`);
    node.listeners.add(listener);
    return () => {
      node.listeners.delete(listener);
    };
  }

  /**
   * Abort `id` and cascade to all descendants.
   * The root's abort listeners fire on its parent (if any); descendants' listeners
   * are suppressed because they're part of the cascade.
   *
   * @param origin Witness-layer classification — defaults to `'user_signal'`
   *   when omitted. Callers that have richer context (budget breach, timeout
   *   fire, cascade from a parent signal) should pass the matching origin so
   *   trace readers can disambiguate the abort source from the reason string.
   *   The origin is observational only — it does not change cascade behavior.
   */
  abort(id: string, reason?: unknown, origin: AbortOrigin = 'user_signal'): void {
    const root = this.nodes.get(id);
    if (!root) return;
    if (root.controller.signal.aborted) return;

    // BFS over descendants. We materialize the full list BEFORE firing any
    // controller.abort() — two reasons:
    //   1. The `cascadedTo[]` payload must reflect every node this abort
    //      reached, even if a downstream listener disposes a node mid-cascade.
    //   2. Firing aborts inside the BFS would race the abort listeners
    //      registered in linkChild — they re-read this.nodes, so a partially-
    //      built descendants array would be observable.
    const descendants: string[] = [];
    const queue = [...root.children];
    const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = this.nodes.get(current);
      if (!node) continue;
      node.cascading = true;
      descendants.push(current);
      for (const childId of node.children) queue.push(childId);
    }

    // Witness layer: emit BEFORE the controllers fire. Reasons:
    //   - The cascadedTo list is fully known here; no race with disposal.
    //   - Downstream listeners (e.g. SubagentHandleImpl's run-catch path)
    //     emit subagent_lifecycle records once their controller fires; we
    //     want this abort record to precede those in the trace so a reader
    //     can correlate the lifecycle events back to the originating abort.
    // Fire-and-forget — emitAbort swallows writer errors internally so a
    // broken sink never blocks the cascade.
    void emitAbort(this.traceWriter, {
      origin,
      cascadedTo: descendants,
      ...(reason !== undefined ? { reason: stringifyReason(reason) } : {}),
    });

    root.controller.abort(reason);
    for (const descId of descendants) {
      const node = this.nodes.get(descId);
      if (node && !node.controller.signal.aborted) {
        node.controller.abort(reason);
      }
    }
  }

  /**
   * Remove `id` from the graph. Descendants become orphans (lose parent link).
   * Does NOT abort the node — callers can dispose cleanly on normal close.
   */
  dispose(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      parent?.children.delete(id);
    }
    for (const childId of node.children) {
      const childNode = this.nodes.get(childId);
      if (childNode) childNode.parentId = undefined;
    }
    this.nodes.delete(id);
  }
}

/**
 * Coerce an arbitrary abort-reason (commonly a string, sometimes an Error
 * thrown from a hook) into the string the trace event records. Keeps the
 * payload schema's `reason: string` invariant without leaking object
 * references into the JSONL sink.
 */
function stringifyReason(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
