/**
 * Per-model-slot operator deny list (`tools.disabledBySlot`).
 *
 * Shape (any afk.config.json tier; tiers are unioned like `tools.disabled`):
 *
 *   { "tools": { "disabledBySlot": { "local": ["browser", "peer", "schedules"] } } }
 *
 * Contract:
 *   - Keys are the four canonical slot names (`local`/`small`/`medium`/`large`).
 *     Entries use exactly the `tools.disabled` vocabulary and are expanded by
 *     the same {@link parseDisabledTools} (groups, MCP wildcards, LOCKED_TOOLS
 *     ignored with the same warning, unknown names warned and dropped).
 *   - The list applies when the ACTIVE model resolves to that slot: by tier
 *     name, custom slot `name`, or a raw id equal to the slot's bound `id`
 *     (same identity rule as `applySlotCredentials`). Fixed-identity aliases
 *     (`sonnet`, `opus`, ...) and unbound raw ids are not slots, so no slot list
 *     applies to them.
 *   - Absent key / no matching slot => `[]` => byte-identical to the
 *     pre-feature behaviour (the global `tools.disabled` still applies).
 *   - Enforcement is NOT implemented here. The resolved names are unioned into
 *     `deniedTools` by `composeDispatcherPermissions` (built-in dispatcher) and
 *     by `withOperatorDeniedDispatcher` (consumer-owned dispatcher), which are
 *     the same paths that already hide schemas AND block execution for
 *     `tools.disabled`, so advertised and executable tools cannot drift.
 *
 * @module agent/tools/operator-denied.slots
 */

import { existsSync, readFileSync } from 'node:fs';
import { jsonConfigTierPaths } from '../../cli/config/json-tier-paths.js';
import { getSlotBindings, resolveBinding, SLOT_NAMES, type SlotName } from '../session/model-slots.js';
import { parseDisabledTools } from './operator-denied.js';

/** Raw `tools.disabledBySlot` object of one parsed config file, if any. */
function rawBySlot(json: unknown): Record<string, unknown> | undefined {
  if (json === null || typeof json !== 'object') return undefined;
  const tools = (json as { tools?: unknown }).tools;
  if (tools === null || typeof tools !== 'object') return undefined;
  const bySlot = (tools as { disabledBySlot?: unknown }).disabledBySlot;
  if (bySlot === null || typeof bySlot !== 'object' || Array.isArray(bySlot)) return undefined;
  return bySlot as Record<string, unknown>;
}

/** The configured slot `model` resolves to, or undefined (raw id / fixed alias / auto). */
export function slotForActiveModel(model: unknown): SlotName | undefined {
  if (typeof model !== 'string' || model.trim() === '') return undefined;
  const table = getSlotBindings();
  const binding = resolveBinding(model, table);
  // resolveBinding returns the live slot object by reference for every
  // slot-matched input; passthroughs are fresh objects and never match.
  return SLOT_NAMES.find((s) => table[s] === binding);
}

/** Per-tier raw entries for `slot`, in tier order. Unreadable tiers are skipped. */
function tierEntries(slot: SlotName): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = [];
  for (const { path } of jsonConfigTierPaths()) {
    if (!existsSync(path)) continue;
    try {
      const bySlot = rawBySlot(JSON.parse(readFileSync(path, 'utf8')));
      if (bySlot && Object.hasOwn(bySlot, slot)) out.push({ path, value: bySlot[slot] });
    } catch {
      // Malformed JSON is already reported by the global tools.disabled resolver.
    }
  }
  return out;
}

/**
 * Expanded deny list for the slot `model` resolves to (union of all tiers).
 * Returns `[]` when the model is not a configured slot or no tier lists it.
 */
export function resolveSlotDeniedTools(model: unknown, customNames: readonly string[] = []): string[] {
  const slot = slotForActiveModel(model);
  if (!slot) return [];
  const denied = new Set<string>();
  for (const { path, value } of tierEntries(slot)) {
    for (const name of parseDisabledTools(value, `${path} (tools.disabledBySlot.${slot})`, customNames)) denied.add(name);
  }
  return [...denied];
}

/**
 * Cheap, warning-free identity of the slot list that applies to `model`, for
 * the ProviderRouter's rebuild signature: two models whose key differs must
 * not share one live inner (its dispatcher froze the old list).
 */
export function slotDenyKey(model: unknown): string {
  const slot = slotForActiveModel(model);
  if (!slot) return '';
  const raw = tierEntries(slot).map((t) => JSON.stringify(t.value));
  return raw.length > 0 ? `${slot}:${raw.join('|')}` : '';
}
