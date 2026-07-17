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
 *
 * ## Theming (dark / light)
 *
 * `palette` is a LIVE view over the active theme. Two theme maps are
 * defined — `darkPalette` (the canonical tones documented below) and
 * `lightPalette` (the same roles retuned for light-background terminals).
 * `applyTheme()` in `./theme.ts` rewrites `palette`'s members in place, so
 * the ~100 modules that already `import { palette }` pick up the new tones
 * on their next render with zero code changes.
 *
 * Invariant: `palette` keeps the SAME object identity across a theme swap —
 * only its member chalk instances change. Consumers therefore MUST access
 * `palette.<role>` at render time (call site) and MUST NOT capture a member
 * into a module-level const at import time, or they will freeze to whatever
 * theme was active at module load. The sole historical exception was
 * `syntax-theme.ts`, which was made lazy (`buildSyntaxTheme()`) for exactly
 * this reason.
 *
 * Invariant: every theme is built from the shared default `chalk` export
 * (never `new Chalk({ level })`), so `chalk.level = 0` (NO_COLOR / CI /
 * non-TTY, set in `color-config.ts`) strips color from light-theme
 * instances too — chalk builders read the global level at call time.
 */

import chalk, { type ChalkInstance } from 'chalk';

/**
 * Dark theme — the canonical tones, unchanged from the original palette.
 * This is the default; every existing user sees exactly this.
 */
const darkPaletteDef = {
  /** Brand accent — warm orange, used for the banner title, prompt prefix, and top-level (H1) markdown headings. */
  brand: chalk.hex('#E67E4C'),
  /** Mint accent — cool mint green, used by the input-buffer highlighter as a per-command override for `/mint` (and its namespaced forms, e.g. `/example-plugin:mint`). A playful color pun on the skill name; treats `/mint` as a chip distinct from the brand-orange chip every other registered command renders as. Distinct from `success` (saturated ANSI green), `fileRef` (teal), `goblin` (olive), and `syntaxString` (warm sage). */
  mint: chalk.hex('#5FE3A1'),
  /** Goblin tone — bilious olive, used for the mascot sprite in the welcome banner and (future) ambient status surfaces. Owned by the mascot identity — do not reuse for chrome or syntax. */
  goblin: chalk.hex('#9CB04A'),
  /** User cyan — for user prompt text and their "you said" markers. Reserved for user identity only. */
  user: chalk.cyan,
  /** Caret — thin vertical-bar cursor rendered in the input field. Distinct from `user` (cyan) so the cursor style can evolve independently of user-identity chrome. Soft cornflower blue pairs cleanly with JetBrains Mono dark themes and contrasts the warm brand orange without competing with info sky-blue or fileRef teal. */
  caret: chalk.hex('#7AA2F7'),
  /** Tool name — warm white / soft khaki (#DCDCAA), the VSCode default-dark function color; used as the syntax-theme tone for functions / classes / titles in fenced code blocks. (This is a pale yellow, NOT a blue — an earlier comment mislabeled it "steel blue".) Originally also drove `● ToolName` bullet chrome; that role moved to `chrome` so syntax and chrome can evolve independently. */
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
  /** Inverse — reverse-video (swaps fg/bg). A modifier alias so the render layer never reaches for raw chalk. Currently unused: the @-file autocomplete dropdown that formerly used it now matches the arrow-key picker's brand-marker + bold-label selection idiom. */
  inverse: chalk.inverse,
  /** Diff insertion — green, used for `+` lines in render-only diff blocks. */
  diffAdd: chalk.green,
  /** Diff deletion — red, used for `-` lines in render-only diff blocks. */
  diffRemove: chalk.red,
  /** Diff hunk header — dim grey, used for `@@ -a,b +c,d @@` lines. Structural scaffolding, not user-side, so it lives in the meta family. */
  diffHunk: chalk.blackBright,
};

/**
 * The role set every theme must implement. Derived from the dark theme so
 * the two maps can never drift apart in shape — a missing role in
 * `lightPaletteDef` is a compile error.
 */
export type ThemePalette = { [K in keyof typeof darkPaletteDef]: ChalkInstance };

/**
 * Light theme — the same semantic roles retuned for light-background
 * terminals. Each colored role keeps its dark-theme HUE IDENTITY (brand is
 * still orange, user is still cyan-ish, success still green) but darkens /
 * saturates so it stays legible on a white-to-pale background where the
 * dark theme's pale tones (warm-white, bright-black, dim-white) would wash
 * out. Pure modifiers (bold / italic / inverse / dim) are theme-agnostic
 * and shared verbatim.
 *
 * Values are a considered first cut and are safe to retune in isolation —
 * the theming mechanism does not depend on any specific hex.
 */
const lightPaletteDef: ThemePalette = {
  /** Burnt orange — brand identity, darkened for white-bg contrast. */
  brand: chalk.hex('#C0562A'),
  /** Deeper mint-green (the pale dark-theme mint vanishes on white). */
  mint: chalk.hex('#1B9E63'),
  /** Darker olive — mascot identity on light. */
  goblin: chalk.hex('#6B7D2A'),
  /** Dark cyan/teal — bright cyan is illegible on white; keeps user-identity hue. */
  user: chalk.hex('#0E7490'),
  /** Deeper cornflower — cursor visible on white. */
  caret: chalk.hex('#3B5BDB'),
  /** Dark khaki-gold — the light-bg equivalent of the warm-white function tone. */
  tool: chalk.hex('#7A6E00'),
  /** Dark slate — bullet chrome that recedes but stays visible on white. */
  chrome: chalk.hex('#5A6470'),
  /** Darker green italic — code strings on white (italic colorblind cue preserved). */
  syntaxString: chalk.italic.hex('#3F7A3F'),
  /** Mid grey — dim-white washes out on white, so use an explicit legible grey. */
  toolArg: chalk.hex('#6B7280'),
  /** Darker mauve italic — thinking blocks on white. */
  thinking: chalk.italic.hex('#6D5B8E'),
  /** Dark green — success on white. */
  success: chalk.hex('#2E7D32'),
  /** Dark red — errors on white. */
  error: chalk.hex('#C62828'),
  /** Dark goldenrod/amber — ANSI yellow is near-illegible on white. */
  warning: chalk.hex('#B8860B'),
  /** Deeper purple — plan chrome on white. */
  plan: chalk.hex('#7048C0'),
  /** Deeper synthwave pink, bold — bypass chip on white. */
  bypass: chalk.bold.hex('#D6297F'),
  /** Mid grey — bright-black reads as light-grey on white; use an explicit mid-grey. */
  meta: chalk.hex('#6B7280'),
  /** Deeper sky blue — ambient-notice channel on white. */
  info: chalk.hex('#1D6FD6'),
  /** Dark teal — file refs on white. */
  fileRef: chalk.hex('#0F766E'),
  /** Bold near-black — H2 headings; white heading is invisible on white. */
  heading: chalk.bold.hex('#1F2937'),
  /** Dim (relative modifier — theme-agnostic). */
  label: chalk.dim,
  /** Dim (theme-agnostic). */
  dim: chalk.dim,
  /** Bold (theme-agnostic). */
  bold: chalk.bold,
  /** Italic (theme-agnostic). */
  italic: chalk.italic,
  /** Inverse (theme-agnostic). */
  inverse: chalk.inverse,
  /** Dark green — diff insertions on white. */
  diffAdd: chalk.hex('#2E7D32'),
  /** Dark red — diff deletions on white. */
  diffRemove: chalk.hex('#C62828'),
  /** Mid grey — diff hunk headers on white. */
  diffHunk: chalk.hex('#6B7280'),
};

/** Canonical dark tones (named export for `theme.ts` + tests). */
export const darkPalette: ThemePalette = darkPaletteDef;
/** Light-background tones (named export for `theme.ts` + tests). */
export const lightPalette: ThemePalette = lightPaletteDef;

/**
 * The live palette every consumer imports. Starts on the dark theme;
 * `applyTheme()` (./theme.ts) mutates these members in place on a swap.
 * Keeps a stable object identity — do NOT reassign it.
 */
export const palette: ThemePalette = { ...darkPaletteDef };
