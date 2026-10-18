import { env } from './env.js';

export const DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS = 8;
export const DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS = 8;
export const DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS = 10;

/**
 * Provider slots that carry per-provider subagent-concurrency overrides.
 *
 * Mapping from the canonical `BundledProviderName` values (as returned by
 * `providerForModel`) to the env key that overrides
 * `AFK_MAX_CONCURRENT_SUBAGENT_CALLS` for fan-outs whose tasks run on that
 * provider. When the env key is unset the global fallback is used, so nothing
 * changes unless the operator explicitly configures a per-provider cap.
 *
 * Only `'anthropic-direct'` and `'openai-compatible'` are covered in this
 * first slice; xai and other providers continue to use the global default.
 * Follow-up: per-slot config, safe-tool batches. Part of #3886.
 */
export const PROVIDER_SUBAGENT_CONCURRENCY_KEYS = {
  'anthropic-direct': 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS_ANTHROPIC',
  'openai-compatible': 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS_OPENAI',
} as const satisfies Partial<Record<string, ProviderConcurrencyEnvKey>>;

export type ProviderConcurrencyEnvKey =
  | 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS_ANTHROPIC'
  | 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS_OPENAI';

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
  | 'AFK_MAX_CONCURRENT_BACKGROUND_JOBS'
  | ProviderConcurrencyEnvKey;

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

function resolve(key: ConcurrencyEnvKey, warn = true): number {
  const definition = definitions.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`Unknown concurrency setting: ${key}`);
  return getConcurrencyStatus(definition, warn).effectiveValue;
}

export function resolveMaxConcurrentSafeToolCalls(warn = true): number {
  return resolve('AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS', warn);
}

export function resolveMaxConcurrentSubagentCalls(warn = true): number {
  return resolve('AFK_MAX_CONCURRENT_SUBAGENT_CALLS', warn);
}

export function resolveMaxConcurrentBackgroundJobs(warn = true): number {
  return resolve('AFK_MAX_CONCURRENT_BACKGROUND_JOBS', warn);
}

/**
 * Per-provider definitions for the subagent-concurrency override keys.
 *
 * Shares the same ceiling and parse logic as the global
 * `AFK_MAX_CONCURRENT_SUBAGENT_CALLS` definition — a per-provider cap is
 * subject to the same "each unit is a forked AgentSession" invariant.
 */
const providerSubagentDefinitions: readonly (ConcurrencyDefinition & {
  key: ProviderConcurrencyEnvKey;
})[] = [
  {
    key: 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS_ANTHROPIC',
    defaultValue: DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS,
    maxValue: MAX_CONCURRENT_SUBAGENT_CALLS_CEILING,
  },
  {
    key: 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS_OPENAI',
    defaultValue: DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS,
    maxValue: MAX_CONCURRENT_SUBAGENT_CALLS_CEILING,
  },
];

/**
 * Resolve the effective subagent-concurrency cap for a specific provider.
 *
 * Precedence (highest wins):
 *   1. Per-provider env key — `AFK_MAX_CONCURRENT_SUBAGENT_CALLS_ANTHROPIC`
 *      or `AFK_MAX_CONCURRENT_SUBAGENT_CALLS_OPENAI` — when set and valid.
 *   2. Global `AFK_MAX_CONCURRENT_SUBAGENT_CALLS` (via
 *      {@link resolveMaxConcurrentSubagentCalls}).
 *   3. {@link DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS} (8) — the built-in
 *      default, unchanged from the pre-#3886 behavior.
 *
 * When `provider` is `undefined` or maps to no known per-provider key (e.g.
 * `'xai'`, `'xai-oauth'`) this degrades to the global resolver, so callers
 * that do not know the provider at the fan-out site are unaffected.
 *
 * @param provider - The canonical provider name as returned by
 *   `providerForModel()` (e.g. `'anthropic-direct'`,
 *   `'openai-compatible'`). Pass `undefined` to skip per-provider lookup.
 * @param warn - Whether to emit a one-shot stderr warning on invalid values.
 */
export function resolveMaxConcurrentSubagentCallsForProvider(
  provider: string | undefined,
  warn = true,
): number {
  if (provider !== undefined) {
    const envKey =
      PROVIDER_SUBAGENT_CONCURRENCY_KEYS[
        provider as keyof typeof PROVIDER_SUBAGENT_CONCURRENCY_KEYS
      ];
    if (envKey !== undefined) {
      const providerDef = providerSubagentDefinitions.find((d) => d.key === envKey);
      if (providerDef !== undefined) {
        const rawValue = env[envKey];
        // Only use the per-provider override when it is explicitly set.
        // When unset, fall through to the global resolver so the default
        // stays at `DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS` without the
        // operator having to mirror the global in two places.
        if (rawValue !== undefined) {
          const status = getConcurrencyStatus(providerDef, warn);
          // Only use the per-provider value when it parsed successfully.
          // When invalid, fall through to the global resolver so a
          // configured global cap (e.g. AFK_MAX_CONCURRENT_SUBAGENT_CALLS=2)
          // is respected instead of silently returning the hardcoded default.
          if (status.valid) {
            return status.effectiveValue;
          }
        }
      }
    }
  }
  return resolveMaxConcurrentSubagentCalls(warn);
}
