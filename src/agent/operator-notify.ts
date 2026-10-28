/**
 * Operator notification port.
 *
 * Agent core sometimes needs to push a best-effort message to the human
 * operator (e.g. when an elicitation arrives on an unattended surface, or
 * ask_question is gated). The concrete delivery channel (Telegram, email,
 * webhook, ...) is a SURFACE concern — agent core must not import any surface
 * module directly.
 *
 * This module provides a register/notify indirection:
 *   - Surfaces call `registerOperatorNotifier` at startup to wire their
 *     push implementation.
 *   - Agent core calls `notifyOperator` — a fire-and-forget function that
 *     silently no-ops when no notifier is registered.
 *
 * Contract:
 *   - `notifyOperator` never throws. Callers rely on this.
 *   - Multiple registrations are fine; last-write wins.
 *   - No return value — callers fire and forget.
 *
 * @module agent/operator-notify
 */

export type OperatorNotifyFn = (message: string) => void;

let _notifier: OperatorNotifyFn | null = null;

/**
 * Register the process-wide operator notification function. Surfaces call
 * this at startup — e.g. the Telegram adapter wraps `pushIfConfigured` and
 * registers it here. Last-write wins; multiple registrations are safe.
 */
export function registerOperatorNotifier(fn: OperatorNotifyFn): void {
  _notifier = fn;
}

/**
 * Best-effort fire-and-forget notification to the operator.
 *
 * Silent no-op when no notifier is registered (the common case for surfaces
 * that have an interactive handler installed, where this code path is never
 * reached anyway).
 *
 * Invariant: never throws. Both the elicitation router and ask-question gate
 * rely on this — a thrown error would break the must-always-resolve contract
 * on the elicitation path.
 */
export function notifyOperator(message: string): void {
  if (!_notifier) return;
  try {
    const result = _notifier(message) as unknown;
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // Fire-and-forget — never throw into the calling path.
  }
}

/**
 * Reset the notifier to null. Exported for tests only.
 * @internal
 */
export function _resetOperatorNotifierForTest(): void {
  _notifier = null;
}
