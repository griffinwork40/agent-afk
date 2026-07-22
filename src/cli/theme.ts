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
 */

import { palette, darkPalette, lightPalette } from './palette.js';
import { clearHighlightCache } from './syntax-highlight.js';
import { env } from '../config/env.js';

/** A concrete, applicable theme. */
export type ThemeName = 'dark' | 'light';
/** A requested theme, including the `auto` sentinel that resolves at runtime. */
export type ThemeMode = ThemeName | 'auto';

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
  Object.assign(palette, name === 'light' ? lightPalette : darkPalette);
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
  if (v === 'dark' || v === 'light' || v === 'auto') return v;
  return undefined;
}

/**
 * Detect whether the terminal has a light background from the COLORFGBG
 * hint (e.g. "15;0" or "0;default;15"). The trailing field is the
 * background color index; indices 7 and 9–15 are light, 0–6 and 8 are dark.
 * Absent or unparseable => dark (the safe default).
 */
export function detectTerminalTheme(): ThemeName {
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
  if (mode === 'dark' || mode === 'light') return mode;
  if (mode === 'auto') return detectTerminalTheme();
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
  throw new Error(`Invalid --theme value: ${raw}. Expected dark|light|auto`);
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
