import { sep } from 'node:path';
import { displayWidth, padDisplayRight } from '../display.js';
import { env } from '../../config/env.js';
import { getTerminalWidth } from '../terminal-size.js';
import { wrapToWidth } from '../wrap.js';
import { palette } from '../palette.js';
import { renderMascotLines, MASCOT_WIDTH, mascotSuppressed } from '../mascot.js';
import { maxInnerBoxWidth, truncateDisplay } from './utils.js';

// ─── Welcome Banner ───────────────────────────────────────────────────────────

/** Options for the interactive-session welcome banner. */
export interface WelcomeBannerOpts {
  /** Session mode label, e.g. `"Interactive Mode"`. */
  mode: string;
  /** Optional detail line rendered below the box, e.g. model/token/temp info. */
  metaLine?: string;
  /** Optional hint line rendered below metaLine, e.g. keyboard shortcuts. */
  hintLine?: string;
  /**
   * Optional extended info-stack fields. When ANY of these are provided AND
   * the mascot is not suppressed (`AFK_BANNER_PLAIN=1`), `welcomeBanner`
   * switches to the borderless hybrid layout: mascot sprite on the left,
   * info stack on the right. When all are absent, the legacy boxed wordmark
   * is rendered (preserving snapshot tests + alternate callsites).
   */
  model?: string;
  /** Worktree branch / dir name, e.g. `afk-20260520-093601-1d3a75`. */
  worktree?: string;
  /** Current working directory (will be home-tilde'd and middle-truncated). */
  cwd?: string;
  /** App version string, shown right of the wordmark, e.g. `"v0.4.2"`. */
  version?: string;
}

/**
 * Render a welcome banner for interactive session startup.
 *
 * Example output (no ANSI):
 * ```
 * ╭────────────────────────────────────────────────────────╮
 * │  Agent AFK  ·  Interactive Mode                       │
 * ╰────────────────────────────────────────────────────────╯
 *   Model: sonnet  ·  Max tokens: 4096  ·  Temp: 1.0
 *   Type /help for commands  ·  Ctrl+D or /exit to quit
 * ```
 *
 * @param opts - Banner configuration.
 */
export function welcomeBanner(opts: WelcomeBannerOpts): string {
  // Hybrid mascot layout activates only when extended fields are passed AND
  // the user has not opted out via AFK_BANNER_PLAIN=1. This preserves the
  // legacy boxed wordmark for callers that haven't migrated and for the
  // existing render.test.ts snapshot assertions.
  const hasExtendedFields =
    opts.model !== undefined ||
    opts.worktree !== undefined ||
    opts.cwd !== undefined ||
    opts.version !== undefined;
  if (hasExtendedFields && !mascotSuppressed()) {
    return renderHybridBanner(opts);
  }
  // Plain/legacy fallback. The legacy renderer only consumes `mode`, `metaLine`,
  // and `hintLine` — callers that pass extended fields (model/version/cwd/
  // worktree) would otherwise lose that info entirely when the user opts out
  // via AFK_BANNER_PLAIN=1. Fold them into mode + metaLine so the plain banner
  // still surfaces the same identity signals the hybrid banner shows.
  if (hasExtendedFields) {
    return renderLegacyBoxBanner(projectExtendedFieldsToPlain(opts));
  }
  return renderLegacyBoxBanner(opts);
}

/**
 * Translate hybrid-banner extended fields (model/version/cwd/worktree) into
 * the legacy banner's `mode` + `metaLine` slots, so the plain banner doesn't
 * drop information when AFK_BANNER_PLAIN=1 is set. Preserves any pre-existing
 * `metaLine`/`hintLine` the caller already supplied.
 */
function projectExtendedFieldsToPlain(opts: WelcomeBannerOpts): WelcomeBannerOpts {
  // Mode chip: prefix with model when supplied — mirrors the hybrid layout
  // where Row B reads "<model> · <mode>".
  let mode = opts.mode;
  if (opts.model !== undefined && opts.model.length > 0) {
    mode = `${opts.model} · ${mode}`;
  }
  if (opts.version !== undefined && opts.version.length > 0) {
    mode = `${mode} · ${formatVersion(opts.version)}`;
  }

  // metaLine: synthesise from worktree + cwd when not already supplied by the
  // caller. Format mirrors the hybrid info stack (branch label + tildified cwd).
  const metaParts: string[] = [];
  if (opts.worktree !== undefined && opts.worktree.length > 0) {
    metaParts.push(`branch ${opts.worktree}`);
  }
  if (opts.cwd !== undefined && opts.cwd.length > 0) {
    metaParts.push(tildifyHome(opts.cwd));
  }
  const synthesizedMeta = metaParts.join('  ·  ');
  const metaLine =
    opts.metaLine !== undefined
      ? opts.metaLine
      : synthesizedMeta.length > 0
        ? synthesizedMeta
        : undefined;

  const next: WelcomeBannerOpts = { mode };
  if (metaLine !== undefined) next.metaLine = metaLine;
  if (opts.hintLine !== undefined) next.hintLine = opts.hintLine;
  return next;
}

/**
 * Legacy boxed-wordmark banner — preserved for the old `src/cli/interactive.ts`
 * callsite and the existing render.test.ts assertions. Identical to the
 * pre-mascot layout.
 */
function renderLegacyBoxBanner(opts: WelcomeBannerOpts): string {
  const APP = 'Agent AFK';
  const SEP = '  ·  ';

  const labelStyled = palette.bold(APP) + palette.dim(SEP) + opts.mode;
  const labelPlain  = APP + SEP + opts.mode;

  const termStretch = Math.min(getTerminalWidth() - 4, 120);
  let innerW = Math.max(54, displayWidth(labelPlain) + 4, termStretch);
  innerW = Math.min(innerW, maxInnerBoxWidth());

  const barLen = innerW + 4;
  const b = palette.dim;

  const top = b('╭' + '─'.repeat(barLen) + '╮');
  const wrapped = wrapToWidth(labelStyled, innerW);
  const midLines = wrapped.split('\n').map(
    (line) => b('│') + '  ' + padDisplayRight(line, innerW) + '  ' + b('│'),
  );
  const bot = b('╰' + '─'.repeat(barLen) + '╯');

  const lines: string[] = [top, ...midLines, bot];

  if (opts.metaLine !== undefined) {
    lines.push(...wrapToWidth(palette.dim('  ' + opts.metaLine), getTerminalWidth()).split('\n'));
  }
  if (opts.hintLine !== undefined) {
    lines.push(...wrapToWidth(palette.dim('  ' + opts.hintLine), getTerminalWidth()).split('\n'));
  }

  return lines.join('\n');
}

/**
 * One-line product tagline rendered (dim) directly under the wordmark in the
 * header band of the hybrid banner. Mirrors the package.json description /
 * README thesis ("the harness you can actually change") to give first-run
 * identity. Because the header band spans the full terminal (it sits ABOVE the
 * sprite, not beside it), the tagline has the whole width to breathe and only
 * ellipsizes on very narrow windows (`cols − LEFT_PAD`); kept short so it also
 * survives the compact, mascot-less fallback at ~44 cols without truncation.
 */
const BANNER_TAGLINE = 'the agent harness you can actually change';

/**
 * Hybrid banner: a full-width HEADER band (wordmark + tagline) stacked above a
 * PORTRAIT band (mascot sprite on the left, session facts on the right).
 * Borderless. Composed row by row so the sprite and facts stay aligned.
 *
 * Layout (no ANSI):
 * ```
 *   Agent AFK  v5.15.11                          ← header band (full width)
 *   the agent harness you can actually change
 *
 *   <13-row  ·  goblin>   opus_1m · Interactive   ← portrait band
 *   <   half-block   >    branch afk/…
 *   <     sprite     >    ~/path/to/cwd
 *   /help · /model · …                            ← hint row (full width)
 * ```
 *
 * History: the wordmark previously sat in the info column beside the sprite,
 * where it landed against the goblin's narrow forehead and opened a ragged
 * ~7-col "moat" before the most-read line (the silhouette only reaches
 * MASCOT_WIDTH at the swept ears, several rows lower). Promoting the wordmark +
 * tagline to a full-width header frees the hero line from the sprite silhouette
 * entirely; only the short, secondary session-fact rows remain beside the
 * goblin. The mascot is a half-block pixel-art goblin (see mascot.ts).
 */
function renderHybridBanner(opts: WelcomeBannerOpts): string {
  const cols = getTerminalWidth();
  // Fixed two-space frame on the left; two-space gutter between the sprite and
  // the facts column. Only the goblin's swept ears reach MASCOT_WIDTH, so the
  // facts (vertically centered onto the ear/eye rows below) sit close to the
  // silhouette; the header band above is unaffected by the sprite width.
  const LEFT_PAD = '  ';
  const GUTTER = '  ';

  // Below this facts width the 27-col sprite crowds the text into a sliver
  // where every row ellipsizes. When the budget falls under it, drop the mascot
  // and stack the header + facts full-width instead, so the banner stays
  // legible at any narrow window size.
  const MIN_INFO_COLS = 24;
  const spriteBudget = cols - LEFT_PAD.length - MASCOT_WIDTH - GUTTER.length;
  const showMascot = spriteBudget >= MIN_INFO_COLS;

  // Header band spans the full terminal (minus the left pad) regardless of the
  // sprite. The facts column sits beside the sprite when shown, else spans the
  // full width in the compact, mascot-less fallback.
  const headerMaxW = Math.max(1, cols - LEFT_PAD.length);
  const factsMaxW = showMascot ? spriteBudget : headerMaxW;

  // ── Header band: wordmark + optional version chip, then the tagline. ──
  // The bold weight is carried by "AFK" alone so the memorable acronym reads as
  // the logo, with "Agent" in regular-weight brand as its prefix. Same hue
  // keeps the name reading as a single unit — the weight step is the accent,
  // not a colour change. Stripped of ANSI the row is still the contiguous
  // "Agent AFK" (tests assert this).
  const headerRows: string[] = [];
  const wordmark = palette.brand('Agent ') + palette.bold(palette.brand('AFK'));
  const versionChip =
    opts.version !== undefined ? palette.dim('  ' + formatVersion(opts.version)) : '';
  headerRows.push(truncateDisplay(wordmark + versionChip, headerMaxW));
  headerRows.push(truncateDisplay(palette.dim(BANNER_TAGLINE), headerMaxW));

  // ── Facts column: short session-identity rows beside the sprite. ──
  const factRows: string[] = [];
  const pushFact = (row: string): void => {
    factRows.push(truncateDisplay(row, factsMaxW));
  };

  // model · mode.
  const modeBits: string[] = [];
  if (opts.model !== undefined) modeBits.push(palette.heading(opts.model));
  if (opts.mode.length > 0) modeBits.push(palette.dim(opts.mode));
  if (modeBits.length > 0) {
    pushFact(modeBits.join(palette.dim(' · ')));
  }

  // worktree (only when in a worktree session — AFK-native signal).
  if (opts.worktree !== undefined) {
    pushFact(palette.dim('branch  ') + palette.goblin(opts.worktree));
  }

  // cwd (home-tilde'd + middle-truncated to fit).
  if (opts.cwd !== undefined) {
    const tilde = tildifyHome(opts.cwd);
    pushFact(palette.dim(truncateMiddle(tilde, factsMaxW)));
  }

  // metaLine (caller-supplied, e.g. a /resume "Resuming <id>" cue).
  if (opts.metaLine !== undefined) {
    pushFact(palette.dim(opts.metaLine));
  }

  const lines: string[] = [];

  // Header band, flush-left, above everything.
  for (const row of headerRows) {
    lines.push((LEFT_PAD + row).trimEnd());
  }

  if (showMascot) {
    // Blank spacer separating the title band from the portrait band, so the
    // goblin's narrow cap tip doesn't butt directly against the tagline.
    lines.push('');
    // Compose mascot + facts. The facts block is short (≈2–4 rows) beside the
    // 13-row sprite. Vertically center it and ROUND (not floor) the top pad:
    // rounding biases a 2-row block down onto the eye/ear rows — the widest,
    // tightest-gutter part of the silhouette — instead of the narrow forehead
    // the wordmark used to strand against. When the facts column is taller than
    // the sprite (e.g. a /resume metaLine), the pad collapses to 0 and it
    // degrades to top-alignment.
    const sprite = renderMascotLines('idle');
    const factsTopPad = Math.max(0, Math.round((sprite.length - factRows.length) / 2));
    const totalRows = Math.max(sprite.length, factsTopPad + factRows.length);
    for (let i = 0; i < totalRows; i++) {
      const left = sprite[i] ?? ' '.repeat(MASCOT_WIDTH);
      const factIdx = i - factsTopPad;
      const right = factIdx >= 0 ? (factRows[factIdx] ?? '') : '';
      // trimEnd drops the trailing GUTTER + transparent sprite columns on rows
      // with no facts text, so blank-right rows leave no selectable whitespace.
      lines.push((LEFT_PAD + left + GUTTER + right).trimEnd());
    }
  } else {
    // Compact fallback (terminal too narrow for the sprite): stack the facts
    // column flush-left with no mascot, below the header band. Each row is
    // already truncated to the full width, so nothing is crushed into a sliver.
    if (factRows.length > 0) {
      lines.push('');
    }
    for (const row of factRows) {
      lines.push((LEFT_PAD + row).trimEnd());
    }
  }

  // Hint line sits flush-left below the whole composition.
  if (opts.hintLine !== undefined) {
    lines.push(
      ...wrapToWidth(palette.dim(LEFT_PAD + normalizeHintLine(opts.hintLine)), cols).split('\n'),
    );
  }

  return lines.join('\n');
}

function formatVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

function normalizeHintLine(hint: string): string {
  return hint.replace(/\s+·\s+/g, ' · ');
}

/**
 * Replace `$HOME` prefix with `~` for display. Honors the path-separator
 * boundary so a sibling dir that shares a prefix with `$HOME` (e.g.
 * HOME=/Users/jane, p=/Users/janeway/project) is left untouched instead of
 * being rewritten to a misleading `~way/project`. Matches the semantics of
 * `formatCwd`'s tildify helper.
 */
function tildifyHome(p: string): string {
  const home = env.HOME;
  if (home === undefined || home.length === 0) return p;
  if (p === home) return '~';
  const prefix = home.endsWith(sep) ? home : home + sep;
  if (p.startsWith(prefix)) {
    return '~' + sep + p.slice(prefix.length);
  }
  return p;
}

/**
 * Middle-truncate a path to fit within `maxW` display columns. Preserves
 * the first and last segments so the user can still recognize the dir.
 */
function truncateMiddle(s: string, maxW: number): string {
  if (displayWidth(s) <= maxW) return s;
  const ELLIPSIS = '…';
  // Reserve 1 col for the ellipsis. Split remaining budget evenly between
  // head and tail, biased toward the tail (more informative — the basename).
  const budget = Math.max(2, maxW - 1);
  const tailW = Math.ceil(budget * 0.6);
  const headW = Math.max(1, budget - tailW);
  // displayWidth-aware slicing approximation: characters and display cells
  // align for ASCII paths, which is the common case here.
  return s.slice(0, headW) + ELLIPSIS + s.slice(s.length - tailW);
}
