/**
 * UI / output env vars (TUI rendering, themes, color, spinner, diff display).
 * A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.ui
 */

import type { EnvVarMeta } from './env.js';

export const UI_ENV_REGISTRY = [
  {
    name: 'AFK_BANNER_PLAIN',
    description: 'Suppress the ANSI-colored banner at REPL startup. Useful for non-TTY captures and CI logs.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_PLAIN_OUTPUT',
    description:
      'Force the interactive REPL to fully behave like a non-TTY surface for rendering purposes, ' +
      'even when stdout/stdin ARE a TTY: append-only plain-stdout output instead of the ' +
      'TerminalCompositor live overlay (both the persistent between-turn compositor AND the ' +
      'per-turn StreamRenderer overlay), AND the input surface downgrades to the simple ' +
      'non-TTY line reader instead of the fancy compositor-backed input box. Same code path ' +
      'already used for non-TTY surfaces (pipes, CI). Full opt-out escape hatch for tmux/SSH/' +
      'multiplexer sessions where cursor-up redraws and DECSTBM scroll regions misbehave — ' +
      'trades the live overlay and fancy input UX for reliability. Opt-in — default TTY behavior ' +
      '(live overlay + fancy input) is unchanged unless this var is set. Truthy values: 1, true ' +
      '(case-insensitive).',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_SPINNER_TIPS',
    description: 'Show rotating tips in the loading spinner during long calls. 1 = on, 0 = off. State-specific hints (e.g. the wait_for queue-to-stop hint) still show.',
    type: 'boolean',
    required: false,
    category: 'misc',
  },
  {
    name: 'AFK_GOBLIN_SPINNER',
    description: 'Goblin-themed working spinner (olive frames + goblin verbs) while the agent runs tools. 1 = on (default), 0 = classic dim spinner.',
    type: 'boolean',
    required: false,
    example: '0',
    category: 'misc',
  },
  {
    name: 'AFK_GOBLIN_MASCOT',
    description: 'Reacting goblin mini-sprite in the reserved footer band while the agent runs tools (3 rows, animated). 1 = on, unset/0 = off (default). Claims terminal rows, so it is opt-in.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_TERM_TITLE',
    description: 'Set the terminal/tab title (OSC 2) to reflect afk state — "afk — <cwd> · running" during a turn, "afk — <cwd>" when idle, cleared on exit. 1 = on (default when stdout is a TTY), 0 = leave the title alone. TTY-only.',
    type: 'boolean',
    required: false,
    example: '0',
    category: 'misc',
  },
  {
    name: 'AFK_NOTIFY',
    description: 'Emit a desktop completion notification (OSC 9) on turn completion, for terminals that map OSC 9 to system notifications (iTerm2, kitty, WezTerm). Opt-in and off by default (intrusive). 1 = on. TTY-only.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_SHOW_DIFFS',
    description: 'Show inline diffs in the tool-lane output for edit/write tool calls. 1 = on, 0 = off.',
    type: 'boolean',
    required: false,
    category: 'misc',
  },
  {
    name: 'AFK_TURN_SEPARATOR',
    description: 'Render a dim horizontal rule between conversation turns in the REPL. 0 = off, unset/1 = on (default). TTY-only: piped/one-shot output (afk chat) never emits the rule.',
    type: 'boolean',
    required: false,
    example: '0',
    category: 'misc',
  },
  {
    name: 'AFK_STREAM_BUFFER_MS',
    description: 'Input buffer window for TUI streaming in milliseconds. When set to a positive value, incoming tokens are micro-batched before parsing and rendering, producing smoother visual output. The first token after idle always passes through immediately (leading-edge). 0 = disabled (every token is parsed individually). Reasonable range: 8-50.',
    type: 'number',
    required: false,
    default: '0',
    example: '16',
    category: 'display',
  },
  {
    name: 'AFK_SKILL_STREAM_VERBOSE',
    description: 'Verbose streaming output when a skill is dispatched. Logs sub-agent setup, intermediate events, and final result.',
    type: 'boolean',
    required: false,
    category: 'debug',
  },
  {
    name: 'FORCE_COLOR',
    description: 'Standard Node convention. Force-enable ANSI color output even when stdout is not a TTY.',
    type: 'string',
    required: false,
    example: '1',
    category: 'process',
  },
  {
    name: 'NO_COLOR',
    description: 'Standard convention (https://no-color.org). When set to any non-empty value, disables ANSI color output.',
    type: 'string',
    required: false,
    example: '1',
    category: 'process',
  },
  {
    name: 'AFK_THEME',
    description:
      'TUI color palette for the interactive REPL and all CLI rendering: dark | light | umber | auto. ' +
      'Display-only — swaps the semantic color palette, never behavior (cost/latency unaffected). ' +
      'auto detects from COLORFGBG and falls back to dark; umber matches the Umber terminal, is dark-only, ' +
      'and is never chosen by auto. ' +
      'Overridden per-launch by --theme and mutable mid-session via /theme. ' +
      'Precedence: --theme flag > this env > config theme > auto-detect > dark. Invalid values are ignored (dark).',
    type: 'string',
    required: false,
    default: 'dark',
    example: 'light',
    category: 'misc',
  },
  {
    name: 'COLORFGBG',
    description:
      'Terminal-set "foreground;background" color hint (e.g. "15;0"), read only for AFK_THEME=auto detection. ' +
      'The trailing field is the background color index; >= 7 is treated as a light background, otherwise dark. ' +
      'Not set by AFK — emitted by some terminals (rxvt, Konsole, iTerm2). Absent or unparseable => dark.',
    type: 'string',
    required: false,
    example: '15;0',
    category: 'process',
  },
  {
    name: 'COLORTERM',
    description:
      'OS-level terminal color-depth hint. Accepted values: truecolor or 24bit (24-bit color), 256color (256-color). ' +
      'Set by the outer terminal emulator, not by AFK. Read by chalk\'s supports-color to set its initial color level; ' +
      'also read by configureColor() to recommend FORCE_COLOR=3 for tmux truecolor users on Node ≤ 24.',
    type: 'string',
    required: false,
    example: 'truecolor',
    category: 'process',
  },
] as const satisfies readonly EnvVarMeta[];
