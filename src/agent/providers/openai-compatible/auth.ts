/**
 * Auth resolution for the `openai-compatible` provider.
 *
 * Resolves an OpenAI API key from a fixed precedence chain and produces a
 * tagged result that callers can use for both client construction and the
 * `afk provider auth diagnose` surface. Strictly pure: takes an explicit
 * environment + filesystem reader and returns a value. No I/O happens in the
 * resolver itself.
 *
 * Precedence (highest wins):
 *   1. Explicit `AgentConfig.apiKey`            → `'config'`
 *   2. `OPENAI_API_KEY` env var                 → `'env'`
 *   3. `CODEX_API_KEY` env var                  → `'env'`
 *   4. `~/.codex/auth.json` with API key mode   → `'codex-cli'`
 *   5. nothing usable                           → `null`
 *
 * `~/.codex/auth.json` shape (observed; OpenAI Codex CLI does not document
 * this file, so the reader is defensive):
 *
 * ```json
 * {
 *   "auth_mode": "apikey" | "chatgpt",
 *   "OPENAI_API_KEY": string | null,
 *   "tokens": { ...ChatGPT-account OAuth bundle... },
 *   "last_refresh": string
 * }
 * ```
 *
 * When `auth_mode === 'chatgpt'` (the ChatGPT-account OAuth path), this
 * resolver deliberately returns `'no-usable-auth-codex-oauth'` instead of
 * the access_token. ChatGPT OAuth refresh lives in the Codex Rust binary and
 * is not safe for AFK to own — see `docs/specs/provider-agnostic-wire-seam.md`
 * for the full rationale and `~/.codex/auth.json` schema notes.
 *
 * Safety: this module never logs token material. All diagnostics surface
 * only the source tag and (where relevant) a 4-char `last4` fingerprint —
 * never the raw key.
 *
 * @module agent/providers/openai-compatible/auth
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where a resolved key came from. Drives both client construction and diagnostics. */
export type OpenAIAuthSource =
  | 'config'
  | 'env'
  | 'codex-cli'
  | 'no-usable-auth'
  | 'no-usable-auth-codex-oauth';

/**
 * Result of auth resolution. When `apiKey` is set the request can proceed;
 * otherwise `source` carries the diagnostic context for the surface to
 * render. `last4` is only ever populated alongside a successful resolution.
 */
export interface OpenAIAuthResolution {
  apiKey: string | null;
  source: OpenAIAuthSource;
  /** Last 4 chars of the resolved key — safe to log, useful for "which key are you using?" UX. */
  last4?: string;
  /** Env var that supplied the key when source === 'env'. */
  envVar?: 'OPENAI_API_KEY' | 'CODEX_API_KEY';
}

/** Minimal env + fs surface so the resolver can be tested without touching disk. */
export interface AuthResolverDeps {
  /** Returns the env value for `key`, or undefined. Defaults to `process.env[key]`. */
  readEnv?: (key: string) => string | undefined;
  /** Returns the home directory. Defaults to `os.homedir()`. */
  homedir?: () => string;
  /**
   * Reads `path` as UTF-8 text. Returns `null` on any error (missing file,
   * permission denied, etc.) — auth resolution is best-effort and never
   * throws on a missing optional source.
   */
  readFile?: (path: string) => string | null;
}

/** Default fs reader: returns null on any error rather than throwing. */
function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Resolve an OpenAI API key from the configured precedence chain.
 *
 * @param explicitConfigKey - `AgentConfig.apiKey` (caller-provided), if any.
 * @param deps - Optional env + fs injection point for tests.
 */
export function resolveOpenAIAuth(
  explicitConfigKey: string | undefined,
  deps: AuthResolverDeps = {},
): OpenAIAuthResolution {
  const readEnv = deps.readEnv ?? ((k) => process.env[k]);
  const home = (deps.homedir ?? homedir)();
  const readFile = deps.readFile ?? defaultReadFile;

  // Tier 1: explicit config key.
  if (explicitConfigKey && explicitConfigKey.length > 0) {
    return { apiKey: explicitConfigKey, source: 'config', last4: last4Of(explicitConfigKey) };
  }

  // Tier 2: env var (canonical name).
  const openAIEnvKey = readEnv('OPENAI_API_KEY');
  if (openAIEnvKey && openAIEnvKey.length > 0) {
    return {
      apiKey: openAIEnvKey,
      source: 'env',
      last4: last4Of(openAIEnvKey),
      envVar: 'OPENAI_API_KEY',
    };
  }

  // Tier 3: env var (legacy Codex alias). Keep this after OPENAI_API_KEY so
  // the canonical OpenAI key remains the unambiguous winner when both are set.
  const codexEnvKey = readEnv('CODEX_API_KEY');
  if (codexEnvKey && codexEnvKey.length > 0) {
    return {
      apiKey: codexEnvKey,
      source: 'env',
      last4: last4Of(codexEnvKey),
      envVar: 'CODEX_API_KEY',
    };
  }

  // Tier 4: ~/.codex/auth.json (API-key mode only — ChatGPT OAuth is rejected
  // here because AFK cannot safely refresh those tokens). See module docstring.
  const codexAuthPath = join(home, '.codex', 'auth.json');
  const codexRaw = readFile(codexAuthPath);
  if (codexRaw !== null) {
    const parsed = parseCodexAuthJson(codexRaw);
    if (parsed.kind === 'apikey') {
      return { apiKey: parsed.apiKey, source: 'codex-cli', last4: last4Of(parsed.apiKey) };
    }
    if (parsed.kind === 'chatgpt') {
      // Found a Codex login but it's the OAuth path we can't use.
      // Surface this distinctly so the diagnostic can give a precise next step.
      return { apiKey: null, source: 'no-usable-auth-codex-oauth' };
    }
    // `parsed.kind === 'invalid' | 'no-key'` falls through to no-usable-auth.
  }

  return { apiKey: null, source: 'no-usable-auth' };
}

type CodexAuthParse =
  | { kind: 'apikey'; apiKey: string }
  | { kind: 'chatgpt' }
  | { kind: 'no-key' }
  | { kind: 'invalid' };

/**
 * Defensive parse of `~/.codex/auth.json`. The schema is undocumented so we
 * accept "OPENAI_API_KEY is a non-empty string" as the apikey signal
 * regardless of what `auth_mode` claims — some Codex CLI versions populate
 * the key field without explicitly setting `auth_mode: 'apikey'`.
 */
export function parseCodexAuthJson(raw: string): CodexAuthParse {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof obj !== 'object' || obj === null) return { kind: 'invalid' };
  const o = obj as Record<string, unknown>;
  const keyField = o['OPENAI_API_KEY'];
  if (typeof keyField === 'string' && keyField.length > 0) {
    return { kind: 'apikey', apiKey: keyField };
  }
  if (o['auth_mode'] === 'chatgpt') {
    return { kind: 'chatgpt' };
  }
  // File exists, parsed cleanly, but has no usable API key and no OAuth bundle.
  return { kind: 'no-key' };
}

function last4Of(s: string): string {
  return s.length <= 4 ? s : s.slice(-4);
}

/**
 * Render a one-line human-readable diagnostic for a resolution. Used by the
 * `afk provider auth diagnose` command and surfaced in init errors when
 * `apiKey === null`. Never includes raw token material.
 */
export function formatAuthDiagnostic(resolution: OpenAIAuthResolution): string {
  switch (resolution.source) {
    case 'config':
      return `using explicit AFK config API key (…${resolution.last4 ?? '????'})`;
    case 'env':
      return `using ${resolution.envVar ?? 'OPENAI_API_KEY'} env var (…${resolution.last4 ?? '????'})`;
    case 'codex-cli':
      return `using Codex CLI API key from ~/.codex/auth.json (…${resolution.last4 ?? '????'})`;
    case 'no-usable-auth-codex-oauth':
      return (
        'AFK OpenAI provider currently requires API key auth. ' +
        'Found ChatGPT/OAuth credentials in ~/.codex/auth.json but no API key. ' +
        'Run `codex login --api-key` or set OPENAI_API_KEY.'
      );
    case 'no-usable-auth':
    default:
      return (
        'No OpenAI auth found. ' +
        'Set OPENAI_API_KEY, pass an explicit apiKey in AFK config, ' +
        'or run `codex login --api-key`.'
      );
  }
}
