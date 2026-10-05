/**
 * Handler for the `glob` tool.
 *
 * Recursively matches files against a glob pattern within a directory.
 * Supports basic glob patterns: * (any chars within a segment), ** (zero or
 * more path segments — including zero), and ? (single char). Up to 500 results.
 *
 * By default, recursion skips node_modules/.git/.hg/.svn; naming such a
 * directory as a literal pattern segment opts back into searching it.
 *
 * @module agent/tools/handlers/glob
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';
import { fsErrorToToolResult } from './_fs-error.js';
import { isCanonicalPathReadDenied, isReadDenied } from './read-denylist.js';
import { safeRealpath } from './write-denylist.js';
import { splitAbsolutePattern } from './glob-absolute.js';
import { errorMessage } from '../../../utils/errors.js';
import { Readahead, READAHEAD_CONCURRENCY } from './glob-readahead.js';

/**
 * Directory basenames pruned from recursion by default: VCS metadata,
 * dependency stores, and `.afk-worktrees/` (managed agent worktrees: full repo
 * copies that can dwarf the repo itself and made cwd-rooted walks take
 * minutes). All are large and rarely the intended search target.
 * A caller opts back into any of these by naming it as a literal (non-glob)
 * segment of the pattern (e.g. `node_modules/**\/*.js`).
 */
const DEFAULT_PRUNE_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.afk-worktrees']);

/**
 * Extract the literal (no `*`/`?`) path segments of a glob pattern. These are
 * the directory names the caller has committed to traversing, so they must
 * never be pruned even when they collide with {@link DEFAULT_PRUNE_DIRS}.
 */
function literalPatternSegments(pattern: string): Set<string> {
  const literals = new Set<string>();
  for (const segment of pattern.replace(/\\/g, '/').split('/')) {
    if (segment !== '' && !segment.includes('*') && !segment.includes('?')) {
      literals.add(segment);
    }
  }
  return literals;
}

/**
 * Compile a glob pattern to an anchored RegExp.
 *
 * Metacharacters: `*` matches a run of non-`/` chars (one path segment); `?` a
 * single non-`/` char; `**` a globstar of ZERO or more whole path segments. A
 * globstar-plus-separator (`**\/`) compiles to an OPTIONAL prefix `(?:.*\/)?`,
 * so it collapses to zero segments: `**\/*.ts` matches a root-level `foo.ts`
 * and `src/**\/*.ts` matches `src/foo.ts`. (The old split-on-`**` matcher made
 * the adjacent separator a required literal, so it silently dropped every match
 * at the search root.) Other regex-significant chars are escaped; a non-segment
 * `**` (e.g. `a**b`) degrades to `*`. Backslashes are normalized to `/`.
 */
function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/');
  const specials = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']']);
  let re = '';
  let i = 0;
  const n = p.length;

  while (i < n) {
    const ch = p.charAt(i);

    // A run of '*': globstar (crosses '/') when it stands as a whole path
    // segment; otherwise a single-segment wildcard.
    if (ch === '*') {
      let j = i + 1;
      while (j < n && p.charAt(j) === '*') j++;
      const isGlobstar = j - i >= 2;
      const boundaryBefore = i === 0 || p.charAt(i - 1) === '/';
      const boundaryAfter = j === n || p.charAt(j) === '/';

      if (isGlobstar && boundaryBefore && boundaryAfter) {
        if (j === n) {
          // Trailing '**': the rest of the path at any depth (including none).
          re += '.*';
        } else {
          // '**/': make "segments + separator" optional so the globstar can
          // collapse to zero segments (the root-level match fix).
          re += '(?:.*/)?';
          j++; // absorb the '/' that follows the globstar
        }
      } else {
        re += '[^/]*';
      }
      i = j;
      continue;
    }

    if (ch === '?') {
      re += '[^/]';
      i++;
      continue;
    }

    re += specials.has(ch) ? `\\${ch}` : ch;
    i++;
  }

  return new RegExp(`^${re}$`);
}

/** Thrown out of the walk when the tool call's AbortSignal fires. */
class GlobAbortedError extends Error {
  constructor() {
    super('glob walk aborted');
  }
}

/**
 * Recursively collect files matching a glob pattern.
 *
 * Invariant (#2543): the walk tracks each directory's CANONICAL path beside its
 * logical one. It recurses only into `entry.isDirectory()` entries, and
 * withFileTypes Dirents report a symlink as a symlink, never as a directory, so
 * no symlink is ever traversed. The canonical path of a non-symlink child is
 * therefore exactly `join(realParent, name)`, and the denylist verdict can be
 * computed with {@link isCanonicalPathReadDenied} without a `realpathSync` per
 * entry. Symlink entries are the one case where the leaf itself dereferences,
 * so they still go through the full {@link isReadDenied}. Verdicts are
 * identical to the old per-entry `isReadDenied(entryPath)`.
 *
 * Performance (#2586): a {@link Readahead} schedules `readdir` calls for child
 * directories ahead of the walker, up to {@link READAHEAD_CONCURRENCY}
 * concurrent reads, so I/O and CPU overlap. The walker still visits entries in
 * the same depth-first order, so output under the 500-entry cap is
 * **byte-identical** to the sequential walker.
 */
async function collectMatches(dir: string, pattern: string, signal?: AbortSignal): Promise<string[]> {
  const matches: string[] = [];
  const maxResults = 500;
  // Directory names the caller explicitly named as literal pattern segments
  // are exempt from default pruning (opt back into node_modules/.git/etc.).
  const literalSegments = literalPatternSegments(pattern);
  // Compile the pattern once; the walker tests every entry against it.
  const matcher = globToRegExp(pattern);
  // Read-ahead cache: pre-schedules readdir for child directories so I/O
  // overlaps with the walker's CPU work, bounded at READAHEAD_CONCURRENCY.
  const ra = new Readahead(READAHEAD_CONCURRENCY, signal);

  /**
   * Returns true when the caller should stop (cap hit or abort).
   *
   * The inner logic mirrors the original sequential walk exactly — same
   * entry order, same denylist checks, same pruning — but replaces the
   * inline `fs.readdir` call with `ra.get()`, which resolves instantly when
   * a prior `ra.schedule()` call already completed the I/O.
   */
  async function walk(currentPath: string, realPath: string, relPath: string): Promise<boolean> {
    if (matches.length >= maxResults) {
      return true;
    }
    if (signal?.aborted) {
      throw new GlobAbortedError();
    }

    let entries;
    try {
      entries = await ra.get(currentPath);
    } catch (err) {
      if (err instanceof GlobAbortedError) throw err;
      return false; // inaccessible directory — skip silently
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) {
        return true;
      }

      const entryPath = path.join(currentPath, entry.name);
      const entryReal = path.join(realPath, entry.name);
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;

      // The requested root has already passed resolveAndContain, but a
      // readable parent may contain protected descendants. Check every
      // entry before matching or recursion so neither filenames nor file
      // contents beneath a read-denylist floor are exposed.
      const denied = entry.isSymbolicLink()
        ? isReadDenied(entryPath).denied
        : isCanonicalPathReadDenied(entryReal).denied;
      if (denied) {
        continue;
      }

      // Test if this entry matches the pattern
      if (matcher.test(entryRel)) {
        matches.push(entryRel);
      }

      // Recurse into directories to find deeper matches, but skip the
      // default-pruned dirs (DEFAULT_PRUNE_DIRS) unless the caller
      // named them literally in the pattern. The search root itself is
      // never pruned here (it is walked directly, not as a child entry).
      //
      // Invariant: withFileTypes Dirents report symlinks as symlinks, never as
      // directories, so isDirectory() is never true for a symlink — the guard
      // below enforces this assumption explicitly so a future Node change or
      // test double cannot silently violate it.
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          // This branch should be unreachable: withFileTypes Dirents cannot be
          // both isDirectory() and isSymbolicLink() simultaneously on any
          // supported Node version. If somehow reached, recursing would derive
          // a wrong canonical path (join(realPath, name) skips the symlink
          // target), so we skip safely rather than mis-classify.
          // Note: this guard does NOT replace the denylist check at the real
          // prune site (~line 182 above, DEFAULT_PRUNE_DIRS). Do not remove
          // that check thinking this guard covers it — it does not.
          continue;
        }
        if (DEFAULT_PRUNE_DIRS.has(entry.name) && !literalSegments.has(entry.name)) {
          continue;
        }
        // Schedule the child readdir ahead of the walk so I/O runs in
        // parallel with the rest of this loop. The walker will await it
        // via ra.get() when recursion actually begins.
        //
        // Intentional fast-path guard: the abort and cap checks here
        // duplicate the identical checks at the top of walk(), but they
        // avoid enqueuing a readdir that walk() would immediately discard
        // (abort) or never consume (cap hit). Reads already in flight from
        // prior schedule() calls complete normally — the consumer (walk)
        // re-checks abort/cap before acting on any result, so that is safe.
        if (!signal?.aborted && matches.length < maxResults) {
          ra.schedule(entryPath);
        }
        const shouldStop = await walk(entryPath, entryReal, entryRel);
        if (shouldStop) {
          return true;
        }
      }
    }

    return false;
  }

  try {
    // Pre-schedule the root directory read so it overlaps with any
    // synchronous setup the caller does before the first await.
    ra.schedule(dir);
    await walk(dir, safeRealpath(dir), '');
  } finally {
    ra.drain();
  }
  return matches;
}

/**
 * Input shape for the glob tool (validated at runtime).
 */
interface GlobInput {
  pattern?: unknown;
  path?: unknown;
}

/**
 * Handler for file pattern matching.
 *
 * Input shape:
 * ```ts
 * {
 *   pattern: string;     // required, glob pattern (e.g., "*.ts", "src/**\/*.js")
 *   path?: string;       // optional, base directory (default: current working directory)
 * }
 * ```
 *
 * Output: newline-separated list of matched relative paths, capped at 500 results.
 */
/**
 * Create a glob handler closed over a session-specific default base path.
 *
 * When the model omits `path` from the tool input, the handler falls back
 * to `cwd` (typically the session's `config.cwd`). When `cwd` is undefined,
 * the legacy `process.cwd()` default is used.
 *
 * The dispatcher rebuilds per query, so a mid-session cwd mutation via
 * `AgentSession.setCwd()` propagates on the next turn.
 */
export function createGlobHandler(cwd?: string): ToolHandler {
  return async (input: unknown, signal: AbortSignal, context?: ToolHandlerContext) => {
  // Validate input shape
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected an object', isError: true };
  }

  const obj = input as GlobInput;
  const rawPattern = obj.pattern;
  // Effective cwd priority:
  // 1. context?.resolveBase — permission-system anchor (from dispatcher)
  // 2. factory-level cwd — session worktree isolation
  // 3. process.cwd() fallback
  const explicitPath = obj.path !== undefined && obj.path !== null;
  let rawPath = obj.path ?? context?.resolveBase ?? cwd ?? process.cwd();

  // Validate required field
  if (typeof rawPattern !== 'string') {
    return { content: 'Invalid input: pattern must be a string', isError: true };
  }

  if (rawPattern.trim() === '') {
    return { content: 'Invalid input: pattern cannot be empty', isError: true };
  }

  // An absolute pattern can never match the walker's relative entries; walk
  // from its literal prefix instead (still containment-checked below) and
  // report absolute paths so results stay unambiguous.
  const absolute = splitAbsolutePattern(rawPattern);
  const pattern = absolute ? absolute.pattern : rawPattern;
  if (absolute) {
    if (explicitPath) {
      return {
        content: `Invalid input: absolute pattern '${rawPattern}' conflicts with explicit path argument; omit path or use a relative pattern`,
        isError: true,
      };
    }
    rawPath = absolute.base;
  }

  // Validate optional field
  if (typeof rawPath !== 'string') {
    return { content: 'Invalid input: path must be a string', isError: true };
  }

  let basePath: string;
  try {
    basePath = resolveAndContain(rawPath, context, 'read');
  } catch (err) {
    return { content: errorMessage(err), isError: true };
  }

  try {
    // Verify the base path exists and is a directory
    const stat = await fs.stat(basePath);
    if (!stat.isDirectory()) {
      return {
        content: `Invalid input: path is not a directory: ${basePath}`,
        isError: true,
      };
    }

    // Collect matching files
    const relMatches = await collectMatches(basePath, pattern, signal);
    const matches = absolute ? relMatches.map((m) => path.join(basePath, m)) : relMatches;

    // No matches
    if (matches.length === 0) {
      return {
        content: `No files matched pattern '${rawPattern}' in ${basePath}`,
      };
    }

    // Return matches, noting if capped
    let output = matches.join('\n');
    if (matches.length >= 500) {
      output += '\n[results capped at 500 entries]';
    }

    return { content: output };
  } catch (err) {
    // Same wording as the grep handler's abort result.
    if (err instanceof GlobAbortedError) {
      return { content: 'Search aborted', isError: true };
    }
    // Handle specific error types
    const known = fsErrorToToolResult(err, basePath, 'Path');
    if (known) return known;
    if (err instanceof Error) {
      return { content: `Error scanning directory: ${err.message}`, isError: true };
    }
    return { content: 'Unknown error scanning directory', isError: true };
  }
  };
}

/**
 * Default glob handler with no session cwd. Falls back to `process.cwd()`
 * when the model omits an explicit `path`. Retained for backward compat
 * (tests, external plugins). Production sessions use {@link createGlobHandler}.
 */
export const globHandler: ToolHandler = createGlobHandler();
