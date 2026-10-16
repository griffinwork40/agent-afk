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
 * Invariant: the slot API key is sent only as an `Authorization` header and
 * never appears in a returned string; URL userinfo and query strings are
 * stripped before a URL is printed or fetched.
 */

import { getSlotBindings, SLOT_NAMES, type ModelSlots, type SlotName } from '../../agent/session/model-slots.js';
import type { Check } from './doctor-checks.js';

/** Default per-probe timeout. Short so `afk doctor` never hangs on a dead host. */
export const SLOT_PROBE_TIMEOUT_MS = 3000;

/** How many available ids to list when the slot's id is missing. */
const MAX_LISTED_IDS = 5;

/** Injectable deps — tests pass bindings, a tiny timeout, and a routing stub. */
export interface SlotEndpointDeps {
  bindings?: ModelSlots;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** True when the slot routes to the Anthropic Messages wire (not probed). */
  isAnthropicRouted?: (slot: SlotName, bindings: ModelSlots) => Promise<boolean>;
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

async function defaultIsAnthropicRouted(slot: SlotName, bindings: ModelSlots): Promise<boolean> {
  // Lazy import keeps doctor load light; reuses the real routing decision
  // instead of re-deriving it here.
  const { providerForModel } = await import('../../agent/providers/index.js');
  return providerForModel(slot, { slots: bindings }) === 'anthropic-direct';
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

/** Classify a completed HTTP response into a Check. */
async function classifyResponse(name: string, url: string, modelId: string, res: Response): Promise<Check> {
  if (res.status === 401 || res.status === 403) {
    return {
      name,
      state: 'warn',
      detail: `${url} returned ${res.status} (auth rejected)`,
      fix: 'Check the slot API key (AFK_MODEL_<TIER>_API_KEY) matches the server key',
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

async function probeSlot(
  slot: SlotName,
  bindings: ModelSlots,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Check> {
  const binding = bindings[slot];
  const name = `Model slot "${slot}" endpoint`;
  const url = modelsUrl(binding.baseUrl ?? '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (binding.apiKey) headers['Authorization'] = `Bearer ${binding.apiKey}`;
  let check: Check;
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    check = await classifyResponse(name, url, binding.id, res);
  } catch (err) {
    check = {
      name,
      state: 'fail',
      detail: `${url} unreachable: ${describeNetworkError(err)}`,
      fix: `Is the server running? Try: curl ${url}`,
    };
  }
  return redactCheck(check, binding.apiKey);
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

  const targets: SlotName[] = [];
  for (const slot of SLOT_NAMES) {
    const baseUrl = bindings[slot]?.baseUrl;
    if (!baseUrl || !baseUrl.trim()) continue;
    if (await isAnthropic(slot, bindings)) continue;
    targets.push(slot);
  }
  return Promise.all(targets.map((slot) => probeSlot(slot, bindings, timeoutMs, fetchImpl)));
}
