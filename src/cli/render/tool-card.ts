import { sanitizeForDisplay } from '../../utils/terminal-sanitize.js';
import { displayWidth, truncateDisplayWidth, stripAnsi } from '../display.js';
import { palette } from '../palette.js';
import { statusBadge } from './status-badge.js';
import { formatElapsed } from './utils.js';

// ─── ToolCard ─────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link toolCard}.
 *
 * Models a single completed or in-flight tool call.  The `collapsed` flag
 * gates whether the body lines (input summary, output preview, diff stat)
 * are rendered — a collapsed card shows only the header, which is useful
 * for long scrollback regions that want to conserve vertical space.
 */
export interface ToolCardSpec {
  /** Display name of the tool being called. */
  toolName: string;
  /** Current lifecycle state of the tool call. */
  status: 'running' | 'done' | 'error' | 'blocked';
  /** Elapsed wall-clock time in milliseconds. */
  elapsed?: number;
  /** Truncated first argument — file path, shell command, URL, etc. */
  inputSummary?: string;
  /** Truncated tool output — first meaningful line of the result. */
  outputPreview?: string;
  /** Diff statistics for edit_file / write_file results. */
  diff?: { added: number; removed: number; file: string };
  /**
   * When `true`, only the header line is rendered.
   *
   * Callers that manage scrollback regions can collapse cards for tools that
   * have already been acknowledged, reducing vertical noise.
   */
  collapsed?: boolean;
  /**
   * Pre-styled batch badge appended to the header after the elapsed field.
   *
   * The value is an already-styled ANSI string produced by the caller (e.g.
   * `batchBadge(chunk)` from tool-lane-format.ts). Passed through verbatim
   * so the component does not need to know the batch-badge colour rules.
   * When undefined or empty, nothing extra is rendered.
   */
  batchBadge?: string;
  /**
   * Terminal column width used for truncation.
   *
   * Defaults to 80.  The component never reads `process.stdout.columns`
   * directly so it remains a pure spec → string transform.
   */
  width?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Left indent applied to body lines (keeps them visually below the badge). */
const INDENT = '  ';


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a collapsible tool-call display with a status badge.
 *
 * Visual output (expanded, done):
 *   ✓ bash  3s
 *     ls -la /tmp
 *     drwxr-xr-x  8 root  wheel  256 Jan  1 00:00 .
 *     +2 -0  /tmp/newfile.txt
 *
 * Visual output (collapsed or no body):
 *   ✓ bash  3s
 *
 * Visual output (running, no elapsed):
 *   ● read_file
 *
 * Pure function — no side effects.  All ANSI styling is applied via the
 * project palette so the card follows the active theme (dark / light / umber).
 *
 * @param spec - Tool card configuration.
 * @returns Multi-line ANSI string (or single-line when collapsed / no body).
 */
export function toolCard(spec: ToolCardSpec): string {
  const width = Math.max(1, spec.width ?? 80);
  const collapsed = spec.collapsed ?? false;

  // ── Header ──────────────────────────────────────────────────────────────────
  const header = buildHeader(spec, width);

  if (collapsed) return header;

  // ── Body lines (optional) ────────────────────────────────────────────────────
  const body: string[] = [];
  const bodyWidth = Math.max(1, width - displayWidth(INDENT));

  if (spec.inputSummary != null && spec.inputSummary.length > 0) {
    const sanitized = sanitizeForDisplay(spec.inputSummary);
    const truncated = truncateDisplayWidth(sanitized, bodyWidth);
    body.push(INDENT + palette.dim(truncated));
  }

  if (spec.outputPreview != null && spec.outputPreview.length > 0) {
    const sanitized = sanitizeForDisplay(spec.outputPreview);
    const truncated = truncateDisplayWidth(sanitized, bodyWidth);
    body.push(INDENT + palette.dim(truncated));
  }

  if (spec.diff != null) {
    body.push(INDENT + buildDiffStat(spec.diff, bodyWidth));
  }

  if (body.length === 0) return header;
  return [header, ...body].join('\n');
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Build the single-line header: `<badge> <toolName>  <elapsed?>`.
 *
 * The tool name is truncated so the assembled header never exceeds `width`.
 */
function buildHeader(spec: ToolCardSpec, width: number): string {
  const badge = statusBadge(spec.status);
  // badge renders as 1 display column; add 1 for the trailing space.
  const badgeReserved = 2;

  const elapsedStr =
    spec.elapsed != null ? '  ' + palette.dim(formatElapsed(spec.elapsed)) : '';
  // Measure plain-text width of elapsed — formatElapsed returns unstyled text,
  // palette.dim() adds ANSI above.
  const elapsedPlain = spec.elapsed != null ? '  ' + formatElapsed(spec.elapsed) : '';
  const elapsedReserved = displayWidth(elapsedPlain);

  const batchStr = sanitizeForDisplay(spec.batchBadge ?? '');
  const batchReserved = displayWidth(stripAnsi(batchStr));

  const nameMax = Math.max(1, width - badgeReserved - elapsedReserved - batchReserved);
  const nameSanitized = sanitizeForDisplay(spec.toolName);
  const nameTruncated = truncateDisplayWidth(nameSanitized, nameMax);
  const nameStyled = palette.tool(nameTruncated);

  return `${badge} ${nameStyled}${elapsedStr}${batchStr}`;
}

/**
 * Build the diff-stat line: `+N -M  file`.
 *
 * Added columns are green, removed are red, the separator and file path are dim.
 */
function buildDiffStat(
  diff: { added: number; removed: number; file: string },
  maxWidth: number,
): string {
  const addedStr = palette.diffAdd(`+${diff.added}`);
  const removedStr = palette.diffRemove(`-${diff.removed}`);
  // Two spaces between stat and file path.
  const statPlain = `+${diff.added} -${diff.removed}  `;
  const statWidth = displayWidth(statPlain);

  const fileMax = Math.max(1, maxWidth - statWidth);
  const fileTruncated = truncateDisplayWidth(sanitizeForDisplay(diff.file), fileMax);
  const fileStyled = palette.dim(fileTruncated);

  return `${addedStr} ${removedStr}  ${fileStyled}`;
}
