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
 * When `auth_mode === 'chatgpt'` (the ChatGPT-account OAuth path):
 *   - By default this resolver returns `'no-usable-auth-codex-oauth'` (the
 *     token is present but unused), preserving the historical safe behavior.
 *   - When the explicit opt-in flag `AFK_OPENAI_CHATGPT_OAUTH` is truthy, the
 *     resolver returns the `access_token` tagged `'chatgpt-oauth'` plus the
 *     decoded `accountId`/`expiresAt`. This is READ-ONLY: AFK never refreshes
 *     these tokens (refresh stays with the `codex` binary, whose single-use
 *     refresh tokens make concurrent AFK-owned refresh unsafe). On expiry the
 *     diagnostic asks the user to re-run `codex`.
 *
 * See `docs/specs/provider-agnostic-wire-seam.md` for the full rationale and
 * `~/.codex/auth.json` schema notes.
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
  | 'chatgpt-oauth'
  | 'no-usable-auth'
  | 'no-usable-auth-codex-oauth'
  | 'no-usable-auth-forced-chatgpt-oauth';

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
  /** ChatGPT account id (source === 'chatgpt-oauth') — sent as the `chatgpt-account-id` header. */
  accountId?: string;
  /** Access-token expiry as epoch SECONDS (source === 'chatgpt-oauth'), decoded from the JWT `exp` claim. */
  expiresAt?: number;
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
 * @param forceChatgptOAuth - When true (a `provider: 'chatgpt-oauth'` slot),
 *   resolve the ChatGPT-subscription token from `~/.codex/auth.json` ahead of
 *   every other tier and without the global `AFK_OPENAI_CHATGPT_OAUTH` flag.
 */
export function resolveOpenAIAuth(
  explicitConfigKey: string | undefined,
  deps: AuthResolverDeps = {},
  forceChatgptOAuth = false,
): OpenAIAuthResolution {
  const readEnv = deps.readEnv ?? ((k) => process.env[k]);
  const home = (deps.homedir ?? homedir)();
  const readFile = deps.readFile ?? defaultReadFile;

  // Tier 0: per-slot forced ChatGPT-subscription OAuth (a slot bound
  // `provider: 'chatgpt-oauth'`). Selects the ChatGPT token from
  // ~/.codex/auth.json REGARDLESS of an explicit key / OPENAI_API_KEY /
  // CODEX_API_KEY, and WITHOUT the global AFK_OPENAI_CHATGPT_OAUTH flag — the
  // slot declaration IS the opt-in. This is what lets a ChatGPT-subscription
  // model and a custom keyed OpenAI model resolve independently in one session.
  if (forceChatgptOAuth) {
    const codexAuthPath = join(home, '.codex', 'auth.json');
    const codexRaw = readFile(codexAuthPath);
    if (codexRaw !== null) {
      const parsed = parseCodexAuthJson(codexRaw);
      if (parsed.kind === 'chatgpt' && parsed.accessToken) {
        const res: OpenAIAuthResolution = {
          apiKey: parsed.accessToken,
          source: 'chatgpt-oauth',
          last4: last4Of(parsed.accessToken),
        };
        if (parsed.accountId !== undefined) res.accountId = parsed.accountId;
        if (parsed.expiresAt !== undefined) res.expiresAt = parsed.expiresAt;
        return res;
      }
    }
    // Slot explicitly requires ChatGPT OAuth but no usable token was found.
    return { apiKey: null, source: 'no-usable-auth-forced-chatgpt-oauth' };
  }

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
      // ChatGPT-subscription OAuth. Gated behind an explicit opt-in flag (off
      // by default): the backend is undocumented and AFK does NOT refresh
      // these tokens (read-only — refresh stays with `codex`). When disabled,
      // surface distinctly so the diagnostic can give a precise next step.
      if (chatGptOAuthEnabled(readEnv) && parsed.accessToken) {
        const res: OpenAIAuthResolution = {
          apiKey: parsed.accessToken,
          source: 'chatgpt-oauth',
          last4: last4Of(parsed.accessToken),
        };
        if (parsed.accountId !== undefined) res.accountId = parsed.accountId;
        if (parsed.expiresAt !== undefined) res.expiresAt = parsed.expiresAt;
        return res;
      }
      return { apiKey: null, source: 'no-usable-auth-codex-oauth' };
    }
    // `parsed.kind === 'invalid' | 'no-key'` falls through to no-usable-auth.
  }

  return { apiKey: null, source: 'no-usable-auth' };
}

type CodexAuthParse =
  | { kind: 'apikey'; apiKey: string }
  | { kind: 'chatgpt'; accessToken?: string; accountId?: string; expiresAt?: number }
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
  // ChatGPT OAuth: detected via `auth_mode` OR (defensively) the presence of a
  // `tokens.access_token` — some Codex CLI versions omit `auth_mode`.
  const tokens = o['tokens'];
  const tokenBag =
    typeof tokens === 'object' && tokens !== null ? (tokens as Record<string, unknown>) : null;
  const accessToken = tokenBag && typeof tokenBag['access_token'] === 'string'
    ? (tokenBag['access_token'] as string)
    : undefined;
  if (o['auth_mode'] === 'chatgpt' || accessToken) {
    const result: { kind: 'chatgpt'; accessToken?: string; accountId?: string; expiresAt?: number } = {
      kind: 'chatgpt',
    };
    if (accessToken) result.accessToken = accessToken;
    if (tokenBag) {
      const accountId = extractChatGptAccountId(tokenBag);
      if (accountId !== undefined) result.accountId = accountId;
      const expiresAt = extractChatGptExpiry(tokenBag);
      if (expiresAt !== undefined) result.expiresAt = expiresAt;
    }
    return result;
  }
  // File exists, parsed cleanly, but has no usable API key and no OAuth bundle.
  return { kind: 'no-key' };
}

function last4Of(s: string): string {
  return s.length <= 4 ? s : s.slice(-4);
}

/** Truthy check for the ChatGPT-subscription OAuth opt-in flag (off by default). */
function chatGptOAuthEnabled(readEnv: (key: string) => string | undefined): boolean {
  const v = readEnv('AFK_OPENAI_CHATGPT_OAUTH');
  if (!v) return false;
  const n = v.trim().toLowerCase();
  return n === '1' || n === 'true' || n === 'yes' || n === 'on';
}

/**
 * Decode a JWT payload WITHOUT signature verification. We only ever read this
 * from the local `~/.codex/auth.json` (already trusted, mode 600), purely to
 * surface the account id / expiry for headers + diagnostics — never to make a
 * trust decision. Returns null on any malformed input.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const obj: unknown = JSON.parse(json);
    return typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extract the ChatGPT account id from a Codex token bag. Prefers an explicit
 * `account_id` field; falls back to the JWT claim (both the namespaced
 * `https://api.openai.com/auth.chatgpt_account_id` form Codex/Codex-CLI use
 * and a flat `chatgpt_account_id`).
 */
function extractChatGptAccountId(tokens: Record<string, unknown>): string | undefined {
  const direct = tokens['account_id'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  for (const key of ['access_token', 'id_token']) {
    const tok = tokens[key];
    if (typeof tok !== 'string') continue;
    const claims = decodeJwtClaims(tok);
    if (!claims) continue;
    const ns = claims['https://api.openai.com/auth'];
    if (typeof ns === 'object' && ns !== null) {
      const acct = (ns as Record<string, unknown>)['chatgpt_account_id'];
      if (typeof acct === 'string' && acct.length > 0) return acct;
    }
    const flat = claims['chatgpt_account_id'];
    if (typeof flat === 'string' && flat.length > 0) return flat;
  }
  return undefined;
}

/** Extract the access-token expiry (epoch seconds) from the JWT `exp` claim. */
function extractChatGptExpiry(tokens: Record<string, unknown>): number | undefined {
  const tok = tokens['access_token'];
  if (typeof tok !== 'string') return undefined;
  const exp = decodeJwtClaims(tok)?.['exp'];
  return typeof exp === 'number' ? exp : undefined;
}

/** Render a short "expires in …" / "EXPIRED" suffix for the diagnostic line. */
function formatExpiry(expiresAt?: number): string {
  if (typeof expiresAt !== 'number') return '';
  const secondsLeft = expiresAt - Math.floor(Date.now() / 1000);
  if (secondsLeft <= 0) return ', EXPIRED — re-run `codex` to refresh';
  const h = Math.floor(secondsLeft / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  return `, expires in ${h > 0 ? `${h}h ` : ''}${m}m`;
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
    case 'chatgpt-oauth': {
      const acct = resolution.accountId ? `…${resolution.accountId.slice(-4)}` : 'unknown';
      const expiry = formatExpiry(resolution.expiresAt);
      return `using ChatGPT subscription OAuth from ~/.codex/auth.json (account ${acct}${expiry})`;
    }
    case 'no-usable-auth-codex-oauth':
      return (
        'Found ChatGPT/OAuth credentials in ~/.codex/auth.json but the OpenAI provider is in API-key mode. ' +
        'To use your ChatGPT subscription, set AFK_OPENAI_CHATGPT_OAUTH=1 (read-only; AFK will not refresh the token — ' +
        're-run `codex` when it expires). Otherwise run `codex login --api-key` or set OPENAI_API_KEY.'
      );
    case 'no-usable-auth-forced-chatgpt-oauth':
      return (
        "This model's slot is configured provider: 'chatgpt-oauth' but no ChatGPT-subscription token was found in " +
        '~/.codex/auth.json. Sign in with `codex` using ChatGPT (not API-key mode), or change the slot to ' +
        "provider: 'openai' with a key. (read-only; AFK will not refresh the token — re-run `codex` when it expires)."
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
