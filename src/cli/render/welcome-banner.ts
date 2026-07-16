import { sep } from 'node:path';
import chalk from 'chalk';
import { displayWidth, padDisplayRight } from '../display.js';
import { env } from '../../config/env.js';
import { getTerminalWidth } from '../terminal-size.js';
import { wrapToWidth } from '../wrap.js';
import { palette } from '../palette.js';
import { renderMascotLines, MASCOT_WIDTH, mascotSuppressed } from '../mascot.js';
import { maxInnerBoxWidth, truncateDisplay } from './utils.js';
import { renderAsciiWordmark, asciiWordmarkWidth } from './ascii-wordmark.js';

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
 * One-line product tagline — a punchy first-run identity subhead. Distinct from
 * the fuller package.json / README thesis ("…harness you can actually change");
 * it no longer mirrors that verbatim. Rendered as a full-width row BELOW the
 * hybrid composition (just above the resource links), so it spans the whole
 * terminal (`cols − LEFT_PAD`) and only ellipsizes on very narrow windows.
 * History: it used to ride inside the narrow ~(cols−31) column beside the
 * 27-col sprite, where — needing 42 display cols but only getting the column's
 * width — it truncated to "…without ba…" across the entire 55–72-col band while
 * the goblin kept full width; the full-width row fixes that. Kept ≤42 display
 * cols so it also survives the compact, mascot-less fallback at ~44 cols without
 * truncation (render.test.ts pins it at 44, 64, 80, and 100).
 */
const BANNER_TAGLINE = 'Run coding agents without babysitting them';

/**
 * Project links surfaced in the hybrid banner footer. These are the DISPLAY
 * forms (scheme + `.git` stripped) of package.json `homepage` and
 * `repository.url` respectively; render.test.ts drift-guards them against
 * package.json so a repo/docs move can't silently strand a stale banner link.
 */
const DOCS_URL = 'docs.agentafk.com';
const REPO_URL = 'github.com/griffinwork40/agent-afk';

/**
 * The block-art hero rendered beside the goblin. Just the acronym — "AFK" is
 * the logo (the full "Agent AFK" lives in the readable caption beneath it), so
 * the hero stays compact enough to sit in the right column without crowding the
 * sprite. Rendered with the vertical gradient below rather than a flat tone.
 */
const HERO_TEXT = 'AFK';

/**
 * Warm vertical gradient applied down the block-art hero — a light peach top
 * fading to a deep burnt orange, both bracketing the brand orange (#E67E4C), so
 * the wordmark reads as "lit from above" and carries the same depth as the
 * shaded goblin instead of a flat fill. chalk downsamples the truecolor stops
 * to 256/16-color automatically, and passes the rows through uncolored when the
 * terminal has no color — the block art stays legible either way.
 */
const HERO_GRADIENT_TOP: readonly [number, number, number] = [242, 174, 116];
const HERO_GRADIENT_BOTTOM: readonly [number, number, number] = [199, 84, 42];

/** Interpolate the hero gradient over `rows` (top → bottom) and colorize each. */
function shadeWordmark(rows: string[]): string[] {
  const n = rows.length;
  const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);
  return rows.map((row, i) => {
    const t = n <= 1 ? 0 : i / (n - 1);
    const r = lerp(HERO_GRADIENT_TOP[0], HERO_GRADIENT_BOTTOM[0], t);
    const g = lerp(HERO_GRADIENT_TOP[1], HERO_GRADIENT_BOTTOM[1], t);
    const b = lerp(HERO_GRADIENT_TOP[2], HERO_GRADIENT_BOTTOM[2], t);
    return chalk.rgb(r, g, b)(row);
  });
}

/**
 * Hybrid banner: a PORTRAIT composition — the pixel-art goblin anchors the left
 * as the visual hero; a right column carries the gradient-shaded "AFK" block-art
 * logo, the readable name/version caption, and the session facts; a full-width
 * BAND (tagline + project links + hint) closes it. Borderless, composed row by
 * row so the sprite and the right column stay on one grid.
 *
 * Layout (no ANSI; goblin drawn as a solid block here, colored in reality):
 * ```
 *   ████████████
 *   ████████████  ██  ████ █  █     ← shaded block-art logo (right column)
 *   ████████████ █  █ █    █ █
 *   ████████████ ████ ███  ██
 *   ████████████ █  █ █    █ █
 *   ████████████ █  █ █    █  █
 *   ████████████ Agent AFK · v5.25.8   ← readable name + version caption
 *   ████████████
 *   ████████████ opus_1m · Interactive Mode   ← session facts
 *   ████████████ branch afk/…
 *   ████████████ ~/path/to/cwd
 *   Run coding agents without babysitting them   ← tagline (full width)
 *   docs.agentafk.com · github.com/…   ← footer links (full width)
 *   /help · /model · …                 ← hint row (full width)
 * ```
 *
 * History: an earlier design promoted the full "AGENT AFK" wordmark to a
 * full-width header above the goblin to escape a ragged "moat" (the silhouette
 * reaches MASCOT_WIDTH only at the swept ears, so text beside the narrow cap
 * stranded against empty columns). Feedback found the full header "too much";
 * this design shrinks the hero to the "AFK" acronym, shades it with a warm
 * vertical gradient (matching the goblin's depth), and moves it into the right
 * column — vertically centered (round-biased) so the compact logo lands beside
 * the goblin's wider face rather than the cap tip. The full name survives as the
 * readable caption. Below MIN_INFO_COLS the sprite drops and the right column
 * stacks full-width. The mascot is a half-block pixel-art goblin (see mascot.ts);
 * the logo font is in ascii-wordmark.ts.
 */
function renderHybridBanner(opts: WelcomeBannerOpts): string {
  const cols = getTerminalWidth();
  // Two-space left frame; two-space gutter between the sprite and the right
  // column. The goblin reaches MASCOT_WIDTH only at its swept ears, so the right
  // column is vertically centered (round-biased) to land beside that widest
  // band rather than stranding against the narrow cap.
  const LEFT_PAD = '  ';
  const GUTTER = '  ';

  // Below this width the 27-col sprite would crush the right column into a
  // sliver; drop the mascot and stack the column full-width instead so the
  // banner stays legible at any narrow window size.
  const MIN_INFO_COLS = 24;
  const spriteBudget = cols - LEFT_PAD.length - MASCOT_WIDTH - GUTTER.length;
  const showMascot = spriteBudget >= MIN_INFO_COLS;

  // Right-column width: beside the sprite when shown, else the full terminal
  // width (minus the left pad) in the compact, mascot-less fallback.
  const headerMaxW = Math.max(1, cols - LEFT_PAD.length);
  const colMaxW = showMascot ? spriteBudget : headerMaxW;

  const versionText = opts.version !== undefined ? formatVersion(opts.version) : undefined;

  // ── Right column, composed top → bottom. ──
  const col: string[] = [];

  // Hero: the gradient-shaded block-art "AFK" logo. Defensive text fallback
  // only on a pathologically narrow terminal that can't hold the 14-col mark.
  if (asciiWordmarkWidth(HERO_TEXT) <= colMaxW) {
    col.push(...shadeWordmark(renderAsciiWordmark(HERO_TEXT)));
  } else {
    col.push(palette.brand('Agent ') + palette.bold(palette.brand('AFK')));
  }

  // Readable name + version caption: keeps the full "Agent AFK" greppable and
  // screen-reader-visible beneath the block-art acronym (tests assert this).
  // The bold title anchors identity; the version rides dim beside it, sharing
  // the same single-middot ( · ) rhythm as the mode/hint rows below rather than
  // the airier double-middot it used to carry. The product tagline is NOT pushed
  // here — it is emitted full-width below the whole composition (see the tagline
  // row just above the footer) so the 42-col thesis can never truncate mid-word
  // in the narrow ~(cols−31) column beside the 27-col sprite.
  const nameChip =
    palette.heading('Agent AFK') +
    (versionText !== undefined ? palette.dim(' · ' + versionText) : '');
  col.push('');
  col.push(truncateDisplay(nameChip, colMaxW));

  // Session-identity facts, each truncated to the column width.
  const factRows: string[] = [];
  const pushFact = (row: string): void => {
    factRows.push(truncateDisplay(row, colMaxW));
  };
  const modeBits: string[] = [];
  if (opts.model !== undefined) modeBits.push(palette.heading(opts.model));
  if (opts.mode.length > 0) modeBits.push(palette.dim(opts.mode));
  if (modeBits.length > 0) pushFact(modeBits.join(palette.dim(' · ')));
  // worktree (only in a worktree session — an AFK-native signal).
  if (opts.worktree !== undefined) pushFact(palette.dim('branch  ') + palette.goblin(opts.worktree));
  // cwd (home-tilde'd + middle-truncated to fit).
  if (opts.cwd !== undefined) pushFact(palette.dim(truncateMiddle(tildifyHome(opts.cwd), colMaxW)));
  // metaLine (caller-supplied, e.g. a /resume "Resuming <id>" cue).
  if (opts.metaLine !== undefined) pushFact(palette.dim(opts.metaLine));
  if (factRows.length > 0) {
    col.push('');
    col.push(...factRows);
  }

  const lines: string[] = [];

  if (showMascot) {
    // Compose sprite (left) + right column, the column vertically centered onto
    // the goblin's widest rows. ROUND (not floor) the top pad so a column
    // shorter than the 13-row sprite biases DOWN onto the ear/eye band. When
    // the column is taller (e.g. a /resume metaLine) the pad collapses to 0 and
    // the tail flows below the sprite.
    const sprite = renderMascotLines('idle');
    const colTopPad = Math.max(0, Math.round((sprite.length - col.length) / 2));
    const totalRows = Math.max(sprite.length, colTopPad + col.length);
    for (let i = 0; i < totalRows; i++) {
      const left = sprite[i] ?? ' '.repeat(MASCOT_WIDTH);
      const idx = i - colTopPad;
      const right = idx >= 0 ? (col[idx] ?? '') : '';
      // trimEnd drops the trailing gutter + transparent sprite columns on rows
      // with no right-column text, leaving no selectable trailing whitespace.
      lines.push((LEFT_PAD + left + GUTTER + right).trimEnd());
    }
  } else {
    // Compact fallback (terminal too narrow for the sprite): stack the column
    // flush-left with no mascot. Rows are pre-truncated so nothing overflows.
    for (const row of col) {
      lines.push((LEFT_PAD + row).trimEnd());
    }
  }

  // Product tagline — a full-width row below the composition, in an italic brand
  // tint so the thesis reads as a hero subhead. Rendered full-width (not the
  // sprite-side column) so it can never truncate mid-word: the line needs 42
  // display cols, but the column beside the 27-col sprite only clears that at
  // ≥73 cols, stranding the thesis as "…without ba…" across the whole 55–72
  // band. Sits just above the resource links so the bottom band reads
  // "thesis → where to go next".
  lines.push(
    LEFT_PAD + truncateDisplay(palette.italic(palette.brand(BANNER_TAGLINE)), headerMaxW),
  );

  // Project links — full-width footer, flush-left, grouped just above the hint
  // line so docs + source are always one glance away at startup. Truncated to
  // the header width (then left-padded) so a narrow terminal clips with an
  // ellipsis instead of overflowing the row. Single-middot ( · ) to match the
  // tagline, mode, and hint rhythm.
  lines.push(
    LEFT_PAD + truncateDisplay(palette.dim(`${DOCS_URL} · ${REPO_URL}`), headerMaxW),
  );

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
