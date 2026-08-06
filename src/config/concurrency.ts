import { env } from './env.js';

export const DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS = 8;
export const DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS = 8;
export const DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS = 10;

/**
 * Upper bound accepted from `AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS`.
 *
 * Invariant: each unit here is a real tool call competing for the same
 * dispatcher batch, not a cheap increment. The ceiling is what keeps a typo
 * (`320` for `32`) or an operator setting an astronomically large value from
 * turning one batch into an unbounded fan-out. 32 sits well above any
 * realistic safe-tool batch width while still refusing a runaway value.
 */
export const MAX_CONCURRENT_SAFE_TOOL_CALLS_CEILING = 32;

/**
 * Upper bound accepted from `AFK_MAX_CONCURRENT_SUBAGENT_CALLS`.
 *
 * Invariant: each unit here is a real forked `AgentSession` competing for the
 * same provider rate limit and process memory, not a cheap increment — the
 * ceiling is what keeps a typo or an unbounded value (e.g. `1000000000`) from
 * turning one compose/DAG layer or skill wave into a fan-out that exhausts
 * memory or storms the provider's 429 ceiling. 32 sits well above any
 * realistic parallel-wave width while still refusing a runaway value.
 */
export const MAX_CONCURRENT_SUBAGENT_CALLS_CEILING = 32;

/**
 * Upper bound accepted from `AFK_MAX_CONCURRENT_BACKGROUND_JOBS`.
 *
 * Invariant: `BackgroundAgentRegistry` compares this raw ceiling against a
 * running in-flight count with no independent array-length backstop, so an
 * unclamped value (e.g. `1000000000`) would effectively remove the
 * concurrency limit it exists to enforce. 64 is double the subagent-call
 * ceiling — background jobs are cheaper to hold open than a live foreground
 * fan-out — while still refusing a runaway value.
 */
export const MAX_CONCURRENT_BACKGROUND_JOBS_CEILING = 64;

export type ConcurrencyEnvKey =
  | 'AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS'
  | 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS'
  | 'AFK_MAX_CONCURRENT_BACKGROUND_JOBS';

interface ConcurrencyDefinition {
  key: ConcurrencyEnvKey;
  defaultValue: number;
  /** Highest value accepted from the environment; see the per-key `*_CEILING` constants above. */
  maxValue: number;
}

export interface ConcurrencyStatus extends ConcurrencyDefinition {
  rawValue: string | undefined;
  effectiveValue: number;
  source: 'default' | 'environment' | 'fallback';
  valid: boolean;
}

const definitions: readonly ConcurrencyDefinition[] = [
  {
    key: 'AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS',
    defaultValue: DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS,
    maxValue: MAX_CONCURRENT_SAFE_TOOL_CALLS_CEILING,
  },
  {
    key: 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS',
    defaultValue: DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS,
    maxValue: MAX_CONCURRENT_SUBAGENT_CALLS_CEILING,
  },
  {
    key: 'AFK_MAX_CONCURRENT_BACKGROUND_JOBS',
    defaultValue: DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS,
    maxValue: MAX_CONCURRENT_BACKGROUND_JOBS_CEILING,
  },
];

const warnedKeys = new Set<ConcurrencyEnvKey>();

/**
 * Test-only: clear the once-per-key warning latch so a suite can assert the
 * warning fires regardless of what ran (or didn't run) earlier in the file.
 *
 * Contract: production code must never call this. Without it, a "warns only
 * once" assertion would pass only when `warnedKeys` happened to still be
 * empty at that point in declaration order — an artifact of test order, not
 * a guarantee.
 */
export function resetConcurrencyWarnings(): void {
  warnedKeys.clear();
}

function rawValueFor(key: ConcurrencyEnvKey): string | undefined {
  return env[key];
}

export function getConcurrencyStatus(
  definition: ConcurrencyDefinition,
  warn = true,
): ConcurrencyStatus {
  const rawValue = rawValueFor(definition.key);
  if (rawValue === undefined) {
    return {
      ...definition,
      rawValue,
      effectiveValue: definition.defaultValue,
      source: 'default',
      valid: true,
    };
  }

  // Digit-anchored before Number(), matching resolveMaxNestingDepth
  // (src/agent/tools/nesting.ts): bare Number() also accepts "0x8", "1e1", and
  // "8.0", so an operator typo in an unfamiliar grammar would silently resolve
  // to a number they did not write instead of falling back and warning.
  const trimmed = rawValue.trim();
  const parsed = Number(trimmed);
  const isPositiveInteger = /^\d+$/.test(trimmed) && Number.isInteger(parsed) && parsed > 0;
  // A value above maxValue takes the SAME path as any other invalid input
  // (fall back to the default, valid: false, source: 'fallback', warn-once) —
  // it is not a distinct outcome, just another reason the raw value is rejected.
  if (isPositiveInteger && parsed <= definition.maxValue) {
    return {
      ...definition,
      rawValue,
      effectiveValue: parsed,
      source: 'environment',
      valid: true,
    };
  }

  if (warn && !warnedKeys.has(definition.key)) {
    warnedKeys.add(definition.key);
    process.stderr.write(
      `[afk] Invalid ${definition.key}=${JSON.stringify(rawValue)}; ` +
        `using default ${definition.defaultValue}. Expected an integer in [1, ${definition.maxValue}].\n`,
    );
  }
  return {
    ...definition,
    rawValue,
    effectiveValue: definition.defaultValue,
    source: 'fallback',
    valid: false,
  };
}

export function getConcurrencyStatuses(warn = true): ConcurrencyStatus[] {
  return definitions.map((definition) => getConcurrencyStatus(definition, warn));
}

function resolve(key: ConcurrencyEnvKey): number {
  const definition = definitions.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`Unknown concurrency setting: ${key}`);
  return getConcurrencyStatus(definition).effectiveValue;
}

export function resolveMaxConcurrentSafeToolCalls(): number {
  return resolve('AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS');
}

export function resolveMaxConcurrentSubagentCalls(): number {
  return resolve('AFK_MAX_CONCURRENT_SUBAGENT_CALLS');
}

export function resolveMaxConcurrentBackgroundJobs(): number {
  return resolve('AFK_MAX_CONCURRENT_BACKGROUND_JOBS');
}
