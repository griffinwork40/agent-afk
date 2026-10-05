import { readFileSync } from 'node:fs';
import { join } from 'path';
import { env as defaultEnv } from '../config/env.js';
import { getAfkConfigDir } from '../paths.js';
export interface LoadDomainListOptions {
  readonly env?: Record<string, string | undefined>;
  readonly readFileSync?: (path: string) => string | undefined;
}

export interface DomainLists {
  readonly allowedDomains: readonly string[];
  readonly blockedDomains: readonly string[];
}

export function parseDomainList(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function defaultReadFileSync(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

const warnedBadDomainConfigPaths = new Set<string>();

function warnBadDomainConfig(path: string, message: string): void {
  if (warnedBadDomainConfigPaths.has(path)) return;
  warnedBadDomainConfigPaths.add(path);
  console.warn(
    `[browser/config] browser.json at ${path} ${message} — ` +
      'using env-var domain lists only. Fix or remove the file to silence this warning.',
  );
}

function domainArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function loadDomainLists(opts?: LoadDomainListOptions): DomainLists {
  const envSource: Record<string, string | undefined> = opts?.env ?? defaultEnv;
  const readFile = opts?.readFileSync ?? defaultReadFileSync;
  const allowedDomains = parseDomainList(envSource['AFK_BROWSER_ALLOWED_DOMAINS']);
  const blockedDomains = parseDomainList(envSource['AFK_BROWSER_BLOCKED_DOMAINS']);
  const explicitPath = envSource['AFK_BROWSER_CONFIG'];
  const candidatePath =
    explicitPath !== undefined && explicitPath.trim() !== ''
      ? explicitPath.trim()
      : join(getAfkConfigDir(), 'browser.json');

  let raw: string | undefined;
  try {
    raw = readFile(candidatePath);
  } catch (err) {
    warnBadDomainConfig(candidatePath, `could not be read (${String(err)})`);
    return { allowedDomains, blockedDomains };
  }
  if (raw === undefined) return { allowedDomains, blockedDomains };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnBadDomainConfig(candidatePath, `could not be parsed (${String(err)})`);
    return { allowedDomains, blockedDomains };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnBadDomainConfig(
      candidatePath,
      `is not a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    );
    return { allowedDomains, blockedDomains };
  }

  const fileConfig = parsed as Record<string, unknown>;
  return {
    allowedDomains: domainArray(fileConfig['allowedDomains'], allowedDomains),
    blockedDomains: domainArray(fileConfig['blockedDomains'], blockedDomains),
  };
}
