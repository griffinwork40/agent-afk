/**
 * Grok CLI identity headers for the SuperGrok CLI chat proxy path.
 *
 * When OAuth inference uses `https://cli-chat-proxy.grok.com/v1`, working open
 * clients send Grok-CLI identity headers in addition to `Authorization: Bearer`.
 * Exact values are encapsulated here so they stay one-file tunable if the
 * proxy tightens checks.
 *
 * Invariant: `x-grok-client-version` MUST be a semver the proxy can parse.
 * The proxy was observed to reject versions below 0.1.202; sending the product
 * name `agent-afk` yields HTTP 426 ("Your Grok CLI version (agent-afk) is
 * outdated").
 *
 * Safety: never put access tokens into these headers.
 *
 * @module agent/providers/xai/headers
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env } from '../../../config/env.js';

/** Hostname of the subscription CLI chat proxy. */
export const CLI_CHAT_PROXY_HOST = 'cli-chat-proxy.grok.com';

/** Last-resort version when no operator or official-client version is usable. */
export const DEFAULT_GROK_CLI_COMPAT_VERSION = '1.0.5';

const GROK_CLI_VERSION_ENV = 'AFK_XAI_GROK_CLIENT_VERSION';

// SemVer 2.0.0, including optional prerelease and build metadata.
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface GrokCliHeaderOptions {
  /** Internal compatibility seam; production resolution uses the sources below. */
  clientVersion?: string;
  /** Client identifier the proxy expects. */
  clientIdentifier?: string;
}

/** Injectable sources keep header resolution deterministic in unit tests. */
export interface GrokCliHeaderDeps {
  readEnv?: (key: typeof GROK_CLI_VERSION_ENV) => string | undefined;
  readFile?: (filePath: string) => string;
  homeDir?: () => string;
}

function validSemver(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && SEMVER_RE.test(trimmed) ? trimmed : undefined;
}

/** Returns `version` if it is ≥ `floor`, otherwise `undefined`. */
function aboveFloor(version: string | undefined, floor: string): string | undefined {
  if (!version) return undefined;
  const parse = (s: string): number[] => s.split('.').map(Number);
  const [vMaj = 0, vMin = 0, vPat = 0] = parse(version);
  const [fMaj = 0, fMin = 0, fPat = 0] = parse(floor);
  if (vMaj !== fMaj) return vMaj > fMaj ? version : undefined;
  if (vMin !== fMin) return vMin > fMin ? version : undefined;
  return vPat >= fPat ? version : undefined;
}

/** Read `~/.grok/version.json` written by the official Grok Build CLI. */
export function readOfficialGrokCliVersion(deps: GrokCliHeaderDeps = {}): string | undefined {
  const readFile = deps.readFile ?? ((filePath: string) => readFileSync(filePath, 'utf-8'));
  const homeDir = deps.homeDir ?? homedir;
  try {
    const raw = readFile(join(homeDir(), '.grok', 'version.json'));
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const version = (parsed as Record<string, unknown>)['version'];
    if (typeof version !== 'string') return undefined;
    return validSemver(version);
  } catch {
    return undefined;
  }
}

function resolveGrokCliVersion(
  clientVersion: string | undefined,
  deps: GrokCliHeaderDeps,
): string {
  const readEnv = deps.readEnv ?? ((key: typeof GROK_CLI_VERSION_ENV) => env[key]);
  // This is the operator-facing precedence contract. clientVersion is an
  // internal compatibility seam only; production callers do not supply it.
  return (
    validSemver(readEnv(GROK_CLI_VERSION_ENV))
    ?? validSemver(clientVersion)
    ?? aboveFloor(readOfficialGrokCliVersion(deps), DEFAULT_GROK_CLI_COMPAT_VERSION)
    ?? DEFAULT_GROK_CLI_COMPAT_VERSION
  );
}

/**
 * Return true when `baseURL` targets the CLI chat proxy (host match).
 * Operators who point `AFK_XAI_OAUTH_BASE_URL` at `api.x.ai` get bare Bearer.
 */
export function isCliChatProxyBaseUrl(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === CLI_CHAT_PROXY_HOST || host.endsWith(`.${CLI_CHAT_PROXY_HOST}`);
  } catch {
    // Non-absolute override — treat as non-proxy so we do not invent headers.
    return baseURL.toLowerCase().includes(CLI_CHAT_PROXY_HOST);
  }
}

/**
 * Default identity headers for CLI-proxy requests.
 *
 * Values mirror widely used Grok-CLI-compatible clients. Adjust here only —
 * callers should not hardcode header names at use sites.
 */
export function resolveGrokCliIdentityHeaders(
  opts: GrokCliHeaderOptions = {},
  deps: GrokCliHeaderDeps = {},
): Record<string, string> {
  const version = resolveGrokCliVersion(opts.clientVersion, deps);
  const identifier = opts.clientIdentifier?.trim() || 'grok-shell';
  return {
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': version,
    'x-grok-client-identifier': identifier,
    // User-Agent is diagnostic; the proxy gates on x-grok-client-version.
    'User-Agent': `agent-afk (grok-cli-compat/${version})`,
  };
}
