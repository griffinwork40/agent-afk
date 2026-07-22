/**
 * Default emphasize "sheet" mapping highlight.js token classes to chalk
 * styles drawn exclusively from the existing semantic palette.
 *
 * The shape conforms to emphasize's `Sheet` type: a record of class-name
 * → (value: string) => string. Unknown classes fall through to identity
 * automatically inside emphasize, so we only enumerate the classes we
 * intentionally style.
 *
 * Color choices follow mainstream code-editor conventions:
 *   - Strings: green italic (Catppuccin / Tokyo Night convention; italic
 *     is the colorblind-safety cue against the warm-white function tone).
 *   - Functions / classes: warm white #DCDCAA (VSCode default-dark
 *     convention — devs already pattern-match this token color).
 *   - Keywords / literals / tags: brand orange (top-level identity hue).
 *   - Numbers: warning yellow.
 *   - Comments / meta: dim grey.
 *
 * Strings DELIBERATELY do not use `palette.user` (cyan) — cyan is
 * reserved for user identity. A string literal in code is not "what the
 * user said."
 */

import type { Sheet } from 'emphasize';
import { palette } from './palette.js';

/**
 * Build the syntax-highlight sheet from the CURRENTLY ACTIVE palette.
 *
 * Invariant: this MUST be a function, not a module-level const. `palette`
 * is a live view over the active theme (see palette.ts) — capturing
 * `palette.brand` etc. into a const at import time would freeze the sheet
 * to whatever theme was active at module load, so a `light` swap would
 * leave code blocks styled in the dark tones. Resolving per-call keeps the
 * sheet in lock-step with `applyTheme()`. `syntax-highlight.ts` clears its
 * styled-output cache on a swap so re-highlights pick up the new tones.
 */
export function buildSyntaxTheme(): Sheet {
  return {
    // Structural keywords / language identifiers
    keyword: palette.brand,
    built_in: palette.brand,
    literal: palette.brand,
    tag: palette.brand,

    // String-like values — green italic (italic disambiguates from
    // function tones under deuteranopia/protanopia).
    string: palette.syntaxString,
    regexp: palette.syntaxString,
    attr: palette.syntaxString,

    // Comments and docs metadata
    comment: palette.meta,
    meta: palette.meta,
    quote: palette.meta,

    // Numbers
    number: palette.warning,

    // Function / class / selector identifiers — warm white (#DCDCAA),
    // the VSCode default-dark convention.
    function: palette.tool,
    title: palette.tool,
    class: palette.tool,
    'selector-tag': palette.tool,
  };
}
