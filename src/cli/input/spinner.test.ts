/**
 * Tests for the goblin-themed spinner: the SpinnerController's optional
 * `goblin` flag (olive tint + goblin verb pool) and the caller-side
 * `detectGoblinSpinner` opt-out detector. The classic (default) theme must be
 * preserved, so the assertions derive each theme's color escape from `palette`
 * at runtime (color-level agnostic) rather than hardcoding a truecolor code.
 */

import { describe, it, expect } from 'vitest';
import { SpinnerController } from './spinner.js';
import { palette } from '../palette.js';
import { detectGoblinSpinner } from '../_lib/capture-mode.js';
import { GOBLIN_SPINNER_VERBS, SPINNER_VERBS } from '../constants.js';

const strip = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');

/** The opening color escape a palette tint emits at the active chalk level. */
const openEscape = (tint: (s: string) => string): string => tint('@').split('@')[0] ?? '';

describe('SpinnerController — goblin theme', () => {
  it('classic theme (default) tints the row with palette.meta + a noir verb', () => {
    const c = new SpinnerController({ captureMode: false, onTick: () => {} });
    c.set({ enabled: true });
    const row = c.renderSpinnerRow();
    c.dispose(); // tear down the 80ms ticker before asserting

    expect(row).not.toBeNull();
    // The frame+verb segment is tinted with palette.meta (the row opens with it).
    expect(row!.startsWith(openEscape(palette.meta))).toBe(true);
    const stripped = strip(row!);
    expect(SPINNER_VERBS.some((v) => stripped.includes(`${v}...`))).toBe(true);
  });

  it('goblin theme tints the row with palette.goblin + a goblin verb', () => {
    const c = new SpinnerController({ captureMode: false, goblin: true, onTick: () => {} });
    c.set({ enabled: true });
    const row = c.renderSpinnerRow();
    c.dispose();

    expect(row).not.toBeNull();
    expect(row!.startsWith(openEscape(palette.goblin))).toBe(true);
    const stripped = strip(row!);
    expect(GOBLIN_SPINNER_VERBS.some((v) => stripped.includes(`${v}...`))).toBe(true);
  });

  it('renders null when no spinner is active, in both themes', () => {
    const classic = new SpinnerController({ captureMode: false, onTick: () => {} });
    const goblin = new SpinnerController({ captureMode: false, goblin: true, onTick: () => {} });
    expect(classic.renderSpinnerRow()).toBeNull();
    expect(goblin.renderSpinnerRow()).toBeNull();
  });
});

describe('detectGoblinSpinner — opt-out, default on', () => {
  it('defaults ON when unset', () => {
    expect(detectGoblinSpinner({})).toBe(true);
  });

  it('disables ONLY on the literal "0"', () => {
    expect(detectGoblinSpinner({ AFK_GOBLIN_SPINNER: '0' })).toBe(false);
    expect(detectGoblinSpinner({ AFK_GOBLIN_SPINNER: '1' })).toBe(true);
    expect(detectGoblinSpinner({ AFK_GOBLIN_SPINNER: 'false' })).toBe(true);
  });
});
