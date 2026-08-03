/**
 * TUI theme controller — resolves and applies the active color theme.
 *
 * The palette (./palette.ts) is a LIVE view over the active theme:
 * `applyTheme()` rewrites its member chalk instances in place, so every
 * module that already imports `palette` renders in the new tones on its
 * next paint with zero code changes. This controller lives in its own
 * module (not palette.ts) so palette.ts need not import syntax-highlight.ts
 * — that would form a palette → syntax-highlight → syntax-theme → palette
 * import cycle.
 *
 * Selection scopes (all optional; default is `dark` so existing users see
 * no change):
 *   - `theme` config key      (persistent)
 *   - `AFK_THEME` env var
 *   - `--theme <mode>` flag    (per-launch)
 *   - `/theme` slash command   (live, mid-session)
 *
 * Precedence for a single resolved value: flag > env > config > auto-detect
 * > dark. `auto` detects from the terminal's COLORFGBG hint and falls back
 * to dark.
 *
 * Invariant: theme name and background appearance are ONE axis here, not two.
 * `auto` therefore resolves only to `dark` or `light` (see
 * `AutoDetectableTheme`) — `umber` is dark-only and opt-in, so it can never
 * be auto-detected. If a future theme family ships both a light and a dark
 * variant, that is the point to split the axes (family × appearance) rather
 * than widening this union further.
 */

import { palette, darkPalette, lightPalette, umberPalette, type ThemePalette } from './palette.js';
import { clearHighlightCache } from './syntax-highlight.js';
import { env } from '../config/env.js';

/** A concrete, applicable theme. */
export type ThemeName = 'dark' | 'light' | 'umber';
/** A requested theme, including the `auto` sentinel that resolves at runtime. */
export type ThemeMode = ThemeName | 'auto';

/**
 * Themes that `auto` is allowed to resolve to. `umber` is deliberately
 * excluded: it is tuned for the Umber terminal's own warm-brown background
 * and has no light variant, so it can only ever be an explicit opt-in.
 * Auto-detection answers "is this background light or dark?" — a question
 * whose answer space is exactly these two.
 */
export type AutoDetectableTheme = 'dark' | 'light';

/**
 * Invariant: every `ThemeName` must have an entry here, or `applyTheme` would
 * silently fall through to dark. Keying the record by `ThemeName` makes a
 * missing theme a compile error rather than a runtime surprise.
 */
const THEME_PALETTES: Record<ThemeName, ThemePalette> = {
  dark: darkPalette,
  light: lightPalette,
  umber: umberPalette,
};

/** Every concrete theme name, for validators and help text. */
export const THEME_NAMES = Object.keys(THEME_PALETTES) as readonly ThemeName[];

let activeTheme: ThemeName = 'dark';

/** The theme currently applied to the live palette. */
export function getActiveTheme(): ThemeName {
  return activeTheme;
}

/**
 * Swap the live palette to `name` in place (preserving `palette`'s object
 * identity) and drop the syntax-highlight cache so fenced code blocks
 * re-highlight in the new tones. Idempotent.
 */
export function applyTheme(name: ThemeName): void {
  Object.assign(palette, THEME_PALETTES[name]);
  clearHighlightCache();
  activeTheme = name;
}

/**
 * Normalize a raw string (from env / flag / config) to a `ThemeMode`, or
 * `undefined` if absent or unrecognized. Case-insensitive; trims whitespace.
 */
export function parseThemeMode(raw: string | undefined | null): ThemeMode | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'auto') return v;
  return (THEME_NAMES as readonly string[]).includes(v) ? (v as ThemeName) : undefined;
}

/**
 * Detect whether the terminal has a light background from the COLORFGBG
 * hint (e.g. "15;0" or "0;default;15"). The trailing field is the
 * background color index; indices 7 and 9–15 are light, 0–6 and 8 are dark.
 * Absent or unparseable => dark (the safe default).
 *
 * Returns `AutoDetectableTheme`, not `ThemeName`: background detection can
 * only ever answer light-or-dark, so `umber` is unreachable here by type.
 */
export function detectTerminalTheme(): AutoDetectableTheme {
  const raw = env.COLORFGBG;
  if (!raw) return 'dark';
  const fields = raw.split(';');
  const bgField = fields[fields.length - 1]?.trim();
  if (!bgField) return 'dark';
  const bg = Number.parseInt(bgField, 10);
  if (!Number.isInteger(bg)) return 'dark';
  const isLight = bg === 7 || bg >= 9;
  return isLight ? 'light' : 'dark';
}

/**
 * Resolve a `ThemeMode` (or absence) to a concrete `ThemeName`. `auto`
 * detects from the terminal; anything absent/invalid falls back to `dark`.
 */
export function resolveTheme(mode: ThemeMode | undefined): ThemeName {
  if (mode === 'auto') return detectTerminalTheme();
  if (mode !== undefined) return mode;
  return 'dark';
}

/**
 * Commander validator for a `--theme` option — normalize a raw value to a
 * `ThemeMode` or throw on an unrecognized one (mirrors `--thinking-ui`).
 * Shared by the `interactive` and `chat` commands.
 */
export function parseThemeFlag(raw: string): ThemeMode {
  const mode = parseThemeMode(raw);
  if (mode !== undefined) return mode;
  throw new Error(`Invalid --theme value: ${raw}. Expected ${[...THEME_NAMES, 'auto'].join('|')}`);
}

/**
 * Resolve the requested theme MODE with precedence: `--theme` flag >
 * `AFK_THEME` env > config `theme` key. Each argument is an already-validated
 * `ThemeMode` (or undefined); the first present value wins, else undefined
 * (which `resolveTheme` maps to `dark`). This is the single precedence source
 * shared by every TTY-rendering surface so `interactive` and `chat` agree.
 */
export function resolveThemeMode(
  flag: ThemeMode | undefined,
  config: ThemeMode | undefined,
): ThemeMode | undefined {
  if (flag !== undefined) return flag;
  const envMode = parseThemeMode(env.AFK_THEME);
  if (envMode !== undefined) return envMode;
  return config;
}
