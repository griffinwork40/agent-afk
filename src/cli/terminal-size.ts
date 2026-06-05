/**
 * Terminal dimensions and a debounced resize fan-out bus.
 *
 * `ResizeBus` registers a single `process.stdout` resize listener and notifies
 * all subscribers after a short debounce so rapid window drags coalesce.
 */

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEBOUNCE_MS = 150;

/** Visible terminal width in columns, or 80 when unknown. */
export function getTerminalWidth(): number {
  const c = process.stdout.columns;
  return typeof c === 'number' && c > 0 ? c : DEFAULT_COLUMNS;
}

/** Visible terminal height in rows, or 24 when unknown. */
export function getTerminalHeight(): number {
  const r = process.stdout.rows;
  return typeof r === 'number' && r > 0 ? r : DEFAULT_ROWS;
}

const subscribers = new Set<() => void>();
const immediateSubscribers = new Set<() => void>();
let attached = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function notifyAll(): void {
  for (const fn of subscribers) {
    try {
      fn();
    } catch {
      /* subscriber errors must not break the bus */
    }
  }
}

function notifyImmediate(): void {
  for (const fn of immediateSubscribers) {
    try {
      fn();
    } catch {
      /* subscriber errors must not break the bus */
    }
  }
}

function scheduleNotify(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    notifyAll();
  }, DEBOUNCE_MS);
}

function onStdoutResize(): void {
  // Invariant (SIGWINCH ordering): Node.js updates `stdout.rows`/`columns`
  // synchronously before this 'resize' event fires. The 150ms debounce on
  // the main subscriber list creates a window in which spinner ticks
  // (80ms interval) and streaming subagent events (50–80Hz) call
  // repaint() with the NEW dimensions but stale CupFrameRenderer
  // previous-frame coordinates. Immediate subscribers run synchronously
  // here — BEFORE any such event can execute — so a SIGWINCH-driven
  // geometry-reset lands before the first stale repaint.
  notifyImmediate();
  scheduleNotify();
}

/**
 * Subscribe to debounced terminal resize notifications.
 *
 * @returns Unsubscribe function; when the last subscriber unsubscribes, the
 *          underlying `stdout` listener is removed.
 */
export function subscribeResize(fn: () => void): () => void {
  subscribers.add(fn);
  if (!attached) {
    process.stdout.on('resize', onStdoutResize);
    attached = true;
  }
  return () => {
    subscribers.delete(fn);
    maybeDetach();
  };
}

/**
 * Subscribe to immediate (non-debounced) terminal resize notifications.
 *
 * Fires synchronously inside the underlying `stdout` 'resize' event handler,
 * before any debounced subscriber. Use for state invalidations that must
 * happen before the next repaint can observe stale coordinates against new
 * dimensions — e.g. zeroing `CupFrameRenderer.previousTopRow` so a spinner
 * tick that fires inside the 150ms debounce window doesn't paint a partial
 * erase against the pre-resize geometry.
 *
 * Contract: handlers run inside the resize event callback. Keep them O(1)
 * and side-effect-only — no I/O, no rendering. Use the debounced
 * `subscribeResize` for actual repaints.
 *
 * @returns Unsubscribe function; when the last subscriber (across both
 *          immediate and debounced) unsubscribes, the underlying `stdout`
 *          listener is removed.
 */
export function subscribeResizeImmediate(fn: () => void): () => void {
  immediateSubscribers.add(fn);
  if (!attached) {
    process.stdout.on('resize', onStdoutResize);
    attached = true;
  }
  return () => {
    immediateSubscribers.delete(fn);
    maybeDetach();
  };
}

function maybeDetach(): void {
  if (subscribers.size === 0 && immediateSubscribers.size === 0) {
    if (attached) {
      process.stdout.off('resize', onStdoutResize);
      attached = false;
    }
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }
}

/**
 * @internal Vitest hook — flush pending resize notifications synchronously
 * across BOTH channels.
 *
 * Order matches the runtime ordering inside `onStdoutResize`: immediate first
 * (state invalidation), then debounced (repaint). Tests that subscribe to
 * both channels and call this helper after emitting a resize must observe the
 * same ordering they'd see in production. Omitting `notifyImmediate()` here
 * lets a debounced-only flush race past an unfired immediate handler, masking
 * regressions in code that depends on the resetGeometry-then-repaint sequence.
 */
export function __flushResizeBusForTests(): void {
  notifyImmediate();
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  notifyAll();
}

/** Namespace-style export for call sites that prefer `ResizeBus.subscribe`. */
export const ResizeBus = {
  subscribe: subscribeResize,
  subscribeImmediate: subscribeResizeImmediate,
} as const;
