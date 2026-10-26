/**
 * Shared model-catalog grouping helper.
 *
 * Produces a deduplicated, provider-grouped catalogue from the slot bindings
 * and model-alias hints. Both GET /api/models and the /model picker options
 * use this helper so both surfaces always agree on order, deduplication, and
 * human labels.
 *
 * Resolution rules (in priority order):
 *   1. Each alias from MODEL_ALIASES_HINT is resolved to its concrete model id.
 *   2. Aliases that resolve to the same concrete id as a previous entry are
 *      collected as aliases of that canonical row (no duplicate rows).
 *   3. The `_1m` variants of a model are surfaced as a sibling alias chip on
 *      the same row, not as a separate row.
 *   4. Rows are grouped by provider: Anthropic → OpenAI → xAI → Local.
 *
 * @module web-server/model-catalog-groups
 */

import {
  getSlotBindings,
  resolveModelInput,
  SLOT_NAMES,
  MODEL_ALIASES_HINT,
} from '../agent/session/model-slots.js';
import { loadConfig } from '../cli/config.js';

// ── types ──────────────────────────────────────────────────────────────────

export type ModelProvider = 'anthropic' | 'openai' | 'xai' | 'local';

export interface ModelRow {
  /** The primary alias the user should send (e.g. "sonnet", "haiku"). */
  id: string;
  /** Human-readable name, e.g. "Claude Sonnet 4.6". */
  name: string;
  /** All aliases that resolve to the same concrete model id (incl. id itself). */
  aliases: string[];
  /** Concrete resolved model id, e.g. "claude-sonnet-4-6-20251120". */
  resolvedId: string;
  /** Whether a 1M-context variant is available as an alias chip. */
  has1m: boolean;
  provider: ModelProvider;
}

export interface ModelGroup {
  label: string;
  rows: ModelRow[];
}

// ── helpers ─────────────────────────────────────────────────────────────────

function detectProvider(id: string): ModelProvider {
  const lower = id.toLowerCase();
  if (lower.startsWith('claude-') || lower === 'anthropic') return 'anthropic';
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') ||
      lower.startsWith('o4') || lower.startsWith('codex-')) return 'openai';
  if (lower.startsWith('grok')) return 'xai';
  return 'local';
}

function slotToProvider(slotId: string): ModelProvider {
  const resolved = resolveModelInput(slotId);
  return resolved ? detectProvider(resolved) : 'local';
}

/** Build a human-friendly display name from a resolved concrete model id. */
export function modelDisplayName(resolvedId: string): string {
  // Claude: claude-haiku-5-5 → "Claude Haiku 5.5", claude-sonnet-4-6 → "Claude Sonnet 4.6"
  const claude = /^claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d+))?/.exec(resolvedId);
  if (claude) {
    const tier = claude[1]![0]!.toUpperCase() + claude[1]!.slice(1);
    const major = claude[2]!;
    const minor = claude[3] ? `.${claude[3]}` : '';
    return `Claude ${tier} ${major}${minor}`;
  }
  // GPT: gpt-6.1-sol → "GPT 6.1 Sol", gpt-5.5 → "GPT 5.5"
  const gpt = /^gpt-(.+)$/.exec(resolvedId);
  if (gpt) {
    const parts = gpt[1]!.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1));
    return `GPT ${parts.join(' ')}`;
  }
  // grok-4.5 → "Grok 4.5"  (keep wire id in name so label includes "grok-...")
  const grok = /^grok-(.+)$/.exec(resolvedId);
  if (grok) return `Grok ${grok[1]} (${resolvedId})`;
  // fallback: title-case the id
  return resolvedId;
}

// ── main export ──────────────────────────────────────────────────────────────

const PROVIDER_ORDER: ModelProvider[] = ['anthropic', 'openai', 'xai', 'local'];
const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  local: 'Local',
};

/**
 * Build the full grouped model catalogue.
 *
 * @param defaultModel - The server's launch model (used as the canonical
 *   "current" marker by the picker; not mutated here).
 */
export function buildModelGroups(defaultModel?: string): ModelGroup[] {
  const selected = defaultModel ?? String(loadConfig().model);
  const bindings = getSlotBindings();

  // Collect all candidate alias ids in display order.
  const candidateIds = new Set<string>([
    selected,
    'sonnet', 'haiku', 'opus',
    ...MODEL_ALIASES_HINT.filter((id) => !SLOT_NAMES.includes(id as typeof SLOT_NAMES[number])),
    ...SLOT_NAMES.filter((slot) => bindings[slot].id.length > 0),
    ...Object.values(bindings).flatMap((b) => (b.name ? [b.name] : [])),
  ]);

  // Map: resolvedId → ModelRow (dedup by concrete id).
  const byResolved = new Map<string, ModelRow>();
  // Map: alias → resolvedId (for grouping _1m variants).
  const aliasToResolved = new Map<string, string>();

  for (const alias of candidateIds) {
    // Strip _1m suffix to find the base alias.
    const isOneMContext = alias.endsWith('_1m');
    const baseAlias = isOneMContext ? alias.slice(0, -3) : alias;

    const resolved = resolveModelInput(alias) ?? alias;
    // For _1m, the "base" resolved id is without the 1m suffix.
    const baseResolved = resolveModelInput(baseAlias) ?? baseAlias;

    if (isOneMContext) {
      // Attach as a has1m flag on the base row if it exists.
      if (byResolved.has(baseResolved)) {
        byResolved.get(baseResolved)!.has1m = true;
        byResolved.get(baseResolved)!.aliases.push(alias);
      }
      aliasToResolved.set(alias, baseResolved);
      continue;
    }

    if (byResolved.has(resolved)) {
      // Duplicate: add alias to existing row.
      const row = byResolved.get(resolved)!;
      if (!row.aliases.includes(alias)) row.aliases.push(alias);
      aliasToResolved.set(alias, resolved);
      continue;
    }

    const provider = SLOT_NAMES.includes(alias as typeof SLOT_NAMES[number])
      ? slotToProvider(alias)
      : detectProvider(resolved);

    const row: ModelRow = {
      id: alias,
      name: modelDisplayName(resolved),
      aliases: [alias],
      resolvedId: resolved,
      has1m: false,
      provider,
    };
    byResolved.set(resolved, row);
    aliasToResolved.set(alias, resolved);
  }

  // Group rows by provider.
  const grouped = new Map<ModelProvider, ModelRow[]>();
  for (const p of PROVIDER_ORDER) grouped.set(p, []);
  for (const row of byResolved.values()) {
    grouped.get(row.provider)!.push(row);
  }

  return PROVIDER_ORDER
    .filter((p) => (grouped.get(p)?.length ?? 0) > 0)
    .map((p) => ({ label: PROVIDER_LABEL[p], rows: grouped.get(p)! }));
}

/**
 * Flat list of {id, label} for the legacy ModelInfo API shape.
 * `id` is the primary alias; `label` is "alias · Human Name".
 */
export function buildFlatModelList(defaultModel?: string): Array<{ id: string; label: string }> {
  const groups = buildModelGroups(defaultModel);
  const out: Array<{ id: string; label: string }> = [];
  for (const group of groups) {
    for (const row of group.rows) {
      const resolved = resolveModelInput(row.id) ?? row.id;
      const display = row.id === resolved ? row.name : `${row.id} · ${row.name}`;
      out.push({ id: row.id, label: display });
      // Also expose _1m alias if present.
      if (row.has1m) {
        out.push({ id: `${row.id}_1m`, label: `${row.id}_1m · ${row.name} (1M context)` });
      }
    }
  }
  return out;
}
