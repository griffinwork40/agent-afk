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

export const defaultSyntaxTheme: Sheet = {
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
