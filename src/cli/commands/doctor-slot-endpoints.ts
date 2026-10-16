/**
 * `afk doctor` reachability check for model slots bound to a custom
 * OpenAI-compatible endpoint (per-slot `baseUrl` from afk.config.json
 * `models.<tier>.baseUrl` or `AFK_MODEL_<TIER>_BASE_URL`).
 *
 * For each such slot it probes `GET <baseUrl>/models` in parallel, each probe
 * bounded by an AbortSignal timeout, and reports:
 *   - pass: 2xx and the slot's model id is in `data[].id`;
 *   - warn: 2xx but the id is absent, 401/403, any other non-2xx, or a body
 *     that is not an OpenAI-style model list;
 *   - fail: the endpoint is unreachable (connection refused, DNS, timeout).
 *
 * Slots without a per-slot baseUrl, and slots routed to the Anthropic Messages
 * wire (a `local-*` / `claude-*` id or `provider: 'anthropic'`), are skipped
 * silently — mirroring how `checkTelegram` returns nothing when unconfigured.
 *
 * Invariant: the slot API key (or fallback-resolved credential) is sent only as
 * an `Authorization` header and never appears in a returned string; URL userinfo
 * and query strings are stripped before a URL is printed or fetched.
 *
 * Auth fallback: when a slot has no per-slot apiKey but routes to the
 * openai-compatible wire, the probe resolves a credential through the same
 * precedence chain the runtime uses (OPENAI_API_KEY → CODEX_API_KEY →
 * ~/.codex/auth.json apikey mode). Forced-OAuth slots and a ChatGPT-OAuth
 * resolution send no credential and report "auth unverified" on 401/403; xAI
 * routes send only the slot's own key. See planProbeAuth.
 */

import { getSlotBindings, SLOT_NAMES, type ModelSlots, type SlotName } from '../../agent/session/model-slots.js';
import { resolveOpenAIAuth, type AuthResolverDeps } from '../../agent/providers/openai-compatible/auth.js';
import type { Check } from './doctor-checks.js';

/** Default per-probe timeout. Short so `afk doctor` never hangs on a dead host. */
export const SLOT_PROBE_TIMEOUT_MS = 3000;

/** How many available ids to list when the slot's id is missing. */
const MAX_LISTED_IDS = 5;

/** Injectable deps — tests pass bindings, a tiny timeout, and routing/auth stubs. */
export interface SlotEndpointDeps {
  bindings?: ModelSlots;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** True when the slot routes to the Anthropic Messages wire (not probed). */
  isAnthropicRouted?: (slot: SlotName, bindings: ModelSlots) => Promise<boolean>;
  /** The slot's resolved provider route (decides which credential the probe may send). */
  routeOf?: (slot: SlotName, bindings: ModelSlots) => Promise<string>;
  /**
   * Injectable env + fs surface forwarded to `resolveOpenAIAuth` for the
   * fallback credential path. Tests pass a stub; production uses the default
   * (reads real process.env / ~/.codex/auth.json via resolveOpenAIAuth's
   * own defaults).
   */
  authDeps?: AuthResolverDeps;
}

/**
 * Remove `user:pass@` userinfo, any query string, and any fragment from a URL
 * so it is safe to print. Falls back to a regex strip when the URL is invalid.
 */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return raw.replace(/[^\s/@]*@/g, '').replace(/[?#].*$/, '');
  }
}

/** `<baseUrl>/models` with no doubled slash; a trailing `/v1` is kept as-is. */
export function modelsUrl(baseUrl: string): string {
  return `${sanitizeUrl(baseUrl.trim()).replace(/\/+$/, '')}/models`;
}

async function defaultRouteOf(slot: SlotName, bindings: ModelSlots): Promise<string> {
  // Lazy import keeps doctor load light; reuses the real routing decision
  // instead of re-deriving it here.
  const { providerForModel } = await import('../../agent/providers/index.js');
  return providerForModel(slot, { slots: bindings });
}

async function defaultIsAnthropicRouted(slot: SlotName, bindings: ModelSlots): Promise<boolean> {
  return (await defaultRouteOf(slot, bindings)) === 'anthropic-direct';
}

function errorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function describeNetworkError(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out';
  const code = errorCode(err);
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `DNS lookup failed (${code})`;
  if (code) return `network error (${code})`;
  return `network error: ${err instanceof Error ? err.message : 'unknown'}`;
}

function listedIds(body: unknown): string[] | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  return data
    .map((m) => (m as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * Describe which credential source was used, for the 401/403 fix message.
 * Returns a human-readable string naming the source so the fix text is accurate.
 */
function describeAuthSource(source: string, envVar?: string): string {
  if (source === 'env') return envVar ?? 'OPENAI_API_KEY';
  if (source === 'codex-cli') return 'Codex CLI key from ~/.codex/auth.json';
  if (source === 'config') return 'slot API key (AFK_MODEL_<TIER>_API_KEY)';
  return 'resolved credential';
}

/** Classify a completed HTTP response into a Check. */
async function classifyResponse(
  name: string,
  url: string,
  modelId: string,
  res: Response,
  authSource: string | undefined,
  authEnvVar: string | undefined,
): Promise<Check> {
  if (res.status === 401 || res.status === 403) {
    // Invariant: authSource === undefined means the probe sent no credential
    // (unreproducible-auth case — xAI or chatgpt-oauth with custom baseUrl).
    // Report "auth unverified" rather than "auth rejected" so the user is not
    // misled into setting a key they don't need.
    if (authSource === 'none') {
      return {
        name,
        state: 'warn',
        detail: `${url} returned ${res.status} (no credential configured)`,
        fix: 'Set the slot API key (AFK_MODEL_<TIER>_API_KEY) or OPENAI_API_KEY to the server key',
      };
    }
    if (authSource === undefined) {
      return {
        name,
        state: 'warn',
        detail: `${url} returned ${res.status} (auth unverified — probe could not reproduce slot auth)`,
        fix: 'The slot uses an auth mechanism the doctor probe cannot replicate. Verify the endpoint manually.',
      };
    }
    const src = describeAuthSource(authSource, authEnvVar);
    return {
      name,
      state: 'warn',
      detail: `${url} returned ${res.status} (auth rejected)`,
      fix: `Check the ${src} matches the server key`,
    };
  }
  if (!res.ok) {
    return {
      name,
      state: 'warn',
      detail: `${url} returned ${res.status}`,
      fix: `Confirm the baseUrl points at an OpenAI-compatible API: curl ${url}`,
    };
  }
  let ids: string[] | undefined;
  try {
    ids = listedIds(await res.json());
  } catch {
    ids = undefined;
  }
  if (ids === undefined) {
    return {
      name,
      state: 'warn',
      detail: `${url} reachable but did not return an OpenAI-style model list`,
      fix: `Confirm the baseUrl includes the API prefix (often /v1): curl ${url}`,
    };
  }
  if (ids.includes(modelId)) {
    return { name, state: 'pass', detail: `${url} — ${modelId} available` };
  }
  const sample = ids.slice(0, MAX_LISTED_IDS).join(', ');
  const more = ids.length > MAX_LISTED_IDS ? `, … (${ids.length} total)` : '';
  return {
    name,
    state: 'warn',
    detail: `${url} reachable but ${modelId} not listed; available: ${sample || '(none)'}${more}`,
    fix: 'Set the slot model id to one the server lists, or load the model on the server',
  };
}

/** Replace any occurrence of the secret in a Check's strings (defence in depth). */
function redactCheck(check: Check, secret: string | undefined): Check {
  if (!secret) return check;
  const scrub = (s: string | undefined): string | undefined =>
    s === undefined ? undefined : s.split(secret).join('****');
  const out: Check = { name: check.name, state: check.state };
  const detail = scrub(check.detail);
  if (detail !== undefined) out.detail = detail;
  const fix = scrub(check.fix);
  if (fix !== undefined) out.fix = fix;
  return out;
}

/** What credential (if any) the probe sends, and how a 401/403 is worded. */
interface ProbeAuth {
  /** Sent as the Bearer token and scrubbed from output; undefined = none sent. */
  key?: string;
  /** 'config' | resolver source | 'none' (nothing configured); undefined = unverifiable. */
  source?: string;
  envVar?: string;
}

/**
 * Invariant: auth is decided from the slot's RESOLVED route (the same
 * `providerForModel` decision the runtime makes), never from `binding.provider`
 * alone: a `grok-*` id routes to xAI with no provider field, and the OpenAI
 * fallback chain must never send OPENAI_API_KEY to an xAI endpoint
 * (xai/auth.ts never uses it).
 *   - forced OAuth (`chatgpt-oauth` / `xai-oauth`): the runtime ignores any slot
 *     key in favour of an OAuth token the probe does not replicate, so nothing
 *     is sent and a 401 reads "auth unverified".
 *   - xAI route: only the slot's own key is sent; no cross-provider fallback.
 *   - otherwise: the slot key, else `resolveOpenAIAuth`'s fallback chain
 *     (OPENAI_API_KEY, CODEX_API_KEY, ~/.codex/auth.json API-key mode), mirroring
 *     applySlotCredentials + build-query. A ChatGPT-OAuth resolution is not
 *     replicated (unverifiable); no resolution at all is 'none'.
 */
export function planProbeAuth(
  binding: ModelSlots[SlotName],
  route: string,
  authDeps: AuthResolverDeps,
): ProbeAuth {
  if (binding.provider === 'chatgpt-oauth' || binding.provider === 'xai-oauth' || route === 'xai-oauth') return {};
  if (binding.apiKey) return { key: binding.apiKey, source: 'config' };
  if (route === 'xai') return {};
  const resolution = resolveOpenAIAuth(undefined, authDeps, false);
  if (resolution.apiKey === null) {
    return resolution.source.startsWith('no-usable-auth') ? { source: 'none' } : {};
  }
  if (resolution.source === 'chatgpt-oauth') return {};
  const auth: ProbeAuth = { key: resolution.apiKey, source: resolution.source };
  if (resolution.envVar !== undefined) auth.envVar = resolution.envVar;
  return auth;
}

async function probeSlot(
  slot: SlotName,
  bindings: ModelSlots,
  route: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  authDeps: AuthResolverDeps,
): Promise<Check> {
  const binding = bindings[slot];
  const name = `Model slot "${slot}" endpoint`;
  const url = modelsUrl(binding.baseUrl ?? '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Invariant: the credential is only ever a header value, never in output.
  const auth = planProbeAuth(binding, route, authDeps);
  const resolvedKey = auth.key;
  const authSource = auth.source;
  const authEnvVar = auth.envVar;
  if (resolvedKey) headers['Authorization'] = `Bearer ${resolvedKey}`;

  let check: Check;
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    check = await classifyResponse(name, url, binding.id, res, authSource, authEnvVar);
  } catch (err) {
    check = {
      name,
      state: 'fail',
      detail: `${url} unreachable: ${describeNetworkError(err)}`,
      fix: `Is the server running? Try: curl ${url}`,
    };
  }
  // Redact whichever credential was used (binding.apiKey or resolved fallback).
  return redactCheck(check, resolvedKey);
}

/**
 * Probe every slot with a custom OpenAI-compatible baseUrl. Returns one Check
 * per probed slot, in SLOT_NAMES order; an empty array when none are configured.
 */
export async function checkSlotEndpoints(deps: SlotEndpointDeps = {}): Promise<Check[]> {
  const bindings = deps.bindings ?? getSlotBindings();
  const timeoutMs = deps.timeoutMs ?? SLOT_PROBE_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const isAnthropic = deps.isAnthropicRouted ?? defaultIsAnthropicRouted;
  const routeOf = deps.routeOf ?? defaultRouteOf;
  const authDeps = deps.authDeps ?? {};

  const targets: Array<{ slot: SlotName; route: string }> = [];
  for (const slot of SLOT_NAMES) {
    const baseUrl = bindings[slot]?.baseUrl;
    if (!baseUrl || !baseUrl.trim()) continue;
    if (await isAnthropic(slot, bindings)) continue;
    targets.push({ slot, route: await routeOf(slot, bindings) });
  }
  return Promise.all(
    targets.map(({ slot, route }) => probeSlot(slot, bindings, route, timeoutMs, fetchImpl, authDeps)),
  );
}
