/**
 * Text-layout and display-effect env vars: the prose/text measure, content
 * centering, and the smoke-text reveal. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling,
 * following the `env.browser.ts` precedent (#2206). `env.ts` spreads this
 * tuple into `ENV_REGISTRY` at the same position the entries used to occupy,
 * so registry order, the derived `EnvObject` / `EnvVarName` types, and the
 * rendered `docs/env-registry.*` are all unchanged.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.display
 */

import type { EnvVarMeta } from './env.js';

export const DISPLAY_ENV_REGISTRY = [
  {
    name: 'AFK_TEXT_MEASURE',
    description:
      'Maximum line length (columns) for unbordered streamed text in the interactive REPL: assistant prose, ' +
      'thinking blocks, tool-lane text, and subagent text. Display-only — affects wrapping, never behavior. ' +
      'Bordered elements (cards, error boxes) already cap at 100; this applies the same ceiling to the ' +
      'unbordered surfaces, which previously scaled to the full terminal width. ' +
      'Accepts a positive integer (minimum 20), or full | off | none | 0 to disable capping and restore ' +
      'full-width wrapping. Unparseable or below-minimum values fall back to the default. ' +
      'No-op on terminals at or below the measure, so narrow terminals are unaffected.',
    type: 'string',
    required: false,
    default: '100',
    example: 'full',
    category: 'misc',
  },
  {
    name: 'AFK_PROSE_MEASURE',
    description:
      'Maximum line length (columns) for prose-only blocks (paragraphs, list items, blockquotes) in the ' +
      'interactive REPL. Code fences use the wider AFK_TEXT_MEASURE (default 100). When AFK_TEXT_MEASURE ' +
      'is explicitly set, it overrides this value for backward compatibility. ' +
      'Accepts a positive integer (minimum 20), or full | off | none | 0 to disable. ' +
      'Unparseable or below-minimum values fall back to the default.',
    type: 'string',
    required: false,
    default: '80',
    example: '72',
    category: 'misc',
  },
  {
    name: 'AFK_CENTER_CONTENT',
    description:
      'When set to "1" (or any truthy value), content surfaces (tool-lane overlay, ' +
      'scrollback blocks, input line, spinner, and OODA stage rail) are horizontally ' +
      'centered by prepending a left margin equal to Math.floor((terminalWidth - contentMeasure) / 2). ' +
      'No-op when the terminal is at or below the content measure — the common 80–100 column case. ' +
      'Default off (empty string). Opt-in: set AFK_CENTER_CONTENT=1 to enable.',
    type: 'boolean',
    required: false,
    default: '',
    example: '1',
    category: 'display',
  },
  {
    name: 'AFK_INK_TEXT',
    description:
      'Streamed assistant prose in the interactive REPL is revealed at a steady pace instead of popping in: by ' +
      'default each letter condenses out of faint smoke (see AFK_SMOKE_TEXT), and a finished paragraph waits for ' +
      'its last letters before moving into scrollback. Layout and scrollback are identical to having it off. On by default on 256-color or ' +
      'truecolor terminals. It stays off for NO_COLOR, non-TTY output, AFK_PLAIN_OUTPUT, Telegram, the daemon, ' +
      'and AFK_REDUCED_MOTION=1. Set AFK_INK_TEXT=0 (or false/no/off) to show text the instant it arrives.',
    type: 'boolean',
    required: false,
    default: '',
    example: '0',
    category: 'display',
  },
  {
    name: 'AFK_SMOKE_TEXT',
    description:
      'Style of the streamed-text reveal (the reveal itself is AFK_INK_TEXT). Unset (default): prose and headings ' +
      'condense out of smoke, braille particles thickening into each letter with a thin wisp drifting ahead of the ' +
      'front. Set to "0" (or false/no/off) for the calmer ink fade instead, where letters rise from near the ' +
      'background into their own color. Set to "1" (or true/yes/on) to also hold headings until they finish ' +
      'rolling in and fade in machine-status UI (tool rows, the thought summary). Needs a 256-color or truecolor ' +
      'terminal. Off for NO_COLOR, non-TTY output, AFK_PLAIN_OUTPUT, Telegram, the daemon, and AFK_REDUCED_MOTION=1.',
    type: 'boolean',
    required: false,
    default: '',
    example: '1',
    category: 'display',
  },
  {
    name: 'AFK_WORD_TEXT',
    description:
      'Word-at-a-time style for the streamed-text reveal (the reveal itself is AFK_INK_TEXT), built for reading ' +
      'along while text streams. Set to "1" (or true/yes/on) and prose appears one whole word at a time at a ' +
      'steady pace, with only the newest words fading briefly from dim into their own color; a word is never ' +
      'shown half-typed. Overrides AFK_SMOKE_TEXT for prose and headings. Needs a 256-color or truecolor ' +
      'terminal. Off for NO_COLOR, non-TTY output, AFK_PLAIN_OUTPUT, Telegram, the daemon, and AFK_REDUCED_MOTION=1.',
    type: 'boolean',
    required: false,
    default: '',
    example: '1',
    category: 'display',
  },
  {
    name: 'AFK_TERM_COLOR_QUERY',
    description:
      'At interactive REPL startup, AFK asks the terminal for its real text, background, and 16-color palette ' +
      '(OSC 10/11/4, answered in well under 150ms by modern terminals and tmux) so the ink and smoke reveal can ' +
      'fade each letter exactly into the color it will settle on. Only runs when a reveal is enabled on a TTY. ' +
      'Set AFK_TERM_COLOR_QUERY=0 (or false/no/off) to skip the query and use the theme\'s built-in colors.',
    type: 'boolean',
    required: false,
    default: '',
    example: '0',
    category: 'display',
  },
] as const satisfies readonly EnvVarMeta[];
