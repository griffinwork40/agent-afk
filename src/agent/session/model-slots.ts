/**
 * User-configurable model slots (Stage 1 of the model-slots feature).
 *
 * Three fixed capability tiers — `small`, `medium`, `large` — each bound to a
 * concrete model id chosen by the user. The slot NAMES are the stable anchor
 * the `agent`/`compose`/`skill` tools select among (cheapest / general /
 * most-capable); the BINDINGS are what the user configures. Built-in legacy
 * Claude aliases (`haiku`/`sonnet`/`opus`/`*_1m`) and optional user-defined
 * custom names all resolve onto the same three positions.
 *
 * Resolution precedence for any model input string (see {@link slotForInput}):
 *   1. custom name   — a user-assigned `name` on a binding
 *   2. neutral name  — `small` | `medium` | `large`
 *   3. legacy alias  — haiku→small, sonnet/sonnet_1m→medium, opus/opus_1m→large
 *   4. otherwise     — raw concrete id or the `auto` sentinel (passthrough)
 *
 * Bindings are process-global config (one afk.config.json + env per process),
 * read threadlessly by `providerForModel`/`resolveModelId` via
 * {@link getSlotBindings} so every raw routing call site resolves correctly
 * without per-site plumbing — the same Option-A trade-off `providerForModel`
 * already makes for its env hints. `loadConfig()` installs the resolved table
 * with {@link setSlotBindings}; absent that, {@link computeSlotBindings} derives
 * defaults + env on the fly.
 *
 * Stage 2 will extend {@link ModelSlotBinding} with per-slot provider / baseUrl
 * / apiKey so different tiers can target different providers + credentials in
 * one process. Stage 1 is model-id only: provider is inferred from the resolved
 * id via the existing prefix routing in `providers/index.ts`.
 *
 * @module agent/session/model-slots
 */

import { env } from '../../config/env.js';

/** The four fixed capability-tier positions. */
export type SlotName = 'local' | 'small' | 'medium' | 'large';

/** Ordered list of the canonical slot names (cheapest → most capable). */
export const SLOT_NAMES: readonly SlotName[] = ['local', 'small', 'medium', 'large'] as const;

/**
 * Per-slot provider family. Optional override for the id-inferred provider —
 * needed when a tier targets an OpenAI-compatible shim that serves a bare id
 * with no `gpt-`/`o*`/`org/model` signal, or an Anthropic-compatible shim. The
 * concrete bundled providers are `anthropic-direct` / `openai-compatible`;
 * `anthropic`/`openai` are accepted shorthands.
 */
export type SlotProvider = 'anthropic' | 'openai';

/**
 * Binding for one capability tier.
 *   - Stage 1: `id` (+ optional user-defined `name`).
 *   - Stage 2: optional per-slot `provider`/`baseUrl`/`apiKey` so different
 *     tiers can target different providers + credentials in one process.
 */
export interface ModelSlotBinding {
  /** Concrete model id this tier resolves to (e.g. `claude-sonnet-5`, `gpt-4o-mini`). */
  id: string;
  /** Optional user-defined alias; resolves (case-insensitively) to this tier. */
  name?: string;
  /** Explicit provider override; inferred from `id` when omitted. */
  provider?: SlotProvider;
  /**
   * Per-slot endpoint. For an Anthropic-routed tier this is the Messages-API
   * base (`config.baseUrl`); for an OpenAI-routed tier it is the Chat
   * Completions base (`config.openaiBaseUrl`). Applied by `applySlotCredentials`.
   */
  baseUrl?: string;
  /** Per-slot API key. Wins over global credentials for this tier. */
  apiKey?: string;
}

/** Full set of resolved tier bindings. */
export type ModelSlots = Record<SlotName, ModelSlotBinding>;

/**
 * Default tier bindings — reproduce the pre-slots `MODEL_MAP` exactly so that
 * an unconfigured install behaves identically to before this feature.
 * `model-resolution.ts` derives its `MODEL_MAP` from these values to prevent
 * the two from drifting.
 */
export const DEFAULT_SLOT_BINDINGS: ModelSlots = {
  local: { id: '' },
  small: { id: 'claude-haiku-4-5-20251001' },
  medium: { id: 'claude-sonnet-5' },
  large: { id: 'claude-opus-4-8' },
};

/**
 * Built-in legacy Claude aliases → tier position. The `*_1m` variants map to
 * the same tier as their base alias; their distinct 1M context window is
 * handled separately in `model-limits.ts`, not here.
 */
const LEGACY_ALIAS_TO_SLOT: Readonly<Record<string, SlotName>> = {
  haiku: 'small',
  sonnet: 'medium',
  sonnet_1m: 'medium',
  opus: 'large',
  opus_1m: 'large',
};

/**
 * The `auto` model-router sentinel — never treated as a slot alias. Resolved
 * strings pass it through untouched so downstream routing keeps its existing
 * special-case handling.
 */
export const AUTO_SENTINEL = 'auto';

/** Claude Fable 5 wire id — Anthropic's most-capable widely-released model. */
export const CLAUDE_FABLE_5_ID = 'claude-fable-5';

/**
 * Fixed-id model aliases that are NOT capability tiers. Unlike the slot aliases
 * (`small`/`medium`/`large`) and the legacy tier aliases (`haiku`/`sonnet`/
 * `opus`), these name one concrete pinned model and are never rebound by user
 * slot config. `fable` → Claude Fable 5 (`claude-fable-5`), the Mythos-class
 * model GA'd 2026-06-09; it sits above the `large`/opus tier and so has no slot
 * of its own — keeping it a direct alias means adding it does not displace any
 * existing tier binding. Consulted by {@link resolveBinding} after slot
 * resolution and before the raw-id passthrough.
 */
export const DIRECT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  fable: CLAUDE_FABLE_5_ID,
};

/**
 * Process-global resolved bindings, installed by `loadConfig()` via
 * {@link setSlotBindings}. `undefined` until installed; callers fall back to
 * {@link computeSlotBindings} (defaults + env) so the agent layer works without
 * the CLI config loader (library / test use).
 *
 * Invariant: bindings are immutable per process (one afk.config.json + env),
 * so a module-scope singleton is correct here — unlike the mutable per-session
 * provider state in `providers/index.ts`, this is shared config, not session
 * state. Tests reset it with {@link resetSlotBindings}.
 */
let activeBindings: ModelSlots | undefined;

/** Install the process-global slot bindings. Idempotent; called by `loadConfig()`. */
export function setSlotBindings(bindings: ModelSlots | undefined): void {
  activeBindings = bindings;
}

/** Clear the process-global slot bindings (test hygiene). */
export function resetSlotBindings(): void {
  activeBindings = undefined;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

interface EnvSlotOverride {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
}

function readEnvSlot(
  id: string | undefined,
  baseUrl: string | undefined,
  apiKey: string | undefined,
): EnvSlotOverride {
  const out: EnvSlotOverride = {};
  const i = trimmedOrUndefined(id);
  if (i) out.id = i;
  const b = trimmedOrUndefined(baseUrl);
  if (b) out.baseUrl = b;
  const k = trimmedOrUndefined(apiKey);
  if (k) out.apiKey = k;
  return out;
}

function envOverrides(): Record<SlotName, EnvSlotOverride> {
  return {
    local: readEnvSlot(env.AFK_MODEL_LOCAL, env.AFK_MODEL_LOCAL_BASE_URL, env.AFK_MODEL_LOCAL_API_KEY),
    small: readEnvSlot(env.AFK_MODEL_SMALL, env.AFK_MODEL_SMALL_BASE_URL, env.AFK_MODEL_SMALL_API_KEY),
    medium: readEnvSlot(env.AFK_MODEL_MEDIUM, env.AFK_MODEL_MEDIUM_BASE_URL, env.AFK_MODEL_MEDIUM_API_KEY),
    large: readEnvSlot(env.AFK_MODEL_LARGE, env.AFK_MODEL_LARGE_BASE_URL, env.AFK_MODEL_LARGE_API_KEY),
  };
}

/**
 * Build the full resolved bindings by layering: defaults ← file overrides ←
 * env overrides (env wins, mirroring `AFK_MODEL` > afk.config.json). Per slot,
 * env may override `id` / `baseUrl` / `apiKey`; the explicit `provider` and a
 * custom `name` come from the file only. File-provided fields not overridden by
 * env are preserved.
 */
export function computeSlotBindings(
  fileOverrides?: Partial<Record<SlotName, ModelSlotBinding>>,
): ModelSlots {
  const envOver = envOverrides();
  const out = {} as ModelSlots;
  for (const slot of SLOT_NAMES) {
    const base = DEFAULT_SLOT_BINDINGS[slot];
    const file = fileOverrides?.[slot];
    const e = envOver[slot];
    const binding: ModelSlotBinding = { id: e.id ?? file?.id ?? base.id };
    const name = file?.name;
    if (name) binding.name = name;
    const provider = file?.provider;
    if (provider) binding.provider = provider;
    const baseUrl = e.baseUrl ?? file?.baseUrl;
    if (baseUrl) binding.baseUrl = baseUrl;
    const apiKey = e.apiKey ?? file?.apiKey;
    if (apiKey) binding.apiKey = apiKey;
    out[slot] = binding;
  }
  return out;
}

/**
 * Return the active bindings: an explicit `override` wins (used by tests and
 * the `hints.slots` routing path), then the installed process-global table,
 * then a freshly-computed defaults+env table.
 */
export function getSlotBindings(override?: ModelSlots): ModelSlots {
  if (override) return override;
  if (activeBindings) return activeBindings;
  return computeSlotBindings();
}

/**
 * Resolve a model input string to a tier, or `undefined` when it is not a slot
 * alias (a raw concrete id or the `auto` sentinel). Custom names are checked
 * first so a user can shadow the neutral/legacy names; `auto` is never matched.
 */
export function slotForInput(input: string, bindings: ModelSlots = getSlotBindings()): SlotName | undefined {
  const lowered = input.trim().toLowerCase();
  if (!lowered || lowered === AUTO_SENTINEL) return undefined;
  for (const slot of SLOT_NAMES) {
    const name = bindings[slot].name;
    if (name && name.trim().toLowerCase() === lowered) return slot;
  }
  if (lowered === 'local' || lowered === 'small' || lowered === 'medium' || lowered === 'large') {
    return lowered;
  }
  const legacy = LEGACY_ALIAS_TO_SLOT[lowered];
  return legacy;
}

/**
 * Resolve a model input string to its full binding. Slot aliases (custom name /
 * neutral name / legacy alias) resolve to the configured `bindings[slot]`
 * (id + any per-slot provider/baseUrl/apiKey); raw ids and the `auto` sentinel
 * resolve to a bare `{ id }` with no credentials. The returned object is the
 * live binding — treat it as read-only.
 */
export function resolveBinding(
  input: string | undefined,
  bindings: ModelSlots = getSlotBindings(),
): ModelSlotBinding {
  if (input === undefined) return { id: '' };
  const slot = slotForInput(input, bindings);
  if (slot) return bindings[slot];
  // Fixed-id aliases (e.g. `fable` → claude-fable-5) are not tiers, so they
  // bypass slot bindings and resolve straight to their pinned wire id.
  const directId = DIRECT_MODEL_ALIASES[input.trim().toLowerCase()];
  if (directId) return { id: directId };
  return { id: input };
}

/**
 * Resolve a model input string to its concrete bound id. Slot aliases resolve
 * to `bindings[slot].id`; raw ids and the `auto` sentinel pass through
 * unchanged. Idempotent on full ids.
 */
export function resolveModelInput(
  input: string | undefined,
  bindings: ModelSlots = getSlotBindings(),
): string | undefined {
  if (input === undefined) return undefined;
  return resolveBinding(input, bindings).id;
}

/**
 * Guard for selecting a capability tier that has no configured model id (an
 * unconfigured slot — by default only `local`, whose default binding is
 * `{ id: '' }`). Returns a ready-to-print, actionable error message, or
 * `undefined` when `input` is selectable: a configured slot, a raw id, a legacy
 * alias, a custom name, the `auto` sentinel, or `undefined`.
 *
 * Centralizes the message so every selection surface — the REPL/Telegram
 * `/model` command and CLI startup (`afk -m`, `AFK_MODEL`) — rejects the choice
 * identically at the point of selection. Without this guard the empty id reaches
 * a provider, where it surfaces as an opaque empty-model API error or silently
 * falls back to the cloud default model — the latter defeating the entire point
 * of a "local" tier. The guard lives here (not in `resolveBinding`) because that
 * resolver is also called from read-only context-window / capability lookups
 * (`model-limits.ts`, `model-capabilities.ts`) where a throw would be wrong.
 */
export function unconfiguredSlotError(
  input: string | undefined,
  bindings: ModelSlots = getSlotBindings(),
): string | undefined {
  if (input === undefined) return undefined;
  const slot = slotForInput(input, bindings);
  if (slot && bindings[slot].id.trim() === '') {
    const upper = slot.toUpperCase();
    return `The "${slot}" model tier is not configured (no model id). Set AFK_MODEL_${upper}=<id> (optionally AFK_MODEL_${upper}_BASE_URL / AFK_MODEL_${upper}_API_KEY) or "models.${slot}" in afk.config.json, then retry.`;
  }
  return undefined;
}

/**
 * Defensively parse the `models` block from afk.config.json. Each slot accepts
 * either a bare id string (`"small": "gpt-4o-mini"`) or an object
 * (`"small": { "id": "gpt-4o-mini", "name": "fast" }`). Malformed entries are
 * skipped rather than throwing — config parsing is best-effort.
 */
export function parseModelsConfig(raw: unknown): Partial<Record<SlotName, ModelSlotBinding>> {
  const out: Partial<Record<SlotName, ModelSlotBinding>> = {};
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const slot of SLOT_NAMES) {
    const binding = parseBinding(obj[slot]);
    if (binding) out[slot] = binding;
  }
  return out;
}

function normalizeSlotProvider(value: unknown): SlotProvider | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (lowered === 'anthropic' || lowered === 'anthropic-direct') return 'anthropic';
  if (lowered === 'openai' || lowered === 'openai-compatible') return 'openai';
  return undefined;
}

function parseStringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reject control characters (CRLF, NUL, tab, DEL, etc.) in binding string
 * fields — mirrors the env-var path's newline rejection in `coerceEnvValue`.
 * `parseStringField` itself stays lenient (it is shared with the loader path,
 * which intentionally ignores rather than throws on malformed input).
 */
function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(value);
}

/**
 * Names an agent-assigned binding `name` may not shadow — the built-in slot
 * keys, legacy tier aliases, the `auto` sentinel, and direct model aliases.
 * Without this check an agent could set `models.small.name = "large"` to route
 * an operator-typed "large" to the cheap tier.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...SLOT_NAMES,
  ...Object.keys(LEGACY_ALIAS_TO_SLOT),
  AUTO_SENTINEL,
  ...Object.keys(DIRECT_MODEL_ALIASES),
]);

function parseBinding(value: unknown): ModelSlotBinding | undefined {
  if (typeof value === 'string') {
    const id = value.trim();
    return id ? { id } : undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const id = parseStringField(obj['id']);
    if (!id) return undefined;
    const binding: ModelSlotBinding = { id };
    const name = parseStringField(obj['name']);
    if (name) binding.name = name;
    const provider = normalizeSlotProvider(obj['provider']);
    if (provider) binding.provider = provider;
    const baseUrl = parseStringField(obj['baseUrl']);
    if (baseUrl) binding.baseUrl = baseUrl;
    const apiKey = parseStringField(obj['apiKey']);
    if (apiKey) binding.apiKey = apiKey;
    return binding;
  }
  return undefined;
}

/**
 * Strict WRITER-path validation for a model-slot binding supplied to the config
 * mutation engine (config_set tool / `afk config set`). Unlike {@link parseBinding}
 * — which leniently ignores malformed fields when LOADING afk.config.json — this
 * surfaces actionable errors so a bad `config set models.large {...}` is rejected
 * rather than silently written.
 *
 * Rejects two credential-sensitivity fields from the plaintext-JSON agent-writable path:
 *   1. `apiKey` — a secret; belongs in afk.env via `afk config env set AFK_MODEL_<TIER>_API_KEY`.
 *   2. `baseUrl` — an endpoint redirect that carries the paired API key + the full
 *      conversation to wherever it points; belongs in afk.env via `afk config env set
 *      AFK_MODEL_<TIER>_BASE_URL` (human-gated, same rule as the `*_BASE_URL` suffix
 *      protection in {@link ../../config/settable-keys.ts}).
 *
 * Without these rejections an agent could silently rewrite runtime credentials or
 * endpoints into plaintext afk.config.json, bypassing the deliberately human-gated
 * env-var surface.
 *
 * Contract: {@link parseBinding} (the LOADER) still reads `baseUrl`/`apiKey` from
 * afk.config.json so hand-edited files and env-var overrides remain functional at
 * runtime — only the agent-writable WRITE path is gated.
 */
export function coerceSlotBindingInput(
  raw: unknown,
): { ok: true; value: ModelSlotBinding } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'model binding must be an object with at least an "id"' };
  }
  const obj = raw as Record<string, unknown>;
  if ('apiKey' in obj || 'api_key' in obj) {
    return {
      ok: false,
      error:
        'per-slot API keys are credentials; set AFK_MODEL_<TIER>_API_KEY via `afk config env set` instead of afk.config.json',
    };
  }
  if ('baseUrl' in obj || 'base_url' in obj) {
    return {
      ok: false,
      error:
        'per-slot baseUrl is an endpoint-redirect credential vector; set AFK_MODEL_<TIER>_BASE_URL via `afk config env set` instead of afk.config.json',
    };
  }
  const id = parseStringField(obj['id']);
  if (!id) return { ok: false, error: 'model binding requires a non-empty "id"' };
  if (hasControlChars(id)) {
    return { ok: false, error: 'model binding "id" must not contain control characters' };
  }
  const binding: ModelSlotBinding = { id };
  const name = parseStringField(obj['name']);
  if (name) {
    if (hasControlChars(name)) {
      return { ok: false, error: 'model binding "name" must not contain control characters' };
    }
    if (RESERVED_NAMES.has(name.trim().toLowerCase())) {
      return {
        ok: false,
        error: `model binding "name" must not shadow a built-in alias ("${name}")`,
      };
    }
    binding.name = name;
  }
  if (obj['provider'] !== undefined && obj['provider'] !== '') {
    const provider = normalizeSlotProvider(obj['provider']);
    if (!provider) {
      return {
        ok: false,
        error:
          'model binding "provider" must be one of: anthropic, openai (aliases: anthropic-direct, openai-compatible)',
      };
    }
    binding.provider = provider;
  }
  return { ok: true, value: binding };
}
