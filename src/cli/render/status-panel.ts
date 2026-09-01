import { displayWidth, padDisplayRight } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { wrapToWidth } from '../wrap.js';
import { palette } from '../palette.js';
import { maxInnerBoxWidth, truncateDisplay } from './utils.js';

// ─── Status Panel ─────────────────────────────────────────────────────────────

/** Indicator kind controls the coloured dot shown next to a value. */
export type StatusKind = 'ok' | 'warn' | 'error' | 'info';

// ─── Health Check Rows ────────────────────────────────────────────────────────

/**
 * Structural interface for a health check result.
 *
 * Invariant: intentionally structurally compatible with the `Check` type in
 * `src/cli/commands/doctor-checks.ts` — both doctor surfaces (CLI command and
 * slash command) share this renderer without a hard dependency on that module.
 */
export interface HealthCheck {
  name: string;
  state: 'pass' | 'warn' | 'fail';
  detail?: string;
  fix?: string;
}

/**
 * Render a single health-check result as 1–2 formatted lines.
 *
 * Line 1: `  <icon> <name>  — <detail>` (detail omitted when absent)
 * Line 2: `      Fix: <fix>` (only when state is not pass AND fix is set)
 *
 * Invariant: palette calls are deferred to call time (not captured at import)
 * for the same reason as `dot()` above — a `light` theme swap must not leave
 * stale dark-theme colours on screen.
 */
export function healthCheckRows(check: HealthCheck): string[] {
  let icon: string;
  if (check.state === 'pass') {
    icon = palette.success('✓');
  } else if (check.state === 'warn') {
    icon = palette.warning('⚠');
  } else {
    icon = palette.error('✗');
  }

  let line = `  ${icon} ${check.name}`;
  if (check.detail) {
    line += `  — ${palette.dim(check.detail)}`;
  }

  const lines = [line];
  if (check.state !== 'pass' && check.fix) {
    lines.push(palette.dim(`      Fix: ${check.fix}`));
  }
  return lines;
}

/**
 * Render the passed / warned / failed tally for a set of health checks.
 *
 * Example: `  Summary: 5 passed  ·  1 warned  ·  2 failed`
 */
export function healthCheckSummary(checks: HealthCheck[]): string {
  const passed = checks.filter((c) => c.state === 'pass').length;
  const warned = checks.filter((c) => c.state === 'warn').length;
  const failed = checks.filter((c) => c.state === 'fail').length;

  const parts: string[] = [
    palette.success(`${passed} passed`),
    warned > 0 ? palette.warning(`${warned} warned`) : palette.dim(`${warned} warned`),
    failed > 0 ? palette.error(`${failed} failed`) : palette.dim(`${failed} failed`),
  ];
  return `  Summary: ${parts.join(palette.dim('  ·  '))}`;
}

/**
 * Render the coloured indicator glyph for a status kind.
 *
 * Invariant: this MUST be a function, not a module-level const/lookup table.
 * `palette` is a live view over the active theme (see palette.ts) —
 * capturing `palette.success('●')` etc. into a const at import time would
 * freeze the glyph to whatever theme was active at module load, so a
 * `light` swap would leave stale dark-theme dots on screen. Resolving per
 * call (mirrors `buildSyntaxTheme()` in syntax-theme.ts) keeps the glyph in
 * lock-step with `applyTheme()`.
 */
function dot(kind: StatusKind): string {
  switch (kind) {
    case 'ok':    return palette.success('●');
    case 'warn':  return palette.warning('●');
    case 'error': return palette.error('●');
    case 'info':  return palette.info('◆');
  }
}

/** A single row inside a status panel. */
export interface StatusRow {
  /** Left-column label (e.g. "SDK", "API Key"). */
  label: string;
  /** Right-column value text. */
  value: string;
  /** Optional coloured dot to prefix the value. */
  kind?: StatusKind;
}

/**
 * Render a framed status panel with aligned key-value rows.
 *
 * Example output (no ANSI):
 * ```
 * ╭──────────────────────────────────────────────────╮
 * │  Agent AFK · Status                            │
 * ├──────────────────────────────────────────────────┤
 * │  SDK           ●  Connected                      │
 * │  API Key       ●  Found (ANTHROPIC_API_KEY)       │
 * │  Model         ◆  sonnet                         │
 * ╰──────────────────────────────────────────────────╯
 * ```
 *
 * @param title - Heading shown inside the panel border.
 * @param rows  - Status rows to display.
 */
export function statusPanel(title: string, rows: StatusRow[]): string {
  const LABEL_GAP = 4; // spaces between label and indicator columns
  const DOT_W    = 2; // one dot character + one trailing space

  const maxLabel = rows.reduce((m, r) => Math.max(m, displayWidth(r.label)), 0);
  const maxValue = rows.reduce((m, r) => Math.max(m, displayWidth(r.value)), 0);

  // Content width = label column + gap + dot+space + value column
  const contentW = maxLabel + LABEL_GAP + DOT_W + maxValue;
  const termStretch = Math.min(getTerminalWidth() - 4, 100);
  let innerW = Math.max(44, displayWidth(title), contentW, termStretch);
  innerW = Math.min(innerW, maxInnerBoxWidth());

  // Each box line: '│' + '  ' + <innerW chars> + '  ' + '│'
  // Horizontal bar fills innerW + 4 dashes so total width equals innerW + 6.
  const barLen = innerW + 4;
  const b = palette.dim; // shorthand

  const top = b('╭' + '─'.repeat(barLen) + '╮');
  const sep = b('├' + '─'.repeat(barLen) + '┤');
  const bot = b('╰' + '─'.repeat(barLen) + '╯');
  const pipe = b('│');

  const titleLines = wrapToWidth(title, innerW).split('\n');
  const headerLines = titleLines.map(
    (tl) => pipe + '  ' + padDisplayRight(tl, innerW) + '  ' + pipe,
  );

  const valColW = Math.max(1, innerW - maxLabel - LABEL_GAP - DOT_W);

  // Row lines
  const rowLines = rows.map((r) => {
    const dotGlyph = r.kind ? dot(r.kind) + ' ' : '  ';
    const label  = palette.dim(padDisplayRight(truncateDisplay(r.label, maxLabel), maxLabel));
    const gap    = ' '.repeat(LABEL_GAP);
    const displayVal = truncateDisplay(r.value, valColW);
    const value  = padDisplayRight(displayVal, valColW);
    const content = label + gap + dotGlyph + value;
    return pipe + '  ' + content + '  ' + pipe;
  });

  return [top, ...headerLines, sep, ...rowLines, bot].join('\n');
}
