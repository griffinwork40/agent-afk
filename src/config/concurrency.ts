import { env } from './env.js';

export const DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS = 8;
export const DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS = 4;
export const DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS = 10;

export type ConcurrencyEnvKey =
  | 'AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS'
  | 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS'
  | 'AFK_MAX_CONCURRENT_BACKGROUND_JOBS';

interface ConcurrencyDefinition {
  key: ConcurrencyEnvKey;
  defaultValue: number;
}

export interface ConcurrencyStatus extends ConcurrencyDefinition {
  rawValue: string | undefined;
  effectiveValue: number;
  source: 'default' | 'environment' | 'fallback';
  valid: boolean;
}

const definitions: readonly ConcurrencyDefinition[] = [
  { key: 'AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS', defaultValue: DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS },
  { key: 'AFK_MAX_CONCURRENT_SUBAGENT_CALLS', defaultValue: DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS },
  { key: 'AFK_MAX_CONCURRENT_BACKGROUND_JOBS', defaultValue: DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS },
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

  const parsed = Number(rawValue);
  if (rawValue.trim() !== '' && Number.isInteger(parsed) && parsed > 0) {
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
        `using default ${definition.defaultValue}. Expected a positive integer.\n`,
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
