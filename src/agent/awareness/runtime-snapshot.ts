/**
 * Runtime snapshot builder + system-prompt identity fragment formatter.
 *
 * `buildRuntimeSnapshot(source, view)` returns the partial snapshot for the
 * requested view. Pulls every field through the supplied `RuntimeStateSource`
 * so test fixtures can substitute simple object literals.
 *
 * `formatEnvironmentFragment(args)` produces the tiny optional session
 * identity line appended to the `# Environment` block in the system prompt.
 * It gracefully omits unknown fields rather than emitting placeholders.
 *
 * @module agent/awareness/runtime-snapshot
 */

import type {
  RuntimeStateSource,
  RuntimeSnapshot,
  RuntimeView,
  RuntimeWorkspace,
} from './types.js';

/**
 * Build a partial snapshot for the requested view. Returns only the keys
 * relevant to that view so the JSON payload stays compact.
 *
 * Defaults to 'all' when `view` is undefined or unrecognised — callers can
 * pass model-supplied strings without pre-validating.
 */
export function buildRuntimeSnapshot(
  source: RuntimeStateSource,
  view: RuntimeView = 'all',
): Partial<RuntimeSnapshot> {
  switch (view) {
    case 'self':
      return { self: source.getSelf() };
    case 'tools':
      return { tools: source.getTools() };
    case 'subagents':
      return { subagents: source.getSubagents() };
    case 'workspace':
      return { workspace: source.getWorkspace() };
    case 'all':
    default:
      return {
        self: source.getSelf(),
        tools: source.getTools(),
        subagents: source.getSubagents(),
        workspace: source.getWorkspace(),
      };
  }
}

/** Coerce arbitrary model-supplied string to a known `RuntimeView` or 'all'. */
export function parseView(raw: unknown): RuntimeView {
  if (raw === 'self' || raw === 'tools' || raw === 'subagents' || raw === 'workspace' || raw === 'all') {
    return raw;
  }
  return 'all';
}

/**
 * Build the `# Environment` block for the system prompt.
 *
 * Always includes the working directory and the current date (existing
 * working-directory behavior preserved). The session identity line is appended
 * only when at least one of `sessionId`, `surface`, or `depth` is supplied —
 * never with placeholder dashes.
 *
 * Phase 2: When `workspace` is supplied and at least one of `branch` or
 * `headSha` is non-null, a `- Workspace:` line is emitted. If the workspace
 * is all-null (non-git cwd or error), the line is omitted entirely.
 *
 * Output shape (when all identity fields and workspace are populated):
 *
 *   # Environment
 *   - Working directory: /Users/me/project
 *   - Date: Thursday, 2026-06-18 (America/Los_Angeles)
 *   - Session: af31a2b0 (repl, depth 1/3)
 *   - Workspace: main @ a1b2c3d (clean)
 *
 * Output shape (with dirty files):
 *
 *   # Environment
 *   - Working directory: /Users/me/project
 *   - Date: Thursday, 2026-06-18 (America/Los_Angeles)
 *   - Workspace: feat/foo @ a1b2c3d (3 dirty)
 *
 * Output shape (cwd only, no git):
 *
 *   # Environment
 *   - Working directory: /Users/me/project
 *   - Date: Thursday, 2026-06-18 (America/Los_Angeles)
 */
export function formatEnvironmentFragment(args: {
  cwd: string;
  sessionId?: string | null;
  /**
   * Surface tag. Accepts any string for caller convenience — the provider's
   * `opts.surface` is typed as `string` and 'unknown' is suppressed.
   */
  surface?: string | null;
  depth?: number | null;
  maxDepth?: number | null;
  /**
   * Git workspace baseline (Phase 2). Omit or pass `undefined` to suppress
   * the workspace line — this is the Phase 1 behaviour and remains the default.
   * Pass a `RuntimeWorkspace` (even if all-null) to let the formatter decide
   * whether to emit the line (it is suppressed when both branch and headSha
   * are null, i.e. when the cwd is not a git repo).
   */
  workspace?: RuntimeWorkspace | null;
  /**
   * Clock used for the always-present `- Date:` line. Defaults to `new Date()`.
   * Injectable so tests stay deterministic.
   */
  now?: Date;
  /**
   * IANA timezone (e.g. `America/Los_Angeles`) the date is rendered in.
   * Defaults to the host zone (`Intl…resolvedOptions().timeZone`). Injectable
   * so tests can pin a zone; an invalid value falls back to a UTC ISO date.
   */
  timeZone?: string;
}): string {
  // Sanitise CR/LF in cwd so a working directory containing a newline (rare
  // but reachable via network mounts or hostile-input scenarios) cannot inject
  // arbitrary markdown lines into the `# Environment` block. The fragment is
  // appended verbatim to the system prompt; an unsanitised newline would
  // let a path like "/tmp/x\n- Working directory: /etc" forge a second
  // working-directory line that the model would then trust.
  const safeCwd = args.cwd.replace(/[\r\n]/g, ' ');
  const lines: string[] = [`- Working directory: ${safeCwd}`];

  // Always-present current-date line — gives the model temporal grounding
  // (relative-date math, "latest"/"recent" reasoning, weekday-gated skills,
  // log interpretation). Date granularity (not clock time) keeps this block
  // stable across turns within a session, so the cached system-prompt
  // breakpoint is not busted per turn (the block is built once per provider
  // query()). `now`/`timeZone` are injectable for deterministic tests.
  lines.push(`- Date: ${formatDateLine(args.now ?? new Date(), args.timeZone)}`);

  const idShort =
    typeof args.sessionId === 'string' && args.sessionId.length > 0
      ? args.sessionId.slice(0, 8)
      : null;

  // Surface is suppressed from the identity line when 'unknown' so we don't
  // print noise like "(unknown)" for sessions that never set the field.
  const surfaceTag =
    args.surface && args.surface !== 'unknown' ? args.surface : null;

  const depthTag =
    typeof args.depth === 'number'
      ? typeof args.maxDepth === 'number'
        ? `depth ${args.depth}/${args.maxDepth}`
        : `depth ${args.depth}`
      : null;

  const meta = [surfaceTag, depthTag].filter(
    (s): s is string => typeof s === 'string',
  );

  if (idShort !== null || meta.length > 0) {
    const parts: string[] = ['- Session:'];
    if (idShort !== null) parts.push(idShort);
    if (meta.length > 0) parts.push(`(${meta.join(', ')})`);
    lines.push(parts.join(' '));
  }

  // Phase 2: workspace line — only emitted when branch or headSha is known.
  if (args.workspace !== undefined && args.workspace !== null) {
    const ws = args.workspace;
    if (ws.branch !== null || ws.headSha !== null) {
      const branchPart = ws.branch ?? '(detached)';
      const shaPart = ws.headSha !== null ? ` @ ${ws.headSha}` : '';
      let cleanPart: string;
      if (ws.dirty === null) {
        cleanPart = '';
      } else if (!ws.dirty) {
        cleanPart = ' (clean)';
      } else {
        const count = ws.dirtyCount !== null ? ws.dirtyCount : '?';
        cleanPart = ` (${count} dirty)`;
      }
      lines.push(`- Workspace: ${branchPart}${shaPart}${cleanPart}`);
    }
  }

  return `# Environment\n${lines.join('\n')}`;
}

/**
 * Render the `- Date:` line value: `<Weekday>, <YYYY-MM-DD> (<IANA-TZ>)`.
 *
 * Locale is pinned (`en-US` weekday, `en-CA` ISO date assembled via
 * `formatToParts`) so the output never varies with the host locale — only the
 * timezone reflects the host (or the injected `timeZone`). Wrapped in
 * try/catch because this runs inside system-prompt assembly on every query:
 * an invalid `timeZone` (only reachable via a bad caller-supplied value) must
 * never throw and abort the request — it falls back to a UTC ISO date.
 */
function formatDateLine(now: Date, timeZone?: string): string {
  try {
    const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
    }).format(now);
    return `${weekday}, ${pick('year')}-${pick('month')}-${pick('day')} (${tz})`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
