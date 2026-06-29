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
 * hybrid banner. Mirrors the package.json description / README thesis ("the
 * harness you can actually change") to give first-run identity. Kept short
 * (≤44 display cols) so it survives truncation at an 80-col terminal, where
 * the info column is only `cols − 32 = 48` cols wide.
 */
const BANNER_TAGLINE = 'the agent harness you can actually change';

/**
 * Hybrid mascot-left / info-stack-right banner. Borderless. Composed row by
 * row so the sprite and text stay aligned while each info row is truncated to
 * the available terminal width.
 *
 * Layout (MASCOT_HEIGHT rows of sprite; info column extends below if it
 * has more lines). The mascot is a half-block pixel-art goblin (see
 * mascot.ts for the design rationale); the info column carries the
 * wordmark, model/mode, worktree, cwd, and hint row.
 */
function renderHybridBanner(opts: WelcomeBannerOpts): string {
  const cols = getTerminalWidth();
  const GUTTER = cols >= 42 ? '   ' : ' ';
  const LEFT_PAD = cols >= 42 ? '  ' : ' ';
  const infoMaxW = Math.max(1, cols - LEFT_PAD.length - MASCOT_WIDTH - GUTTER.length);

  // Build info-column rows.
  const infoRows: string[] = [];
  const pushInfoRow = (row: string): void => {
    infoRows.push(truncateDisplay(row, infoMaxW));
  };

  // Row A: wordmark + optional version chip. The bold weight is carried by
  // "AFK" alone so the memorable acronym reads as the logo, with "Agent" in
  // regular-weight brand as its prefix. Same hue keeps the name reading as a
  // single unit — the weight step is the accent, not a colour change. Stripped
  // of ANSI the row is still the contiguous "Agent AFK" (tests assert this).
  const wordmark = palette.brand('Agent ') + palette.bold(palette.brand('AFK'));
  const versionChip =
    opts.version !== undefined ? palette.dim('  ' + formatVersion(opts.version)) : '';
  pushInfoRow(wordmark + versionChip);

  // Row A2: dim tagline — first-run identity. The info stack is short (≈4–6
  // rows) beside the 13-row sprite and is vertically centered below, so this
  // line fills otherwise-empty whitespace rather than displacing anything.
  // Truncated to infoMaxW like every info row, so it degrades gracefully on
  // narrow terminals.
  pushInfoRow(palette.dim(BANNER_TAGLINE));

  // Row B: model · mode.
  const modeBits: string[] = [];
  if (opts.model !== undefined) modeBits.push(palette.heading(opts.model));
  if (opts.mode.length > 0) modeBits.push(palette.dim(opts.mode));
  if (modeBits.length > 0) {
    pushInfoRow(modeBits.join(palette.dim(' · ')));
  }

  // Row C: worktree (only when in a worktree session — AFK-native signal).
  if (opts.worktree !== undefined) {
    pushInfoRow(
      palette.dim('branch  ') + palette.goblin(opts.worktree),
    );
  }

  // Row D: cwd (home-tilde'd + middle-truncated to fit).
  if (opts.cwd !== undefined) {
    const tilde = tildifyHome(opts.cwd);
    pushInfoRow(palette.dim(truncateMiddle(tilde, infoMaxW)));
  }

  // Row E: metaLine (caller-supplied, e.g. legacy "Model: x · Max tokens: y").
  if (opts.metaLine !== undefined) {
    pushInfoRow(palette.dim(opts.metaLine));
  }

  // Compose mascot + info rows. The info stack is short (≈3–5 rows) beside a
  // tall sprite, so top-aligning it strands the text against the cap and opens
  // a tall void down the right of the face. Vertically center the info block
  // against the sprite instead: the identity rows land beside the mascot's eyes
  // (its focal point) and the surrounding whitespace is balanced top and bottom.
  // When the info column is taller than the sprite (e.g. a /resume metaLine),
  // infoTopPad collapses to 0 and the layout degrades to the old top-alignment.
  const sprite = renderMascotLines('idle');
  const infoTopPad = Math.max(0, Math.floor((sprite.length - infoRows.length) / 2));
  const totalRows = Math.max(sprite.length, infoTopPad + infoRows.length);
  const lines: string[] = [];
  for (let i = 0; i < totalRows; i++) {
    const left = sprite[i] ?? ' '.repeat(MASCOT_WIDTH);
    const infoIdx = i - infoTopPad;
    const right = infoIdx >= 0 ? (infoRows[infoIdx] ?? '') : '';
    // trimEnd drops the trailing GUTTER + transparent sprite columns on rows
    // with no info text, so blank-right rows leave no selectable whitespace.
    lines.push((LEFT_PAD + left + GUTTER + right).trimEnd());
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
