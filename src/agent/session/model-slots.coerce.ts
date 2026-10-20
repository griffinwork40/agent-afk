/**
 * Writer-path validation for model-slot bindings supplied to the config
 * mutation engine (config_set tool / `afk config set`).
 *
 * Extracted from `model-slots.ts` to keep that file within the 350-code-line
 * ceiling. Import from `model-slots.ts` — it re-exports `coerceSlotBindingInput`
 * so existing call sites need no path change.
 *
 * @module agent/session/model-slots.coerce
 */

import {
  SLOT_NAMES,
  AUTO_SENTINEL,
  DIRECT_MODEL_ALIASES,
  MAX_CONTEXT_WINDOW_OVERRIDE,
} from './model-slots.js';
import type { ModelSlotBinding } from './model-slots.js';
import { normalizeSlotProvider, parseStringField } from './model-slots.utils.js';

function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(value);
}

// Lazily built on first use to avoid the circular-init issue: model-slots.coerce
// is imported by model-slots.ts before SLOT_NAMES / DIRECT_MODEL_ALIASES have
// finished initialising (ES module evaluation order). Using a getter defers the
// Set construction until the first coerceSlotBindingInput call, by which point
// the circular initialisation is complete.
let _reservedNames: ReadonlySet<string> | undefined;
function getReservedNames(): ReadonlySet<string> {
  if (!_reservedNames) {
    _reservedNames = new Set([
      ...SLOT_NAMES,
      AUTO_SENTINEL,
      ...Object.keys(DIRECT_MODEL_ALIASES),
    ]);
  }
  return _reservedNames;
}

/** Shared coerce helper for positive-integer binding fields (contextWindow, maxOutputTokens). */
function coercePositiveIntField(
  obj: Record<string, unknown>,
  field: 'contextWindow' | 'maxOutputTokens',
  binding: ModelSlotBinding,
): string | undefined {
  const val = obj[field];
  if (val === undefined || val === '') return undefined;
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_CONTEXT_WINDOW_OVERRIDE) {
    return `model binding "${field}" must be a positive integer ≤ ${MAX_CONTEXT_WINDOW_OVERRIDE.toLocaleString()} (got ${JSON.stringify(val)})`;
  }
  binding[field] = n;
  return undefined;
}

/**
 * Strict WRITER-path validation for a model-slot binding supplied to the config
 * mutation engine (config_set tool / `afk config set`). Unlike the loader's
 * `parseBinding` — which leniently ignores malformed fields when LOADING
 * afk.config.json — this surfaces actionable errors so a bad
 * `config set models.large {...}` is rejected rather than silently written.
 *
 * Rejects two credential-sensitivity fields from the plaintext-JSON
 * agent-writable path:
 *   1. `apiKey` — a secret; belongs in afk.env via
 *      `afk config env set AFK_MODEL_<TIER>_API_KEY`.
 *   2. `baseUrl` — an endpoint redirect that carries the paired API key + the
 *      full conversation to wherever it points; belongs in afk.env via
 *      `afk config env set AFK_MODEL_<TIER>_BASE_URL` (human-gated, same rule
 *      as the `*_BASE_URL` suffix protection in
 *      {@link ../../config/settable-keys.ts}).
 *
 * Without these rejections an agent could silently rewrite runtime credentials
 * or endpoints into plaintext afk.config.json, bypassing the deliberately
 * human-gated env-var surface.
 *
 * Contract: `parseBinding` (the LOADER) still reads `baseUrl`/`apiKey` from
 * afk.config.json so hand-edited files and env-var overrides remain functional
 * at runtime — only the agent-writable WRITE path is gated.
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
    if (getReservedNames().has(name.trim().toLowerCase())) {
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
  for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
    const err = coercePositiveIntField(obj, field, binding);
    if (err) return { ok: false, error: err };
  }
  // Cross-check: maxOutputTokens must not exceed contextWindow when both are set.
  // An oversized cap passes config validation but causes the provider to 400.
  if (binding.contextWindow !== undefined && binding.maxOutputTokens !== undefined
    && binding.maxOutputTokens > binding.contextWindow) {
    return {
      ok: false,
      error: `model binding "maxOutputTokens" (${binding.maxOutputTokens.toLocaleString()}) must not exceed "contextWindow" (${binding.contextWindow.toLocaleString()})`,
    };
  }
  return { ok: true, value: binding };
}
