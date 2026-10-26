/**
 * /diff — show inline git working-tree diffs in the REPL.
 *
 * Subcommands / flags:
 *
 *   /diff              — all uncommitted changes (staged + unstaged), git diff HEAD
 *   /diff --staged     — staged changes only (git diff --cached)
 *   /diff <file>       — changes for a specific path (git diff HEAD -- <file>)
 *   /diff --staged <file> — staged changes for a specific path
 *
 * Output is colorized unified diff using the house palette (diffAdd / diffRemove /
 * diffHunk) so it respects the active theme and TTY detection. Rendering is capped
 * at MAX_DIFF_BODY_LINES body lines per call to avoid flooding scrollback on large
 * working trees; the stat header always survives.
 *
 * @module cli/slash/commands/diff
 */

import { execFileSync } from 'node:child_process';
import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';
import { env } from '../../../config/env.js';
import type { SlashCommand } from '../types.js';

/**
 * Maximum diff body lines rendered before eliding. Enough to show a typical
 * feature-sized change without overwhelming the terminal. The stat header
 * ("+N -M across K hunks") is always rendered — it doesn't count against this.
 */
const MAX_DIFF_BODY_LINES = 60;

/** Parse raw unified-diff text (from git) into a structured hunk list. */
interface RawHunk {
  header: string;   // "@@ -a,b +c,d @@" line
  lines: Array<{ kind: '+' | '-' | ' '; text: string }>;
}

interface ParsedDiff {
  filePairs: Array<{ from: string; to: string; metadata: string[]; hunks: RawHunk[] }>;
  totalAdded: number;
  totalRemoved: number;
}

function parseDiff(raw: string): ParsedDiff {
  const lines = raw.split('\n');
  const filePairs: ParsedDiff['filePairs'] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  let currentFrom = '';
  let currentTo = '';
  let currentHunks: RawHunk[] = [];
  let currentMetadata: string[] = [];
  let currentHunk: RawHunk | null = null;

  const flushFile = (): void => {
    if (currentHunk) currentHunks.push(currentHunk);
    if (currentFrom || currentTo) {
      filePairs.push({ from: currentFrom, to: currentTo, metadata: currentMetadata, hunks: currentHunks });
    }
    currentFrom = '';
    currentTo = '';
    currentHunks = [];
    currentMetadata = [];
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      currentFrom = match?.[1] ?? line.slice('diff --git '.length);
      currentTo = match?.[2] ?? currentFrom;
    } else if (line.startsWith('--- ')) {
      // "--- a/path/to/file" or "--- /dev/null"
      currentFrom = line.slice(4).replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      // "+++ b/path/to/file" or "+++ /dev/null"
      currentTo = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('@@ ')) {
      if (currentHunk) currentHunks.push(currentHunk);
      // Extract the @@ header — everything up to (and including) the second @@
      const match = /^(@@ [^@]+ @@)/.exec(line);
      currentHunk = { header: match?.[1] ?? line, lines: [] };
    } else if (!currentHunk && line !== '') {
      currentMetadata.push(line);
    } else if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ kind: '+', text: line.slice(1) });
        totalAdded++;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ kind: '-', text: line.slice(1) });
        totalRemoved++;
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({ kind: ' ', text: line.slice(1) });
      }
      // Binary file notices, "no newline at end", etc. are intentionally skipped.
    }
  }
  flushFile();

  return { filePairs, totalAdded, totalRemoved };
}

/**
 * Render a parsed diff to the writer with palette coloring.
 *
 * Ordering constraint (from ordered-operation convention): the stat header is
 * emitted before any body lines so even a truncated render is informative.
 */
function renderParsedDiff(
  out: import('../types.js').Writer,
  parsed: ParsedDiff,
): void {
  if (parsed.filePairs.length === 0) {
    out.info('No changes.');
    return;
  }

  // Stat header — always first, survives body truncation.
  const adds = palette.diffAdd(`+${parsed.totalAdded}`);
  const dels = palette.diffRemove(`-${parsed.totalRemoved}`);
  const fileCount = parsed.filePairs.length;
  const fileSuffix = palette.dim(`across ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  out.line(`  ${adds} ${dels}  ${fileSuffix}`);
  out.line();

  let bodyLines = 0;
  let truncated = false;
  const configuredLimit = Number.parseInt(env.AFK_DIFF_LINES ?? '', 10);
  const bodyLimit = configuredLimit === 0
    ? Number.POSITIVE_INFINITY
    : configuredLimit > 0 ? configuredLimit : MAX_DIFF_BODY_LINES;
  const totalBodyLines = parsed.filePairs.reduce(
    (total, file) => total + file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
    0,
  );

  outer: for (const fp of parsed.filePairs) {
    // Normalize display name: deleted → from path, new → to path, renamed → from→to
    const fromName = sanitizeForDisplay(fp.from === '/dev/null' ? '' : fp.from);
    const toName = sanitizeForDisplay(fp.to === '/dev/null' ? '' : fp.to);
    const label =
      fp.from === '/dev/null' ? palette.diffAdd(toName) :
      fp.to === '/dev/null' ? palette.diffRemove(fromName) :
      fromName !== toName
        ? `${palette.dim(fromName)} → ${palette.warning(toName)}`
        : palette.warning(fromName);
    out.line(palette.bold(`  ${label}`));

    for (const metadata of fp.metadata) {
      out.line(palette.dim(`    ${sanitizeForDisplay(metadata)}`));
    }

    for (const hunk of fp.hunks) {
      // Hunk headers don't count against the body-line cap.
      out.line(palette.diffHunk(`    ${sanitizeForDisplay(hunk.header)}`));

      for (const dl of hunk.lines) {
        if (bodyLines >= bodyLimit) {
          truncated = true;
          break outer;
        }
        const prefix = dl.kind === '+' ? '+ ' : dl.kind === '-' ? '- ' : '  ';
        const text = `    ${prefix}${sanitizeForDisplay(dl.text)}`;
        if (dl.kind === '+') out.line(palette.diffAdd(text));
        else if (dl.kind === '-') out.line(palette.diffRemove(text));
        else out.line(palette.dim(text));
        bodyLines++;
      }
    }

    out.line();
  }

  if (truncated) {
    out.line(palette.dim(`  … ${totalBodyLines - bodyLines} more diff lines (set AFK_DIFF_LINES=0 or pipe to git diff for full output)`));
  }
}

/**
 * Run `git diff` with the provided arguments in cwd and return stdout.
 * Returns null when git exits non-zero (e.g. not a repo) with a message.
 */
function runGitDiff(
  args: string[],
  cwd: string,
): { ok: true; stdout: string } | { ok: false; message: string } {
  try {
    const stdout = execFileSync('git', ['diff', ...args], {
      cwd,
      encoding: 'utf-8',
      // git diff exits 0 when there are diffs, 1 is not an error here —
      // execSync throws on any non-zero exit; catch and inspect below.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
    // git diff --exit-code exits 1 when changes exist, but we do NOT pass
    // --exit-code, so any non-zero exit here is a real error (no repo, etc.)
    const detail = sanitizeForDisplay((e.stderr ?? '').trim() || (e.message ?? ''));
    return { ok: false, message: detail || 'git diff failed' };
  }
}

/** Parse the /diff args string into a structured options object. */
function parseArgs(raw: string): { staged: boolean; file: string | null } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  let staged = false;
  const fileParts: string[] = [];

  for (const p of parts) {
    if (p === '--staged' || p === '--cached') {
      staged = true;
    } else if (!p.startsWith('-')) {
      fileParts.push(p);
    }
  }

  return {
    staged,
    file: fileParts.length > 0 ? fileParts.join(' ') : null,
  };
}

export const diffCmd: SlashCommand = {
  name: '/diff',
  summary: 'Show current git working-tree diff inline',
  usage: '/diff [--staged] [<file>]',
  hint: 'Shows uncommitted changes colorized in the REPL. `--staged` for only staged changes; pass a path to scope to one file.',
  async handler(ctx, args) {
    const { out, stats } = ctx;
    const cwd = stats.cwd ?? process.cwd();
    const { staged, file } = parseArgs(args);

    // Build git diff argument list.
    const gitArgs: string[] = [];
    if (staged) {
      gitArgs.push('--cached');
    } else {
      // Without --cached, `git diff HEAD` shows all uncommitted changes
      // (both staged and unstaged) in a single unified view.
      gitArgs.push('HEAD');
    }
    if (file) {
      gitArgs.push('--', file);
    }

    const result = runGitDiff(gitArgs, cwd);
    if (!result.ok) {
      out.error(`git diff failed: ${result.message}`);
      return 'continue';
    }

    if (!result.stdout.trim()) {
      const safeFile = file ? sanitizeForDisplay(file) : '';
      const scope = safeFile ? ` for ${palette.warning(safeFile)}` : '';
      const modeNote = staged ? ' (staged)' : '';
      out.info(`No changes${modeNote}${scope}.`);
      return 'continue';
    }

    // Header label
    out.line();
    const modeLabel = staged ? 'Staged changes' : 'Uncommitted changes';
    const fileLabel = file ? `  ${palette.dim(`— ${sanitizeForDisplay(file)}`)}` : '';
    out.line(palette.bold(`${modeLabel}${fileLabel}`));
    out.line(divider());

    const parsed = parseDiff(result.stdout);
    renderParsedDiff(out, parsed);

    return 'continue';
  },
};
