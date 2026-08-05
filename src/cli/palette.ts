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
 * ## Theming (dark / light / umber)
 *
 * `palette` is a LIVE view over the active theme. Three theme maps are
 * defined — `darkPalette` (the canonical tones documented below),
 * `lightPalette` (the same roles retuned for light-background terminals),
 * and `umberPalette` (the same roles mapped onto the Umber terminal's
 * measured warm palette). `applyTheme()` in `./theme.ts` rewrites
 * `palette`'s members in place, so the ~100 modules that already
 * `import { palette }` pick up the new tones on their next render with zero
 * code changes.
 *
 * Adding a FOURTH theme should extract the three maps into
 * `./palettes/{dark,light,umber}.ts` and leave this module owning only the
 * `ThemePalette` type + the live view — a fourth inline map would push this
 * file past the 350-line ceiling.
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
 * non-TTY, set in `color-config.ts`) strips color from every theme's
 * instances too — a level of 0 short-circuits to the bare string at CALL
 * time, whatever level the builder was created at.
 *
 * Invariant: `configureColor()` may only ever LOWER `chalk.level` (to 0), and
 * must never raise it. Unlike the level-0 strip, the color-SPACE choice is
 * resolved when `chalk.hex()` is CALLED — i.e. at this module's evaluation —
 * so a builder created while chalk auto-detected level 1 emits the 16-color
 * approximation forever, even if `chalk.level` is set to 3 afterwards. That
 * silently collapses distinct theme hexes onto the same escape (umber's
 * `#D7AA32` warning and dark's `chalk.yellow` both become `ESC[33m`), making
 * two themes look identical. Raising the level therefore requires setting
 * `FORCE_COLOR` in the environment BEFORE chalk is imported — which is
 * exactly why `configureColor()` returns early when it sees `FORCE_COLOR`
 * rather than translating it into a `chalk.level` assignment.
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
 * out. Pure modifiers (bold / italic / dim) are theme-agnostic
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
  /** Dark green — diff insertions on white. */
  diffAdd: chalk.hex('#2E7D32'),
  /** Dark red — diff deletions on white. */
  diffRemove: chalk.hex('#C62828'),
  /** Mid grey — diff hunk headers on white. */
  diffHunk: chalk.hex('#6B7280'),
};

/**
 * Umber theme — the same semantic roles mapped onto the Umber terminal's
 * measured palette (github.com/griffinwork40/umber, `ThemeValues.swift`).
 *
 * Umber is a DARK-ONLY theme: it is tuned for its own `#19120D` warm-brown
 * background, has no light variant upstream, and therefore never participates
 * in `auto` detection — it is an explicit opt-in (`--theme umber`). On a
 * light-background terminal it will be illegible; that is expected.
 *
 * Why these values: the dark theme's chrome is COOL slate grey (`#B0B8C2`,
 * `blackBright`), which visibly clashes against a warm-brown background. The
 * substitution that matters most is therefore the neutral spine — Umber's
 * warm neutrals `#F9F6F2` / `#D3CDC5` / `#AAA19B` replace the cool greys, and
 * that is what makes the theme read as umber rather than as "dark with an
 * orange accent."
 *
 * Provenance: 18 of the 22 colored roles are MEASURED Umber values (its
 * cursor accent + its ANSI 0–15 table), noted per-role below as `ansi<N>`.
 * Four roles — goblin, syntaxString, thinking, plan — have no Umber analogue
 * and are warm-shifted from their dark-theme hues, preserving hue identity
 * while moving toward Umber's warm cast. The five pure modifiers are
 * theme-agnostic and shared verbatim.
 *
 * Legibility: every colored role was checked against `#19120D` with the same
 * WCAG + APCA math Umber's own `check-theme-contrast.sh` harness uses; all
 * land at APCA Lc >= 49.5, above the Lc 45 floor. Umber's contrast harness is
 * a build-time validator with no runtime call sites, so these static values
 * are a faithful port — nothing is clamped at render time upstream.
 */
const umberPaletteDef: ThemePalette = {
  /** Umber's cursor accent — the signature warm amber. A near-neighbor of the dark theme's `#E67E4C`, so brand identity survives the port intact. */
  brand: chalk.hex('#FF9B5A'),
  /** ansi10 bright green — pale mint, distinct from `success` (ansi2). */
  mint: chalk.hex('#B4FCC3'),
  /** Warm olive — no Umber analogue; warm-shifted from the dark theme's `#9CB04A` to sit beside Umber's `#D7AA32` yellow. */
  goblin: chalk.hex('#A5AC55'),
  /** ansi6 cyan — the faithful translation of the dark theme's `chalk.cyan`. Reserved for user identity only. */
  user: chalk.hex('#42CBC8'),
  /** ansi12 bright blue — soft cornflower, matching the dark theme's `#7AA2F7` caret intent. */
  caret: chalk.hex('#9DBEFC'),
  /** ansi11 bright yellow — pale warm yellow, the analogue of the dark theme's `#DCDCAA` function tone. */
  tool: chalk.hex('#F7D179'),
  /** ansi7 white — bullet chrome. Warm neutral replacing the dark theme's cool slate `#B0B8C2`; still recedes against the saturated per-category hues. */
  chrome: chalk.hex('#D3CDC5'),
  /** Warm sage italic — no Umber analogue; warm-shifted from the dark theme's `#8AB07A`. Italic preserved as the colorblind-safety cue. */
  syntaxString: chalk.italic.hex('#96C182'),
  /** ansi7 white, dimmed — the faithful translation of the dark theme's `chalk.dim.white`. */
  toolArg: chalk.dim.hex('#D3CDC5'),
  /** Warm mauve italic — no Umber analogue; warm-shifted from the dark theme's `#9B8FB5`. */
  thinking: chalk.italic.hex('#B49EC4'),
  /** ansi2 green — the faithful translation of `chalk.green`. */
  success: chalk.hex('#8AE49E'),
  /** ansi1 red — the faithful translation of `chalk.red`. */
  error: chalk.hex('#EF7F74'),
  /** ansi3 yellow — the faithful translation of `chalk.yellow`. */
  warning: chalk.hex('#D7AA32'),
  /** Warm lavender — no Umber analogue; warm-shifted from the dark theme's `#9F7CE0`. */
  plan: chalk.hex('#AE93DE'),
  /** ansi5 magenta, bold — Umber's measured pink reads as the synthwave bypass chip without needing the dark theme's `#FF6AC1`. */
  bypass: chalk.bold.hex('#FFACE9'),
  /** ansi8 bright black — the faithful translation of `chalk.blackBright`, and the warm counterpart to it. One tier below `chrome`. */
  meta: chalk.hex('#AAA19B'),
  /** ansi4 blue — the ambient-notice channel. */
  info: chalk.hex('#739EF0'),
  /** ansi14 bright cyan — file refs. Brighter than `user` (ansi6), inverting the dark theme's relative ordering; both stay legible and distinguishable. */
  fileRef: chalk.hex('#80E5E2'),
  /** ansi15 bright white, bold — H2 headings. */
  heading: chalk.bold.hex('#F9F6F2'),
  /** Dim (theme-agnostic). */
  label: chalk.dim,
  /** Dim (theme-agnostic). */
  dim: chalk.dim,
  /** Bold (theme-agnostic). */
  bold: chalk.bold,
  /** Italic (theme-agnostic). */
  italic: chalk.italic,
  /** ansi2 green — diff insertions (mirrors `success`, as the dark theme does). */
  diffAdd: chalk.hex('#8AE49E'),
  /** ansi1 red — diff deletions (mirrors `error`, as the dark theme does). */
  diffRemove: chalk.hex('#EF7F74'),
  /** ansi8 bright black — diff hunk headers (mirrors `meta`, as the dark theme does). */
  diffHunk: chalk.hex('#AAA19B'),
};

/** Canonical dark tones (named export for `theme.ts` + tests). */
export const darkPalette: ThemePalette = darkPaletteDef;
/** Light-background tones (named export for `theme.ts` + tests). */
export const lightPalette: ThemePalette = lightPaletteDef;
/** Umber-terminal tones (named export for `theme.ts` + tests). */
export const umberPalette: ThemePalette = umberPaletteDef;

/**
 * The live palette every consumer imports. Starts on the dark theme;
 * `applyTheme()` (./theme.ts) mutates these members in place on a swap.
 * Keeps a stable object identity — do NOT reassign it.
 */
export const palette: ThemePalette = { ...darkPaletteDef };
