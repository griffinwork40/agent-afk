/**
 * Pure presentation model for the `/config` settings menu: categorisation,
 * value formatting, row labels, and per-key editor planning.
 *
 * Split out of config-menu.ts (which owns the async orchestrator + the real
 * adapters) to keep both files under the 350-LOC ceiling and to let these
 * helpers be unit-tested with no overlay, no session, and no disk.
 *
 * @module cli/render/config-menu-model
 */

import { palette } from '../palette.js';
import {
  coerceConfigValue,
  type ConfigKeySpec,
} from '../../config/settable-keys.js';

// ── Categorisation (pure) ───────────────────────────────────────────────────

/** Display order for categories. Any category not listed here is dropped. */
export const CATEGORY_ORDER = [
  'Model & routing',
  'Interactive',
  'Session',
  'Telegram',
  'Advanced',
] as const;

/**
 * Map a config key path to its menu category. Total over every path in
 * CONFIG_KEY_SPECS (asserted by a test) — a new spec that matches nothing here
 * lands in 'Session' rather than vanishing, but the test will flag it so the
 * author can place it deliberately.
 */
export function categoryOf(path: string): (typeof CATEGORY_ORDER)[number] {
  if (
    path === 'model' ||
    path.startsWith('models.') ||
    path === 'temperature' ||
    path === 'maxTokens' ||
    path.startsWith('autoRouting.')
  ) {
    return 'Model & routing';
  }
  if (path.startsWith('interactive.')) return 'Interactive';
  if (path.startsWith('telegram.')) return 'Telegram';
  if (path.startsWith('daemon.')) return 'Advanced';
  if (
    path === 'systemPrompt' ||
    path === 'permissionMode' ||
    path === 'enableShellHooks' ||
    path === 'enablePluginHooks' ||
    path === 'updatePolicy'
  ) {
    return 'Advanced';
  }
  return 'Session';
}

interface MenuCategory {
  name: (typeof CATEGORY_ORDER)[number];
  keys: readonly ConfigKeySpec[];
}

/** Group specs into ordered, non-empty categories. */
export function buildCategories(specs: readonly ConfigKeySpec[]): MenuCategory[] {
  const byCat = new Map<string, ConfigKeySpec[]>();
  for (const spec of specs) {
    const cat = categoryOf(spec.path);
    const bucket = byCat.get(cat);
    if (bucket) bucket.push(spec);
    else byCat.set(cat, [spec]);
  }
  const out: MenuCategory[] = [];
  for (const name of CATEGORY_ORDER) {
    const keys = byCat.get(name);
    if (keys && keys.length > 0) out.push({ name, keys });
  }
  return out;
}

// ── Value formatting + validation (pure) ─────────────────────────────────────

/** Render a persisted config value as a compact display string. */
export function formatValue(v: unknown): string {
  if (v === undefined) return '(unset)';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? '(empty)' : v.join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * One key row: `🔒 path            value  (type)  ← env AFK_MODEL`.
 *
 * `suffix` names the tier actually supplying the value when it is NOT the file
 * this menu writes to — without it, a key overridden by env or a project config
 * renders identically to one the menu controls, which is the misattribution this
 * row exists to prevent.
 */
export function keyRowLabel(
  spec: ConfigKeySpec,
  current: unknown,
  pad: number,
  suffix?: string,
): string {
  const lock = spec.tier === 'human' ? '🔒 ' : '   ';
  const tail = suffix ? `  ${palette.warning(suffix)}` : '';
  return `${lock}${spec.path.padEnd(pad)}  ${formatValue(current)}  (${spec.type})${tail}`;
}

/**
 * Editor shape for a key: a fixed-option picker (boolean/enum) or a free-text
 * overlay (everything else), with a help line describing the accepted input.
 */
type EditorPlan =
  | { kind: 'pick'; options: string[] }
  | { kind: 'text'; help: string };

export function editorFor(spec: ConfigKeySpec): EditorPlan {
  if (spec.type === 'boolean') return { kind: 'pick', options: ['true', 'false'] };
  if (spec.type === 'enum' && spec.enumValues && spec.enumValues.length > 0) {
    return { kind: 'pick', options: [...spec.enumValues] };
  }
  let help = 'enter to save · esc to cancel';
  if (spec.type === 'number' && spec.clamp) {
    const range = `[${spec.clamp.min}..${spec.clamp.max}]${spec.clamp.integer ? ' integer' : ''}`;
    help = `number ${range} · enter to save · esc to cancel`;
  } else if (spec.type === 'number') {
    help = 'number · enter to save · esc to cancel';
  } else if (spec.type === 'number-array') {
    help = 'comma-separated numbers · enter to save · esc to cancel';
  } else if (spec.type === 'model-slot') {
    help = 'model id (e.g. sonnet) · enter to save · esc to cancel';
  }
  return { kind: 'text', help };
}

/** A synchronous validator for the text overlay — wraps `coerceConfigValue`. */
export function makeValidator(spec: ConfigKeySpec): (raw: string) => string | null {
  return (raw: string): string | null => {
    const r = coerceConfigValue(spec, raw);
    return r.ok ? null : r.error;
  };
}
