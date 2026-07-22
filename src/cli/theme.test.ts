/**
 * Tests for src/cli/theme.ts + the theme-swap behavior of src/cli/palette.ts.
 *
 * Covers: mode parsing/validation, COLORFGBG auto-detection, precedence
 * (flag > env > config), the live palette swap (identity preserved, chained
 * modifiers survive, dark restores), the NO_COLOR invariant (chalk.level = 0
 * strips a light theme too), and dark/light role-set parity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { palette, darkPalette, lightPalette, type ThemePalette } from './palette.js';
import {
  applyTheme,
  getActiveTheme,
  parseThemeMode,
  parseThemeFlag,
  detectTerminalTheme,
  resolveTheme,
  resolveThemeMode,
} from './theme.js';

// Save/restore the global mutable state the theme layer touches.
let savedLevel: typeof chalk.level;
const ENV_KEYS = ['COLORFGBG', 'AFK_THEME'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedLevel = chalk.level;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  chalk.level = savedLevel;
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  applyTheme('dark'); // reset the live palette so cases never bleed into each other
});

describe('parseThemeMode', () => {
  it('accepts dark|light|auto, case-insensitive and trimmed', () => {
    expect(parseThemeMode('dark')).toBe('dark');
    expect(parseThemeMode('LIGHT')).toBe('light');
    expect(parseThemeMode('  Auto ')).toBe('auto');
  });
  it('returns undefined for absent or unrecognized values', () => {
    expect(parseThemeMode(undefined)).toBeUndefined();
    expect(parseThemeMode(null)).toBeUndefined();
    expect(parseThemeMode('')).toBeUndefined();
    expect(parseThemeMode('solarized')).toBeUndefined();
  });
});

describe('parseThemeFlag', () => {
  it('normalizes a valid value', () => {
    expect(parseThemeFlag('light')).toBe('light');
  });
  it('throws on an invalid value so commander surfaces the error', () => {
    expect(() => parseThemeFlag('nope')).toThrow(/Invalid --theme/);
  });
});

describe('detectTerminalTheme (COLORFGBG)', () => {
  it('light background indices (7, 9-15) => light', () => {
    process.env['COLORFGBG'] = '0;15';
    expect(detectTerminalTheme()).toBe('light');
    process.env['COLORFGBG'] = '0;7';
    expect(detectTerminalTheme()).toBe('light');
  });
  it('dark background indices (0-6, 8) => dark', () => {
    process.env['COLORFGBG'] = '15;0';
    expect(detectTerminalTheme()).toBe('dark');
    process.env['COLORFGBG'] = '15;8';
    expect(detectTerminalTheme()).toBe('dark');
  });
  it('reads the trailing field of a 3-part COLORFGBG (fg;default;bg)', () => {
    process.env['COLORFGBG'] = '15;default;0';
    expect(detectTerminalTheme()).toBe('dark');
    process.env['COLORFGBG'] = '0;default;15';
    expect(detectTerminalTheme()).toBe('light');
  });
  it('absent, empty, or unparseable => dark (safe default)', () => {
    delete process.env['COLORFGBG'];
    expect(detectTerminalTheme()).toBe('dark');
    process.env['COLORFGBG'] = '';
    expect(detectTerminalTheme()).toBe('dark');
    process.env['COLORFGBG'] = 'garbage';
    expect(detectTerminalTheme()).toBe('dark');
  });
});

describe('resolveTheme', () => {
  it('passes through concrete names', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });
  it('auto resolves via the terminal hint', () => {
    process.env['COLORFGBG'] = '0;15';
    expect(resolveTheme('auto')).toBe('light');
    process.env['COLORFGBG'] = '15;0';
    expect(resolveTheme('auto')).toBe('dark');
  });
  it('undefined resolves to dark (no visual change on default)', () => {
    expect(resolveTheme(undefined)).toBe('dark');
  });
});

describe('resolveThemeMode (precedence: flag > env > config)', () => {
  it('flag wins over env and config', () => {
    process.env['AFK_THEME'] = 'light';
    expect(resolveThemeMode('dark', 'auto')).toBe('dark');
  });
  it('env wins over config when no flag', () => {
    process.env['AFK_THEME'] = 'light';
    expect(resolveThemeMode(undefined, 'dark')).toBe('light');
  });
  it('config is used when neither flag nor env is set', () => {
    delete process.env['AFK_THEME'];
    expect(resolveThemeMode(undefined, 'light')).toBe('light');
  });
  it('undefined when nothing is set', () => {
    delete process.env['AFK_THEME'];
    expect(resolveThemeMode(undefined, undefined)).toBeUndefined();
  });
  it('ignores an invalid AFK_THEME env value, falling through to config', () => {
    process.env['AFK_THEME'] = 'plaid';
    expect(resolveThemeMode(undefined, 'light')).toBe('light');
  });
});

describe('applyTheme / live palette swap', () => {
  it('swaps member tones in place and restores on dark', () => {
    chalk.level = 3; // truecolor so hex tones actually emit escape codes
    const darkBrand = palette.brand('X');
    applyTheme('light');
    expect(getActiveTheme()).toBe('light');
    expect(palette.brand('X')).not.toBe(darkBrand);
    applyTheme('dark');
    expect(getActiveTheme()).toBe('dark');
    expect(palette.brand('X')).toBe(darkBrand);
  });
  it('preserves the palette object identity across a swap', () => {
    const ref = palette;
    applyTheme('light');
    expect(palette).toBe(ref);
  });
  it('keeps chained modifiers working after a swap (the 4 chain sites)', () => {
    chalk.level = 3;
    applyTheme('light');
    expect(palette.caret.inverse('c')).toContain('c');
    expect(palette.user.bold('u')).toContain('u');
    expect(palette.brand.bold('b')).toContain('b');
  });
});

describe('NO_COLOR invariant', () => {
  it('chalk.level = 0 strips all color under the light theme', () => {
    applyTheme('light');
    chalk.level = 0;
    expect(palette.brand('hello')).toBe('hello');
    expect(palette.error('e')).toBe('e');
    expect(palette.caret.inverse('c')).toBe('c');
  });
});

describe('palette theme maps', () => {
  it('light and dark expose exactly the same role set', () => {
    expect(Object.keys(lightPalette).sort()).toEqual(Object.keys(darkPalette).sort());
  });
  it('every role in each theme is callable and echoes its input', () => {
    for (const map of [darkPalette, lightPalette] as ThemePalette[]) {
      for (const fn of Object.values(map)) {
        expect(typeof fn).toBe('function');
        expect(fn('z')).toContain('z');
      }
    }
  });
});
