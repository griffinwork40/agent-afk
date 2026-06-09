/**
 * Browser-layer configuration loader.
 *
 * Constructs a `BrowserConfig` from layered sources in priority order:
 *   1. Env vars (lowest priority for individual keys).
 *   2. JSON file at `AFK_BROWSER_CONFIG` or `<afkConfigDir>/browser.json`
 *      (higher priority — file values win per top-level key; arrays replace).
 *
 * @module browser/config
 */

import { readFileSync } from 'node:fs';
import { join } from 'path';
import { env as defaultEnv } from '../config/env.js';
import { getAfkConfigDir } from '../paths.js';
import type { BrowserConfig } from './types.js';

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface LoadBrowserConfigOptions {
  /** Override surface autodetect. */
  surface?: 'cli' | 'telegram' | 'daemon' | 'interactive' | 'repl' | 'subagent' | string;
  /** Override env source for tests. Defaults to importing from `../config/env.js`. */
  env?: Record<string, string | undefined>;
  /** Read filesystem when looking up browser.json. Defaults to fs/promises. */
  readFileSync?: (path: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

// Invariant: The glob-to-regex conversion here is intentionally dumb and
// predictable. Only `*` is treated as a wildcard; it maps to `[^.]*`
// (match any chars except a dot). There is no `**`, no `?`, no character
// classes, no brace expansion. The dumbness is a feature — callers document
// their patterns as simple host globs (e.g. `*.atlassian.net`) and the
// matcher does exactly what a naive reader would expect: one `*` matches
// one subdomain label (no dots), nothing more.
//
// Why `[^.]*` instead of `.*`?
//   - `*.atlassian.net` should match `acme.atlassian.net` ✓
//   - `*.atlassian.net` must NOT match `foo.bar.atlassian.net` ✗
//   Using `.*` would make the second case match, which is wrong for
//   host-glob semantics.
//
// Regex special chars (`.`, `+`, `?`, `(`, `)`, `[`, `]`, `{`, `}`, `^`,
// `$`, `|`, `\`) are escaped before the `*` substitution so patterns like
// `example.com` (a literal dot) are not treated as `example<any>com`.
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?()[\]{}/\\^$|]/g, '\\$&');
  const regexSource = escaped.replace(/\*/g, '[^.]*');
  return new RegExp(`^${regexSource}$`, 'i');
}

/** Returns true when `host` matches the glob `pattern`. */
function matchesGlob(host: string, pattern: string): boolean {
  return globToRegex(pattern).test(host);
}

// ---------------------------------------------------------------------------
// Headless default
// ---------------------------------------------------------------------------

const HEADLESS_SURFACES = new Set(['daemon', 'subagent', 'telegram']);
const HEADED_SURFACES = new Set(['repl', 'interactive', 'cli']);

function resolveHeadlessDefault(
  headlessEnv: string | undefined,
  surface: string | undefined,
): boolean {
  if (headlessEnv !== undefined) {
    const lower = headlessEnv.trim().toLowerCase();
    if (lower === '1' || lower === 'true' || lower === 'yes') return true;
    if (lower === '0' || lower === 'false' || lower === 'no') return false;
    // Unrecognized value → fall through to surface detection.
  }
  if (surface !== undefined) {
    if (HEADLESS_SURFACES.has(surface)) return true;
    if (HEADED_SURFACES.has(surface)) return false;
  }
  // Unknown or unset surface → headed (interactive default).
  return false;
}

// ---------------------------------------------------------------------------
// Domain list parsing
// ---------------------------------------------------------------------------

function parseDomainList(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Backend validation
// ---------------------------------------------------------------------------

function resolveBackend(raw: string | undefined): 'playwright' {
  if (raw === undefined || raw === '' || raw === 'playwright') return 'playwright';
  throw new Error(
    `AFK_BROWSER_BACKEND: only "playwright" is supported in Phase 1, got: ${raw}`,
  );
}

// ---------------------------------------------------------------------------
// Boolean env helper
// ---------------------------------------------------------------------------

function parseBooleanEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const lower = raw.trim().toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes';
}

// ---------------------------------------------------------------------------
// Default filesystem reader
// ---------------------------------------------------------------------------

function defaultReadFileSync(path: string): string | undefined {
  // Contract: returns the file contents as a string, or undefined when the
  // file does not exist. Throws for any error other than ENOENT.
  //
  // Invariant: must use the static `node:fs` import, never a runtime
  // require('fs'). The published binary is bundled to ESM (build-dist.mjs sets
  // format:'esm'), where esbuild replaces a runtime require() with a shim that
  // throws `Dynamic require of "fs" is not supported`. That shim is what
  // previously made every browser_* tool fail at provider construction, since
  // loadBrowserConfig() runs on the first getBrowserProvider() call.
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// JSON file deep-merge
// ---------------------------------------------------------------------------

// Contract: merges `fileConfig` on top of `base`. Top-level keys from the
// file win; arrays REPLACE (not append). Nested objects are not recursively
// merged — top-level semantics only, as specified.
function mergeFileConfig(base: BrowserConfig, fileConfig: Record<string, unknown>): BrowserConfig {
  const result: BrowserConfig = { ...base };

  if (typeof fileConfig['headless'] === 'boolean') {
    result.headless = fileConfig['headless'];
  }
  if (Array.isArray(fileConfig['allowedDomains'])) {
    result.allowedDomains = (fileConfig['allowedDomains'] as unknown[])
      .filter((v): v is string => typeof v === 'string')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(fileConfig['blockedDomains'])) {
    result.blockedDomains = (fileConfig['blockedDomains'] as unknown[])
      .filter((v): v is string => typeof v === 'string')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }
  if (typeof fileConfig['domSnapshots'] === 'boolean') {
    result.domSnapshots = fileConfig['domSnapshots'];
  }
  if (fileConfig['backend'] === 'playwright') {
    result.backend = 'playwright';
  } else if (fileConfig['backend'] !== undefined) {
    throw new Error(
      `AFK_BROWSER_BACKEND: only "playwright" is supported in Phase 1, got: ${String(fileConfig['backend'])}`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export function loadBrowserConfig(opts?: LoadBrowserConfigOptions): BrowserConfig {
  // Contract: env override for tests; falls back to the global `env` object.
  // All access to environment values goes through this local alias — never
  // through process.env directly in this file.
  const envSource: Record<string, string | undefined> = opts?.env ?? defaultEnv;
  const readFile = opts?.readFileSync ?? defaultReadFileSync;

  const surface = opts?.surface ?? envSource['AGENT_SURFACE'];

  const headless = resolveHeadlessDefault(envSource['AFK_BROWSER_HEADLESS'], surface);
  const allowedDomains = parseDomainList(envSource['AFK_BROWSER_ALLOWED_DOMAINS']);
  const blockedDomains = parseDomainList(envSource['AFK_BROWSER_BLOCKED_DOMAINS']);
  const domSnapshots = parseBooleanEnv(envSource['AFK_BROWSER_DOM_SNAPSHOTS']);
  const backend = resolveBackend(envSource['AFK_BROWSER_BACKEND']);

  const base: BrowserConfig = {
    headless,
    allowedDomains,
    blockedDomains,
    domSnapshots,
    backend,
    configPath: null,
  };

  // Determine JSON config path: explicit env override, or default location.
  const explicitPath = envSource['AFK_BROWSER_CONFIG'];
  const candidatePath =
    explicitPath !== undefined && explicitPath.trim() !== ''
      ? explicitPath.trim()
      : join(getAfkConfigDir(), 'browser.json');

  const raw = readFile(candidatePath);
  if (raw === undefined) {
    // No JSON file present — return env-derived config as-is.
    return base;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse browser config at ${candidatePath}: ${String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Browser config at ${candidatePath} must be a JSON object`);
  }

  const merged = mergeFileConfig(base, parsed as Record<string, unknown>);
  merged.configPath = candidatePath;
  return merged;
}

// ---------------------------------------------------------------------------
// Domain policy enforcement
// ---------------------------------------------------------------------------

export function enforceDomainPolicy(
  url: string,
  config: BrowserConfig,
): { allowed: true } | { allowed: false; reason: string } {
  // Contract: parse URL to extract host. Throws if `url` is not a valid URL.
  // The caller (browser_open handler) is expected to validate URLs before
  // reaching this function, but we re-parse here so the policy is
  // self-contained and testable without a live browser.
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { allowed: false, reason: `invalid URL: ${url}` };
  }

  // Block beats allow — check blocklist first.
  for (const pattern of config.blockedDomains) {
    if (matchesGlob(host, pattern)) {
      return {
        allowed: false,
        reason: `blocked by AFK_BROWSER_BLOCKED_DOMAINS: ${pattern}`,
      };
    }
  }

  // Non-empty allowlist: host must match at least one entry.
  if (config.allowedDomains.length > 0) {
    const allowed = config.allowedDomains.some((pattern) => matchesGlob(host, pattern));
    if (!allowed) {
      return { allowed: false, reason: 'not in AFK_BROWSER_ALLOWED_DOMAINS' };
    }
  }

  return { allowed: true };
}
