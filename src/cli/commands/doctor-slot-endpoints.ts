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
 * Invariant: the only credential the probe ever sends is the slot's OWN
 * `apiKey`, only as an `Authorization` header, and never in a returned string;
 * URL userinfo and query strings are stripped before a URL is printed or fetched.
 * The probe never replicates the runtime's fallback auth (OPENAI_API_KEY, Codex
 * or xAI OAuth): see planProbeAuth for why.
 */

import { getSlotBindings, SLOT_NAMES, type ModelSlots, type SlotName } from '../../agent/session/model-slots.js';
import { explicitSlotRoute } from '../../agent/session/slot-route.js';
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
  /** The slot's resolved wire route (decides whether the probe may send the slot key). */
  routeOf?: (slot: SlotName, bindings: ModelSlots) => Promise<string>;
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

/** Classify a completed HTTP response into a Check. */
async function classifyResponse(
  name: string,
  url: string,
  modelId: string,
  res: Response,
  auth: ProbeAuth,
): Promise<Check> {
  if (res.status === 401 || res.status === 403) {
    // Invariant: only a 401/403 to the slot's own key reads "auth rejected".
    // When the probe sent nothing, the runtime may still authenticate through a
    // source doctor deliberately does not replicate, so the wording is
    // "auth unverified" and never tells the user to fix a key they may not need.
    if (auth.kind === 'slot-key') {
      return {
        name,
        state: 'warn',
        detail: `${url} returned ${res.status} (auth rejected)`,
        fix: 'Check the slot API key (AFK_MODEL_<TIER>_API_KEY) matches the server key',
      };
    }
    if (auth.kind === 'no-slot-key') {
      return {
        name,
        state: 'warn',
        detail:
          `${url} returned ${res.status} (auth unverified: the slot has no key of its own; ` +
          'at runtime afk may authenticate with OPENAI_API_KEY / Codex credentials)',
        fix: 'Give the slot its own key (AFK_MODEL_<TIER>_API_KEY) so doctor can verify it, or confirm the server accepts your OPENAI_API_KEY',
      };
    }
    return {
      name,
      state: 'warn',
      detail: `${url} returned ${res.status} (auth unverified: ${auth.reason})`,
      fix: 'doctor does not replicate this auth; verify the endpoint by starting a session on this slot',
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

/** What the probe sends and how a 401/403 is worded. */
export type ProbeAuth =
  /** The slot's own key is sent; a 401/403 means the server rejected it. */
  | { kind: 'slot-key'; key: string }
  /** openai-compatible slot with no key of its own: nothing sent. */
  | { kind: 'no-slot-key' }
  /** The runtime authenticates in a way the probe does not replicate: nothing sent. */
  | { kind: 'unverified'; reason: string };

/**
 * Invariant: the probe sends a credential only when it is exactly what the
 * runtime sends to exactly the URL being probed, so a credential never crosses
 * to an endpoint the runtime would not send it to. That holds for the slot's
 * own `apiKey` when BOTH routes are openai-compatible:
 *   - the wire route (`providerForModel`, where a global AFK_PROVIDER beats the
 *     slot provider), which decides which provider sends the request; and
 *   - the endpoint route (`explicitSlotRoute(provider)` first, as
 *     `applySlotCredentials` uses), which decides where the slot baseUrl lands.
 *     If they differ (e.g. AFK_PROVIDER=openai with a `provider: 'anthropic'`
 *     slot) the runtime never sends anything to this baseUrl.
 * Everything else sends nothing:
 *   - forced ChatGPT OAuth: the runtime ignores the slot key for an OAuth token;
 *   - xAI routes: own auth, which can abort on an ambiguous key + stored OAuth
 *     (xai/auth.ts), so a probe "pass" with the key would be false;
 *   - no slot key: the runtime falls back to OPENAI_API_KEY / Codex credentials.
 *     History: rounds 1-3 of PR #3887 replicated that fallback and each round
 *     found another case where it sent a key to an endpoint the runtime does
 *     not; the fallback was removed rather than patched again.
 */
export function planProbeAuth(binding: ModelSlots[SlotName], wireRoute: string): ProbeAuth {
  const endpointRoute = explicitSlotRoute(binding.provider) ?? wireRoute;
  if (wireRoute !== 'openai-compatible' || endpointRoute !== 'openai-compatible') {
    const via = endpointRoute === wireRoute ? wireRoute : `${wireRoute} with a ${endpointRoute} endpoint`;
    return { kind: 'unverified', reason: `the slot routes via ${via}` };
  }
  if (binding.provider === 'chatgpt-oauth') {
    return { kind: 'unverified', reason: 'the slot uses ChatGPT OAuth' };
  }
  if (binding.apiKey) return { kind: 'slot-key', key: binding.apiKey };
  return { kind: 'no-slot-key' };
}

async function probeSlot(
  slot: SlotName,
  binding: ModelSlots[SlotName],
  baseUrl: string,
  wireRoute: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Check> {
  const name = `Model slot "${slot}" endpoint`;
  const url = modelsUrl(baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Invariant: the credential is only ever a header value, never in output.
  const auth = planProbeAuth(binding, wireRoute);
  const sentKey = auth.kind === 'slot-key' ? auth.key : undefined;
  if (sentKey) headers['Authorization'] = `Bearer ${sentKey}`;

  let check: Check;
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    check = await classifyResponse(name, url, binding.id, res, auth);
  } catch (err) {
    check = {
      name,
      state: 'fail',
      detail: `${url} unreachable: ${describeNetworkError(err)}`,
      fix: `Is the server running? Try: curl ${url}`,
    };
  }
  // Redact the slot key and the binding's key alike (defence in depth).
  return redactCheck(redactCheck(check, sentKey), binding.apiKey);
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

  const targets: Array<{ slot: SlotName; baseUrl: string; route: string }> = [];
  for (const slot of SLOT_NAMES) {
    const baseUrl = bindings[slot]?.baseUrl;
    if (!baseUrl || !baseUrl.trim()) continue;
    if (await isAnthropic(slot, bindings)) continue;
    targets.push({ slot, baseUrl, route: await routeOf(slot, bindings) });
  }
  return Promise.all(
    targets.map(({ slot, baseUrl, route }) =>
      probeSlot(slot, bindings[slot], baseUrl, route, timeoutMs, fetchImpl),
    ),
  );
}
