/**
 * Detector registry.
 *
 * `afk improve scan` no longer hard-codes a single detector. It iterates
 * every entry in {@link DETECTOR_REGISTRY}, passes the shared option bag,
 * and concatenates the per-detector results.
 *
 * ## Contract
 *
 * Each detector is a pure function `(sessions, options) => DetectorResult[]`.
 * Detectors must:
 *
 *   1. Be deterministic. Two runs against the same input produce the same
 *      slugs and the same fingerprints. The card writer's merge logic
 *      depends on this.
 *   2. Never throw on malformed event payloads. The reader has already
 *      schema-validated every event; detectors only need to handle the
 *      semantic edge cases (e.g. an unpaired `started` event).
 *   3. Pick the keys they care about out of {@link DetectorOptions}. Each
 *      detector ignores options it doesn't recognize.
 *   4. Produce evidence that is byte-bounded (`excerpt` ≤ 2 KB per
 *      `FailureEvidenceSchema`).
 *
 * ## Adding a new detector
 *
 *   1. Add the pattern name to `FailurePatternSchema` in `improve/schemas.ts`.
 *   2. Implement `detectXxx(sessions, options)` returning `DetectorResult[]`.
 *   3. Append a registry entry below.
 *   4. Add a CLI flag for any new option in `cli/commands/improve.ts`.
 *
 * ## Why a registry vs. inline dispatch
 *
 * Sprint 1 needed to run ≥2 detectors per scan. A registry gives us:
 *
 *   - One iteration loop in the CLI (no detector-specific branches).
 *   - Per-detector enable/disable via `--only` / `--skip` (this commit
 *     wires `--only`; `--skip` is a trivial follow-up).
 *   - A stable place to list detector names for `--help` text.
 *
 * @module improve/scan/detectors
 */

import type { DetectorResult } from '../../schemas.js';
import type { SessionRead } from '../reader.js';
import { detectRepeatedToolUse, DEFAULT_MIN_REPEATS } from './repeated-tool-use.js';
import {
  detectClosureAnomaly,
  DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES,
} from './closure-anomaly.js';
import {
  detectSubagentBlock,
  DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES,
} from './subagent-block.js';
import {
  detectToolFailureDensity,
  DEFAULT_TOOL_FAILURE_MIN_FAILURES,
  DEFAULT_TOOL_FAILURE_MIN_RATE,
} from './tool-failure-density.js';

/**
 * Shared option bag passed to every detector. Detectors only read the
 * keys they recognize; unknown keys are ignored.
 */
export interface DetectorOptions {
  /** repeated-tool-use: minimum consecutive identical calls to flag. */
  minRepeats?: number;
  /** closure-anomaly: minimum sessions sharing the same anomalous reason. */
  closureAnomalyMinOccurrences?: number;
  /** subagent-block: minimum SubagentStart blocks sharing the same reason. */
  subagentBlockMinOccurrences?: number;
  /** tool-failure-density: minimum absolute failure count per tool. */
  toolFailureMinFailures?: number;
  /** tool-failure-density: minimum failure rate (failures / total calls) per tool. */
  toolFailureMinRate?: number;
}

/** A single registry entry. */
export interface DetectorEntry {
  /** Stable name; matches the corresponding `FailurePattern` value. */
  name: string;
  /** One-line human description for `--help` output. */
  description: string;
  /**
   * Whether this detector runs by default when `--only` is not specified.
   * `undefined` is treated as `true` (backward compatible).
   * Set to `false` for noisy / low-signal detectors that opt-in via
   * `--only <name>` or `--include-disabled`.
   */
  enabledByDefault?: boolean;
  /** Pure detector function. */
  run: (sessions: SessionRead[], options: DetectorOptions) => DetectorResult[];
}

/**
 * The ordered list of all registered detectors. Order is the order they
 * run in; it has no effect on correctness (detectors are independent),
 * only on the CLI's summary output.
 */
export const DETECTOR_REGISTRY: readonly DetectorEntry[] = Object.freeze([
  {
    name: 'repeated-tool-use',
    description: `Tool fired ≥N consecutive times with identical fingerprint (default ${DEFAULT_MIN_REPEATS})`,
    run: (sessions, opts): DetectorResult[] =>
      detectRepeatedToolUse(sessions, { minRepeats: opts.minRepeats ?? DEFAULT_MIN_REPEATS }),
  },
  {
    name: 'closure-anomaly',
    description: `Session closure reason ∈ {budget_exceeded,timeout,hook_blocked,abort,iteration_cap,max_turns_exceeded} (default ≥${DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES})`,
    enabledByDefault: false,
    run: (sessions, opts): DetectorResult[] =>
      detectClosureAnomaly(sessions, {
        minOccurrences:
          opts.closureAnomalyMinOccurrences ?? DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES,
      }),
  },
  {
    name: 'subagent-block',
    description: `Same SubagentStart hook block reason recurring across ≥N events (default ${DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES})`,
    enabledByDefault: false,
    run: (sessions, opts): DetectorResult[] =>
      detectSubagentBlock(sessions, {
        minOccurrences:
          opts.subagentBlockMinOccurrences ?? DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES,
      }),
  },
  {
    name: 'tool-failure-density',
    description: `Tool with ≥N failures (isError: true) AND failure rate ≥R (defaults: ${DEFAULT_TOOL_FAILURE_MIN_FAILURES} failures, ${DEFAULT_TOOL_FAILURE_MIN_RATE} rate)`,
    // Flipped on by default after a two-week noise-floor evaluation (Jun 2026):
    // dual count+rate thresholds produced the highest-signal cards (skill 37.6%,
    // browser_open 77.8%) with zero false positives. closure-anomaly and
    // subagent-block stay opt-in (abort≈Ctrl+C ambiguity / fire during active bug fixing).
    enabledByDefault: true,
    run: (sessions, opts): DetectorResult[] =>
      detectToolFailureDensity(sessions, {
        minFailures: opts.toolFailureMinFailures ?? DEFAULT_TOOL_FAILURE_MIN_FAILURES,
        minFailureRate: opts.toolFailureMinRate ?? DEFAULT_TOOL_FAILURE_MIN_RATE,
      }),
  },
] satisfies DetectorEntry[]);

/**
 * Run registered detectors, returning the concatenation of their results.
 * The CLI uses this; tests typically dispatch a single detector directly
 * for clarity.
 *
 * Selection priority (highest wins):
 *   1. `enabledNames` provided → run exactly those names, ignore `enabledByDefault`.
 *   2. `enabledNames` undefined + `includeDisabled === true` → run every detector.
 *   3. `enabledNames` undefined + `includeDisabled !== true` (default) → run only
 *      detectors where `enabledByDefault !== false`.
 *
 * Names not in the registry are silently ignored — the caller's responsibility
 * to validate user input.
 */
export function runAllDetectors(
  sessions: SessionRead[],
  options: DetectorOptions,
  enabledNames?: ReadonlySet<string>,
  includeDisabled?: boolean,
): DetectorResult[] {
  const out: DetectorResult[] = [];
  for (const entry of DETECTOR_REGISTRY) {
    if (enabledNames !== undefined) {
      // Explicit allow-list: honour as-is.
      if (!enabledNames.has(entry.name)) continue;
    } else if (includeDisabled !== true) {
      // Default mode: skip detectors explicitly opted out.
      if (entry.enabledByDefault === false) continue;
    }
    // includeDisabled === true with no enabledNames: run everything.
    const results = entry.run(sessions, options);
    out.push(...results);
  }
  return out;
}

/** Lookup helper for CLI validation of `--only` arguments. */
export function knownDetectorNames(): readonly string[] {
  return DETECTOR_REGISTRY.map((d) => d.name);
}

/** Names of detectors that run by default (i.e. `enabledByDefault !== false`). */
export function defaultEnabledDetectorNames(): readonly string[] {
  return DETECTOR_REGISTRY.filter((d) => d.enabledByDefault !== false).map((d) => d.name);
}

/** Names of detectors that are skipped by default (i.e. `enabledByDefault === false`). */
export function disabledByDefaultDetectorNames(): readonly string[] {
  return DETECTOR_REGISTRY.filter((d) => d.enabledByDefault === false).map((d) => d.name);
}
