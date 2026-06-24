/**
 * Semantic color palette for the interactive CLI.
 *
 * Centralizes all chalk calls behind named roles so that tone adjustments
 * happen in one place instead of scattered across interactive.ts / render.ts
 * / formatter.ts. Downstream modules import `palette.user`, `palette.tool`,
 * etc. — never raw chalk.
 *
 * Philosophy: four color families, each tuned for a specific visual role.
 *   - Brand tones carry identity (banner, prompt, top-level headings).
 *   - User tones mark what the user said or is about to say. Cyan is
 *     reserved for user identity ONLY — never for chrome or structure.
 *   - Tool tones mark agent activity (tool calls, results, file refs).
 *   - Meta tones carry low-priority information (stats, dim hints,
 *     structural scaffolding like diff hunk headers).
 *
 * Info sky blue is reserved for the ambient-notice channel ONLY (ℹ
 * messages, status cards, daemon banners). It is NOT a generic "secondary
 * blue" — anything that wants a second blue should use `fileRef` (teal)
 * or `tool` (steel) instead.
 */

import chalk from 'chalk';

export const palette = {
  /** Brand accent — warm orange, used for the banner title, prompt prefix, and top-level (H1) markdown headings. */
  brand: chalk.hex('#E67E4C'),
  /** Mint accent — cool mint green, used by the input-buffer highlighter as a per-command override for `/mint` (and its namespaced forms, e.g. `/example-plugin:mint`). A playful color pun on the skill name; treats `/mint` as a chip distinct from the brand-orange chip every other registered command renders as. Distinct from `success` (saturated ANSI green), `fileRef` (teal), `goblin` (olive), and `syntaxString` (warm sage). */
  mint: chalk.hex('#5FE3A1'),
  /** Goblin tone — bilious olive, used for the mascot sprite in the welcome banner and (future) ambient status surfaces. Owned by the mascot identity — do not reuse for chrome or syntax. */
  goblin: chalk.hex('#9CB04A'),
  /** User cyan — for user prompt text and their "you said" markers. Reserved for user identity only. */
  user: chalk.cyan,
  /** Tool name — steel blue, used as the syntax-theme color for functions / classes / titles in fenced code blocks. Originally also drove `● ToolName` bullet chrome; that role moved to `chrome` so syntax and chrome can evolve independently. */
  tool: chalk.hex('#DCDCAA'),
  /** Bullet chrome — slate grey, used for the `● ToolName` glyph + name itself when no per-tool category color overrides it. Recedes visually so the category-colored variants carry the salience. */
  chrome: chalk.hex('#B0B8C2'),
  /** Syntax: string-like values (strings, regex, attrs) — soft green italic. Italic is the colorblind-safety cue: paired with the warm-white function tone, the italic modifier disambiguates strings even when the green/yellow hue contrast collapses under deuteranopia/protanopia. */
  syntaxString: chalk.italic.hex('#8AB07A'),
  /** Tool argument — dim white, for `(args)` after the tool name. */
  toolArg: chalk.dim.white,
  /** Thinking tone — muted mauve italic, for extended thinking blocks. */
  thinking: chalk.italic.hex('#9B8FB5'),
  /** Success tone — green check marks, confirmation messages. */
  success: chalk.green,
  /** Error tone — muted red, used for errors and warnings. */
  error: chalk.red,
  /** Warning tone — yellow, used for cautions and "did you mean?". */
  warning: chalk.yellow,
  /** Plan tone — magenta hex, used for PLAN card border + title chip. */
  plan: chalk.hex('#9F7CE0'),
  /** Bypass tone — electric synthwave pink, bold, used for the `⚡ bypass` status-line chip + `/bypass` toggle (bypassPermissions mode). Deliberately reads as a "full-power / turbo unlocked" badge, NOT a caution: bypass is the default CLI mode now, so the indicator should inform at a glance without alarming. Warm-pink pairs with brand orange (sunset/synthwave) yet stays distinct from it and from plan lavender, so the chip never reads as the model name or plan mode. */
  bypass: chalk.bold.hex('#FF6AC1'),
  /** Meta tone — bright-black, used for per-turn stats, dim hints, diff hunk headers, "other"/"planning" tool fallbacks, and the neutral "interrupted" verdict. */
  meta: chalk.blackBright,
  /** Info tone — sky blue, used for ℹ-prefixed ambient notices, status cards, and daemon banners. Owns the ambient-notice channel exclusively. */
  info: chalk.hex('#5BA8FF'),
  /** File-reference teal — for `@<path>` tokens in the input field. Distinct from `info` so that file refs don't visually echo notification messages. */
  fileRef: chalk.hex('#56B5A8'),
  /** Heading tone — bold white, used for H2 markdown headings and section titles in help/debug. H1 uses `brand` instead. */
  heading: chalk.bold.white,
  /** Label tone — dim, used for key-value row labels in debug banners. */
  label: chalk.dim,
  /** Dim — alias for chalk.dim for convenience. */
  dim: chalk.dim,
  /** Bold — alias for chalk.bold for convenience. */
  bold: chalk.bold,
  /** Italic — used for emphasized prose; also paired with thinking tone. */
  italic: chalk.italic,
  /** Diff insertion — green, used for `+` lines in render-only diff blocks. */
  diffAdd: chalk.green,
  /** Diff deletion — red, used for `-` lines in render-only diff blocks. */
  diffRemove: chalk.red,
  /** Diff hunk header — dim grey, used for `@@ -a,b +c,d @@` lines. Structural scaffolding, not user-side, so it lives in the meta family. */
  diffHunk: chalk.blackBright,
} as const;

export type Palette = typeof palette;
