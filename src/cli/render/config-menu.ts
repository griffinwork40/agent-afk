/**
 * Interactive settings menu for `/config` — a navigable editor over
 * {@link CONFIG_KEY_SPECS}, composed from the existing overlay primitives
 * (`runPicker` + `runTextInput`) rather than a new TUI framework.
 *
 * Design (see `.afk/plans/app-like-tui-config-menu.md`):
 *   - This is a THIRD consumer of `TerminalCompositor.enterPickerMode`, joining
 *     `runPicker` and `runTextInput`. It never touches raw mode / stdin itself
 *     (single-consumer-stdin invariant — see render/picker.ts header, PR #511).
 *   - Overlays are driven by SEQUENTIAL `await`s (category → key → value), never
 *     nested, so the single-overlay guard (terminal-compositor.input-mode.ts:95)
 *     always holds — each overlay `exitPickerMode`s before the next enters.
 *
 * Value semantics: writes go through `setConfigValue`, which persists to
 * afk.config.json but is CACHED AT LOAD — the running session is unchanged until
 * restart (mutate.ts:19-21). Every write echoes `RESTART_NOTE` so the user is
 * never surprised.
 *
 * Security: config keys are only tier 'agent' | 'human' — never `secret` (secrets
 * are env-only). So editing config keys in-REPL cannot leak a credential.
 * Human-tier keys require an explicit in-menu confirm before writing (mirrors the
 * `afk config set --allow` gate); `/config` is a human surface (the agent cannot
 * type slash commands), so this does not widen the `config_set` agent-tool path.
 * Env-var editing (which involves secret masking) is deliberately OUT of the
 * interactive menu — it stays on `afk config env set` and the read-only dump.
 *
 * Testability: all overlay + io effects are injected via {@link MenuOverlays} /
 * {@link MenuIo}, so the orchestrator is unit-tested with scripted fakes and no
 * real compositor or disk. `overlaysFromCompositor` / `defaultIo` wire the real
 * implementations for the slash handler.
 */

import { palette } from '../palette.js';
import { runPicker } from './picker.js';
import { runTextInput } from './text-input.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import {
  CONFIG_KEY_SPECS,
  coerceConfigValue,
  type ConfigKeySpec,
} from '../../config/settable-keys.js';
import { setConfigValue, getConfigValue, RESTART_NOTE } from '../../config/mutate.js';

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

/** One key row: `🔒 path            value  (type)` — lock glyph on human-tier keys. */
export function keyRowLabel(spec: ConfigKeySpec, current: unknown, pad: number): string {
  const lock = spec.tier === 'human' ? '🔒 ' : '   ';
  return `${lock}${spec.path.padEnd(pad)}  ${formatValue(current)}  (${spec.type})`;
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

// ── Injected effects (for testability) ───────────────────────────────────────

export interface MenuOverlays {
  /** Show a single-select picker; resolve with the chosen index, or null on Esc. */
  pick(header: readonly string[], options: readonly string[]): Promise<number | null>;
  /** Show a text editor; resolve with the typed string, or null on Esc. */
  editText(
    header: readonly string[],
    initial: string,
    help: string,
    validate: (v: string) => string | null,
  ): Promise<string | null>;
  /** Write a durable line to scrollback (above the input region). */
  emit(line: string): void;
}

export interface MenuIo {
  specs(): readonly ConfigKeySpec[];
  /** Current persisted value for a key (undefined when unset). */
  current(path: string): unknown;
  /** Persist a value; return the display form of what was written, or throw. */
  write(path: string, rawValue: string, allowHuman: boolean): string;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

const TITLE = '⚙  Settings';

/**
 * Run the interactive settings menu to completion. Returns when the user closes
 * the top-level category picker (Esc). Never throws — write failures are echoed
 * and the menu continues.
 */
export async function runConfigMenu(ov: MenuOverlays, io: MenuIo): Promise<void> {
  const cats = buildCategories(io.specs());
  if (cats.length === 0) return;

  // Category level.
  for (;;) {
    const catHeader = [
      palette.bold(TITLE),
      palette.dim('Changes apply on the next restart'),
      '',
    ];
    const ci = await ov.pick(
      catHeader,
      cats.map((c) => `${c.name}  ·  ${c.keys.length} setting${c.keys.length === 1 ? '' : 's'}`),
    );
    if (ci === null) return; // Esc closes the menu
    const cat = cats[ci];
    if (!cat) return;

    // Key level.
    const pad = Math.min(28, Math.max(...cat.keys.map((k) => k.path.length)));
    for (;;) {
      const keyHeader = [palette.bold(`${TITLE} › ${cat.name}`), ''];
      const ki = await ov.pick(
        keyHeader,
        cat.keys.map((k) => keyRowLabel(k, io.current(k.path), pad)),
      );
      if (ki === null) break; // Esc → back to categories
      const spec = cat.keys[ki];
      if (!spec) break;
      await editKey(ov, io, spec);
    }
  }
}

async function editKey(ov: MenuOverlays, io: MenuIo, spec: ConfigKeySpec): Promise<void> {
  const current = io.current(spec.path);
  const header = [
    palette.bold(`${TITLE} › ${spec.path}`),
    palette.dim(spec.description),
    palette.dim(`current: ${formatValue(current)}`),
    '',
  ];
  const plan = editorFor(spec);

  let rawValue: string;
  if (plan.kind === 'pick') {
    const idx = await ov.pick(header, plan.options);
    if (idx === null) return; // Esc → back to key list
    const picked = plan.options[idx];
    if (picked === undefined) return;
    rawValue = picked;
  } else {
    const initial = current === undefined ? '' : formatValue(current);
    const typed = await ov.editText(header, initial, plan.help, makeValidator(spec));
    if (typed === null) return; // Esc / cancel → back to key list
    rawValue = typed;
  }

  // Human-tier keys are CLI-gated; require an explicit confirm on this human
  // surface before opting past the gate.
  let allowHuman = false;
  if (spec.tier === 'human') {
    const confirmIdx = await ov.pick(
      [
        palette.warning(`Apply human-tier change to ${spec.path}?`),
        palette.dim('This setting is normally changed via `afk config` on the CLI.'),
        '',
      ],
      [`Yes — set to "${rawValue}"`, 'No — cancel'],
    );
    if (confirmIdx !== 0) return; // No / Esc → abandon
    allowHuman = true;
  }

  try {
    const display = io.write(spec.path, rawValue, allowHuman);
    ov.emit(`${palette.success('  ✓')} ${spec.path} = ${palette.bold(display)}  ${palette.dim(`— ${RESTART_NOTE}`)}`);
  } catch (err) {
    ov.emit(`${palette.error('  ✗')} ${palette.error(err instanceof Error ? err.message : String(err))}`);
  }
}

// ── Real adapters ────────────────────────────────────────────────────────────

/** Bind the overlay primitives to a live compositor (the slash-handler path). */
export function overlaysFromCompositor(c: TerminalCompositor): MenuOverlays {
  return {
    async pick(header, options) {
      const result = await runPicker(c, { header, options });
      if (!result || result.length === 0) return null;
      const idx = options.indexOf(result[0]!);
      return idx >= 0 ? idx : null;
    },
    async editText(header, initial, help, validate) {
      return runTextInput(c, { header, initial, help, validate });
    },
    emit(line) {
      c.commitAbove(line);
    },
  };
}

/** Real io backed by the config-mutation engine. */
export function defaultIo(): MenuIo {
  return {
    specs: () => CONFIG_KEY_SPECS,
    current: (path) => getConfigValue(path).value,
    write: (path, rawValue, allowHuman) =>
      String(setConfigValue(path, rawValue, allowHuman ? { allowHumanOnly: true } : undefined).value),
  };
}
