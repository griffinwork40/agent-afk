/**
 * Model selector widget and model badge for the `afk web` UI.
 *
 * Invariant: NOTHING here uses innerHTML. All DOM mutations go through
 * createElement / textContent / className — the same discipline as render.ts.
 *
 * Two exports:
 *   createModelSelector — a styled <select> wrapped in a host element, used
 *     inside the new-session form or any other context that needs to pick a
 *     model before dispatch.
 *   renderModelBadge — a small pill showing the model tier, colour-coded for
 *     quick scanning in the session sidebar.
 */

// ---- types ------------------------------------------------------------------

/** One entry from GET /api/models. */
export interface ModelInfo {
  id: string;
  label: string;
}

/** Options for {@link createModelSelector}. */
export interface ModelSelectorOpts {
  /** Called with the chosen model id whenever the selection changes. */
  onSelect: (modelId: string) => void;
  /** Initially selected model id. Defaults to 'sonnet'. */
  current?: string;
}

// ---- constants --------------------------------------------------------------

// Contract: these are the fallback options used when the caller has not yet
// fetched /api/models, so the selector is usable synchronously. They match
// the static list on the backend (routes.models.ts) and are ordered
// Sonnet first because it is the recommended default.
const DEFAULT_MODELS: readonly ModelInfo[] = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
];

const DEFAULT_MODEL_ID = 'sonnet';

// ---- badge colour map -------------------------------------------------------

// Contract: every tier maps to exactly one CSS class from model-selector.css.
// Unknown tiers fall back to 'model-badge--default' so the badge never
// renders without a class, which would leave it unstyled.
const BADGE_CLASS_MAP: Readonly<Record<string, string>> = {
  opus:   'model-badge--opus',
  sonnet: 'model-badge--sonnet',
  haiku:  'model-badge--haiku',
};

function badgeModifierClass(modelId: string): string {
  // Normalise to lower-case bare tier name: 'claude-3-5-sonnet-…' -> 'sonnet'
  const lower = modelId.toLowerCase();
  for (const key of Object.keys(BADGE_CLASS_MAP)) {
    if (lower.includes(key)) return BADGE_CLASS_MAP[key] ?? 'model-badge--default';
  }
  return 'model-badge--default';
}

// ---- public API -------------------------------------------------------------

/**
 * Build a self-contained model selector widget.
 *
 * Returns a host `<div class="model-selector">` containing a `<select>`.
 * The host element is the value to append into the form; the caller does not
 * need to reach inside it.
 *
 * @example
 * ```ts
 * const widget = createModelSelector({ onSelect: (id) => { selectedModel = id; } });
 * form.appendChild(widget);
 * ```
 */
export function createModelSelector(
  opts: ModelSelectorOpts,
  models: readonly ModelInfo[] = DEFAULT_MODELS,
): HTMLElement {
  const host = document.createElement('div');
  host.className = 'model-selector';

  const label = document.createElement('label');
  label.className = 'model-selector__label';
  label.textContent = 'Model';

  const select = document.createElement('select');
  select.className = 'model-selector__select';
  select.setAttribute('aria-label', 'Model');

  const current = opts.current ?? DEFAULT_MODEL_ID;

  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === current) opt.selected = true;
    select.appendChild(opt);
  }

  // Invariant: fire immediately on construction so the parent always has a
  // valid model id without needing to read select.value directly.
  opts.onSelect(select.value);

  select.addEventListener('change', () => {
    opts.onSelect(select.value);
  });

  label.appendChild(select);
  host.appendChild(label);
  return host;
}

/**
 * Render a small coloured pill badge showing the model tier.
 *
 * Colour coding:
 *   opus   → accent (orange)
 *   sonnet → success (green)
 *   haiku  → text-dim (grey)
 *
 * The badge degrades gracefully for unknown model strings: it renders the
 * label in the default (text-dim) style rather than throwing or rendering
 * blank.
 *
 * @example
 * ```ts
 * const badge = renderModelBadge('sonnet');
 * sessionMeta.appendChild(badge);
 * ```
 */
export function renderModelBadge(model: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = `model-badge ${badgeModifierClass(model)}`;
  // Show the shortest recognisable tier name, not the full model string, so
  // the badge fits the narrow sidebar without truncation.
  badge.textContent = shortLabel(model);
  return badge;
}

// ---- helpers ----------------------------------------------------------------

/**
 * Derive a short display label from a model id.
 *
 * 'claude-3-5-sonnet-20241022' -> 'sonnet'
 * 'sonnet'                      -> 'sonnet'
 * 'my-custom-model'             -> 'my-custom-model' (pass-through, capped)
 */
function shortLabel(modelId: string): string {
  const lower = modelId.toLowerCase();
  for (const key of ['opus', 'sonnet', 'haiku']) {
    if (lower.includes(key)) return key;
  }
  // Unknown: show the raw id but cap it so it cannot overflow the badge.
  return modelId.length > 12 ? `${modelId.slice(0, 12)}…` : modelId;
}
