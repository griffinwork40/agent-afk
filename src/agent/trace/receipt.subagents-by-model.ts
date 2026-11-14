/**
 * Per-model subagent rollup for run receipts.
 *
 * Contract: extracted from `receipt.ts` to keep that file within the
 * 350-code-line ceiling. Owns the `SubagentsByModel` type, the
 * `SubagentModelEntry` type, and `buildSubagentsByModel`. Pure: no I/O.
 *
 * Contract: the rollup key for a subagent is chosen as follows (first match wins):
 *   1. If a `session_phase subagent_model_fallback` event names this subagentId,
 *      derive the key from `toModel` using rules 3-5 below (the `started`
 *      payload's `resolvedModel` is NOT used -- it describes the rejected attempt).
 *   2. `resolvedModel` on the `subagent_lifecycle started` payload (reserved for
 *      a future emit-site addition; not present on current runtimes).
 *   3. If every `session_phase session_init_start` event whose `actor` is
 *      `"subagent"` and whose `model` matches the subagent's requested name maps
 *      to exactly one `resolvedModel`, use that id.
 *   4. If multiple distinct resolved ids map to the same requested name, use
 *      `"<requested> (mixed)"`.
 *   5. Otherwise use the requested name as-is (old-runtime fallback).
 *
 * @module agent/trace/receipt.subagents-by-model
 */

import type { TraceEvent } from './types.js';

/** One bucket in the per-model subagent rollup. */
export interface SubagentModelEntry {
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** Sum of `closure.finalCostUsd` for subagents in this bucket. */
  costUsd: number;
  /** Sorted distinct requested model names that landed in this bucket. */
  requested: string[];
  /**
   * Sorted, unique credential source ids that served subagents in this bucket
   * (#4882), read from `credentialSource` on the `started` payload (or on the
   * `subagent_model_fallback` metadata when the child was re-run). Ids only,
   * never token material. Absent when no subagent in the bucket recorded one
   * (older traces): never guessed.
   */
  credentialSources?: string[];
}

/**
 * Map from resolved model key to counts. Present only when subagents were started.
 * The special key `'(unknown)'` collects subagents whose `started` payload carried
 * no model field, so `sum(byModel[*].started)` always equals `subagents.started`.
 */
export type SubagentsByModel = Record<string, SubagentModelEntry>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Safe string extractor from an unknown payload field. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function finitePos(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Collect subagentId -> toModel from subagent_model_fallback phase events.
 * Tolerates malformed events: missing or non-object metadata, non-string or
 * empty subagentId / toModel fields are silently skipped.
 */
function buildFallbackMap(
  events: TraceEvent[],
  fallbackSources?: Map<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind !== 'session_phase') continue;
    const p = ev.payload as unknown as Record<string, unknown>;
    if (p['phase'] !== 'subagent_model_fallback') continue;
    const meta = p['metadata'];
    if (meta === null || typeof meta !== 'object') continue;
    const m = meta as Record<string, unknown>;
    const subagentId = str(m['subagentId']);
    const toModel = str(m['toModel']);
    if (subagentId === undefined || toModel === undefined) continue;
    map.set(subagentId, toModel);
    const source = str(m['credentialSource']);
    if (source !== undefined) fallbackSources?.set(subagentId, source);
  }
  return map;
}

/** Build a requested-name -> Set<resolvedModel> map from session_init_start events. */
function buildInitResolvedMap(events: TraceEvent[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const ev of events) {
    if (ev.kind !== 'session_phase') continue;
    const p = ev.payload as unknown as Record<string, unknown>;
    if (p['phase'] !== 'session_init_start') continue;
    if (p['actor'] !== 'subagent') continue;
    const requested = str(p['model']);
    const resolved = str(p['resolvedModel']);
    if (requested === undefined || resolved === undefined) continue;
    let set = map.get(requested);
    if (set === undefined) { set = new Set(); map.set(requested, set); }
    set.add(resolved);
  }
  return map;
}

/**
 * Derive the model key for one subagent given its requested name, optional
 * fallback override, and the init-event resolution map.
 *
 * When `fallbackToModel` is set the subagent was re-run on a different model;
 * skip the started-payload resolvedModel (it describes the rejected attempt)
 * and derive the key from fallbackToModel using the init-map rules instead.
 */
function modelKey(
  requested: string,
  startedResolvedModel: string | undefined,
  initMap: Map<string, Set<string>>,
  fallbackToModel?: string,
): string {
  // Rule 1: fallback override. Attribute to toModel, not the rejected first attempt.
  if (fallbackToModel !== undefined) {
    return resolveViaInitMap(fallbackToModel, initMap);
  }
  // Rule 2: explicit resolvedModel on the started payload.
  if (startedResolvedModel !== undefined) return startedResolvedModel;
  // Rules 3-5: look up from init events, then requested name as-is.
  return resolveViaInitMap(requested, initMap);
}

/**
 * Resolve a model name through the init map (rules 3-5 in the file header).
 * Returns the single resolved id, `"<name> (mixed)"`, or name as-is.
 */
function resolveViaInitMap(name: string, initMap: Map<string, Set<string>>): string {
  const resolved = initMap.get(name);
  if (resolved !== undefined) {
    if (resolved.size === 1) {
      const id = resolved.values().next().value;
      return id !== undefined ? id : name;
    }
    return `${name} (mixed)`;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

/**
 * Build the `byModel` rollup from a full set of trace events.
 *
 * Returns `undefined` when no subagent was started (omit the field entirely).
 * Subagents whose `started` payload carries no `model` field land in the
 * explicit `'(unknown)'` bucket so `sum(byModel[*].started)` always equals
 * `subagents.started`. Tolerates malformed or missing payload fields.
 *
 * Counting contract — counts per event, not per map entry:
 *
 *   - Every `started` row increments `bucket.started` once, regardless of
 *     whether a previous row with the same `subagentId` was already seen.
 *     This matches how `generateReceipt` counts top-level `subagents.started`
 *     (one increment per row), so the two tallies agree by construction.
 *
 *   - Every terminal row (`succeeded` / `failed` / `cancelled`) increments the
 *     corresponding bucket counter once. When a single id receives two terminal
 *     rows (e.g. a `succeeded` row followed by a racing `cancelled`), both are
 *     counted — matching `generateReceipt`'s per-row increments and faithfully
 *     reflecting the trace. The model key for a terminal row is resolved from
 *     the `requested` map populated by the preceding `started` row(s).
 *
 *   - Cost attribution uses `closure` events keyed by `subagentId`. Closures
 *     are emitted once per subagent session, not once per lifecycle row, so
 *     there is no analogous per-event / per-map divergence there; the existing
 *     accumulation (`costs.set(id, (costs.get(id) ?? 0) + cost)`) is correct.
 */
export function buildSubagentsByModel(
  events: TraceEvent[],
): SubagentsByModel | undefined {
  // Pass 1: build init resolution map and fallback map (session_phase events).
  const initMap = buildInitResolvedMap(events);
  // subagentId -> credential source of the model that actually ran (#4882).
  const sources = new Map<string, string>();
  const fallbackSources = new Map<string, string>();
  const fallbackMap = buildFallbackMap(events, fallbackSources);

  // Pass 2: collect per-subagentId model provenance and cost from events.
  //
  // Invariant: `started` events always precede terminal events in the trace
  // (the manager wires the abort-graph before emitting started). We therefore
  // rely only on started events for model provenance; terminal events carry
  // no model field.
  //
  // `requested` and `startedResolved` store the FIRST value seen per id so
  // that id-collision rows (two managers minting the same id) still resolve to
  // a consistent model key. Counts are accumulated per-event in Pass 3 below.
  const requested = new Map<string, string>();          // subagentId -> requested model (first seen)
  const startedResolved = new Map<string, string>();    // subagentId -> resolvedModel from started payload (first seen)
  const costs = new Map<string, number>();              // subagentId -> closure finalCostUsd (accumulated)

  let anyStarted = false;

  for (const ev of events) {
    if (ev.kind === 'subagent_lifecycle') {
      const p = ev.payload as unknown as Record<string, unknown>;
      const t = str(p['transition']);
      const id = str(p['subagentId']);
      if (id === undefined) continue;
      if (t === 'started') {
        anyStarted = true;
        // Populate provenance maps on first occurrence only; subsequent rows
        // with the same id (id collision) reuse the same key. A missing or
        // empty model lands in the explicit '(unknown)' bucket so
        // sum(byModel[*].started) always equals subagents.started.
        if (!requested.has(id)) {
          requested.set(id, str(p['model']) ?? '(unknown)');
        }
        if (!startedResolved.has(id)) {
          const res = str(p['resolvedModel']);
          if (res !== undefined) startedResolved.set(id, res);
        }
        if (!sources.has(id)) {
          const src = str(p['credentialSource']);
          if (src !== undefined) sources.set(id, src);
        }
      }
    } else if (ev.kind === 'closure') {
      const p = ev.payload as unknown as Record<string, unknown>;
      const id = str(p['subagentId']);
      if (id === undefined) continue;
      const cost = finitePos(p['finalCostUsd']);
      if (cost !== undefined) costs.set(id, (costs.get(id) ?? 0) + cost);
    }
  }

  if (!anyStarted) return undefined;
  // A model fallback re-ran the child on another model: its credential wins.
  // A fallback without a recorded source drops the started one (it described
  // the rejected attempt) rather than guessing.
  for (const id of fallbackMap.keys()) {
    const src = fallbackSources.get(id);
    if (src !== undefined) sources.set(id, src);
    else sources.delete(id);
  }

  // Pass 3: aggregate into per-modelKey buckets by iterating events again.
  //
  // Counting per event (not per map entry) ensures byModel bucket totals agree
  // with generateReceipt's top-level subagent counters by construction:
  //   - Two `started` rows for the same id → started: 2 in both places.
  //   - Two terminal rows for the same id → both terminal counters increment.
  const buckets = new Map<string, SubagentModelEntry>();
  // Track requested names per bucket for the `requested` array.
  const bucketRequested = new Map<string, Set<string>>();
  const bucketSources = new Map<string, Set<string>>();

  const getOrCreateBucket = (key: string): SubagentModelEntry => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { started: 0, succeeded: 0, failed: 0, cancelled: 0, costUsd: 0, requested: [] };
      buckets.set(key, bucket);
      bucketRequested.set(key, new Set());
    }
    return bucket;
  };

  for (const ev of events) {
    if (ev.kind !== 'subagent_lifecycle') continue;
    const p = ev.payload as unknown as Record<string, unknown>;
    const t = str(p['transition']);
    const id = str(p['subagentId']);
    if (id === undefined) continue;

    // Resolve the model key from the provenance maps populated in Pass 2.
    // Every id with a `started` row has a `requested` entry (model-less starts
    // map to '(unknown)'); a terminal row for an id never started is skipped.
    const req = requested.get(id);
    if (req === undefined) continue;

    const key = modelKey(req, startedResolved.get(id), initMap, fallbackMap.get(id));
    const bucket = getOrCreateBucket(key);

    if (t === 'started') {
      bucket.started++;
      bucketRequested.get(key)?.add(req);
      const src = sources.get(id);
      if (src !== undefined) {
        let set = bucketSources.get(key);
        if (set === undefined) { set = new Set(); bucketSources.set(key, set); }
        set.add(src);
      }
    } else if (t === 'succeeded') {
      bucket.succeeded++;
    } else if (t === 'failed') {
      bucket.failed++;
    } else if (t === 'cancelled') {
      bucket.cancelled++;
    }
  }

  // Add cost from closure events (keyed by id; already accumulated in Pass 2).
  for (const [id, cost] of costs) {
    const req = requested.get(id);
    if (req === undefined) continue;
    const key = modelKey(req, startedResolved.get(id), initMap, fallbackMap.get(id));
    const bucket = buckets.get(key);
    if (bucket !== undefined) bucket.costUsd += cost;
  }

  // Freeze the `requested` arrays (sorted for determinism).
  for (const [key, bucket] of buckets) {
    const reqSet = bucketRequested.get(key);
    bucket.requested = reqSet !== undefined ? [...reqSet].sort() : [];
    const srcSet = bucketSources.get(key);
    if (srcSet !== undefined && srcSet.size > 0) bucket.credentialSources = [...srcSet].sort();
  }

  if (buckets.size === 0) return undefined;
  return Object.fromEntries(buckets);
}
