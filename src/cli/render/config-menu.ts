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
 * Value semantics: writes go through `setConfigValue`, which persists to the
 * user-global afk.config.json. That store is CACHED AT LOAD, so by default the
 * running session is unchanged until restart (mutate.ts:19-21) and the write
 * echoes `RESTART_NOTE`. Two refinements sit on top:
 *   - Liveness (config/live-apply.ts): a small allowlist of keys whose live path
 *     is already proven by a shipped slash command (`model` → `/model`, `theme`
 *     → `/theme`) is pushed into the running session and reports "applied to
 *     this session" instead. Everything else keeps the restart note verbatim.
 *   - Provenance (config/provenance.ts): rows show the value the LOADER will
 *     use, which is not always the value in the file we write — env and a
 *     project-local afk.config.json both outrank it. When a higher tier wins,
 *     the row names it and the editor warns before and after the write, because
 *     a silently-inert save is the worst outcome this menu can produce.
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
import { CONFIG_KEY_SPECS, type ConfigKeySpec } from '../../config/settable-keys.js';
import {
  buildCategories,
  editorFor,
  formatValue,
  keyRowLabel,
  makeValidator,
} from './config-menu-model.js';
import { setConfigValue, getConfigValue, RESTART_NOTE } from '../../config/mutate.js';
import {
  resolveConfigProvenance,
  sourceSuffix,
  shadowNote,
  type ConfigProvenance,
} from '../config/provenance.js';
import { applyConfigLive, type LiveApplyHandle, type LiveApplyOutcome } from '../config/live-apply.js';

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
  /**
   * Effective value + originating tier. Optional: surfaces that omit it get the
   * pre-provenance rendering (persisted value only, no tier annotation).
   */
  provenance?(path: string): ConfigProvenance;
  /**
   * Push an already-persisted write into the running session. Optional: absent
   * on surfaces with no live session, where every write stays restart-scoped.
   */
  applyLive?(path: string, rawValue: string): Promise<LiveApplyOutcome>;
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
        cat.keys.map((k) => {
          // Invariant: `io.current` must be called for EVERY row even when
          // provenance supersedes its value. It is the only read that throws
          // MalformedConfigError on a broken write-target file, and the caller
          // (config-doctor.ts) relies on that throw to degrade to the read-only
          // view. Provenance deliberately tolerates unparseable files (it mirrors
          // the loader's fall-through), so dropping this call silently opens a
          // menu whose every write would fail.
          const persisted = io.current(k.path);
          const prov = io.provenance?.(k.path);
          // Show the value the loader will actually use, not the file value —
          // they differ exactly when a higher tier shadows this key.
          const shown = prov ? prov.effective : persisted;
          return keyRowLabel(k, shown, pad, prov ? sourceSuffix(prov) : undefined);
        }),
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
  const prov = io.provenance?.(spec.path);
  const shadow = prov ? shadowNote(prov) : undefined;
  const header = [
    palette.bold(`${TITLE} › ${spec.path}`),
    palette.dim(spec.description),
    palette.dim(`current: ${formatValue(prov ? prov.effective : current)}`),
    // Warn BEFORE the edit, not only after the write — a user who learns their
    // change is inert only after saving has already wasted the round trip.
    ...(shadow ? [palette.warning(`⚠ ${shadow}`)] : []),
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
    // Persistence succeeded. Liveness is reported separately and never
    // downgrades the write: a failed live-apply still leaves a saved value.
    const live = await io.applyLive?.(spec.path, rawValue);
    const note = live?.applied === true ? live.note : RESTART_NOTE;
    ov.emit(`${palette.success('  ✓')} ${spec.path} = ${palette.bold(display)}  ${palette.dim(`— ${note}`)}`);
    if (live && live.applied === false && live.reason !== undefined) {
      ov.emit(`${palette.warning('  ⚠')} ${palette.dim(`saved, but not applied live: ${live.reason}`)}`);
    }
    if (shadow) ov.emit(`${palette.warning('  ⚠')} ${palette.dim(shadow)}`);
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

/**
 * Real io backed by the config-mutation engine.
 *
 * `handle` is the running session's live-apply capability; omit it on surfaces
 * without one (tests, non-TTY) and every write stays restart-scoped.
 */
export function defaultIo(handle?: LiveApplyHandle): MenuIo {
  return {
    specs: () => CONFIG_KEY_SPECS,
    current: (path) => getConfigValue(path).value,
    write: (path, rawValue, allowHuman) =>
      String(setConfigValue(path, rawValue, allowHuman ? { allowHumanOnly: true } : undefined).value),
    provenance: (path) => resolveConfigProvenance(path),
    applyLive: (path, rawValue) => applyConfigLive(path, rawValue, handle),
  };
}
