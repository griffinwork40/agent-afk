/**
 * Session-scoped toggle for usage-awareness visibility in model context.
 *
 * When disabled, all three surfaces that inject usage information into the
 * model's context are suppressed:
 *   - The per-round `[vitals]` usage field (subscription %)
 *   - The fan-out notice on `agent`/`compose` dispatch (warn/over)
 *   - The `usage` field in `get_runtime_state` (model-pull)
 *
 * The toggle is process-wide — safe because interactive REPL sessions are
 * single-session-per-process, and Telegram/daemon sessions process turns
 * sequentially. Subagents already suppress the vitals usage field via the
 * `subagentId !== undefined` guard, so the toggle has no effect on children.
 *
 * Follows the same pattern as `vitalsEnabled()` (process-level env gate)
 * but is runtime-mutable via the `/usage-awareness` slash command.
 *
 * @module agent/usage/usage-awareness-toggle
 */

let enabled = true;

/** True unless the operator toggled usage awareness off via `/usage-awareness off`. */
export function isUsageAwarenessEnabled(): boolean {
  return enabled;
}

/** Set by the `/usage-awareness` slash command. */
export function setUsageAwareness(value: boolean): void {
  enabled = value;
}

/** Test seam: reset to default (on). */
export function resetUsageAwarenessForTests(): void {
  enabled = true;
}
