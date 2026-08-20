import { appendRoutingDecision } from './routing-telemetry.js';

/** Best-effort routing telemetry: persistence failures never affect job state. */
export function emitBackgroundRoutingTelemetry(
  entry: Parameters<typeof appendRoutingDecision>[0],
): void {
  void appendRoutingDecision(entry).catch(() => {});
}
