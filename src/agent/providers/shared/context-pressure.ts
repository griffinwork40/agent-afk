import { emitSessionPhase } from '../../trace/emit.js';
import type { TraceSink } from '../../trace/index.js';

export const CONTEXT_PRESSURE_WIND_DOWN = 'context_pressure_wind_down';
export const CONTEXT_PRESSURE_NOTE =
  'Context capacity is nearly exhausted. Do not request tools. Return partial findings, saved work, and remaining steps now.';
// Contract: INV-034 uses ONE request footprint, never summed usage. Three bytes
// per token is a conservative projection, not a tokenizer guarantee. Documented
// model capacity is unknown here; the effective provider-route limit is client
// metadata, not a guaranteed server cutoff. The operational threshold is policy.
export function projectedContextTokens(lastRoundTokens: number, appendedBytes: number): number {
  return Math.ceil(lastRoundTokens + appendedBytes / 3);
}
export function contextPressure(lastRoundTokens: number, appendedBytes: number, limit: number): boolean {
  return limit > 0 && projectedContextTokens(lastRoundTokens, appendedBytes) >= limit * 0.85;
}
export function traceContextPressure(trace: TraceSink | undefined, projected: number, limit: number): void {
  void emitSessionPhase(trace, { phase: CONTEXT_PRESSURE_WIND_DOWN, metadata: {
    projectedTokens: projected, effectiveProviderRouteLimitTokens: limit,
    operationalThresholdTokens: limit * 0.85, documentedModelCapacity: 'unknown',
    routeLimitSource: 'client metadata; not a guaranteed server cutoff',
  } });
}
