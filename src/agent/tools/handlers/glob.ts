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

/**
 * Directory basenames pruned from recursion by default: VCS metadata and
 * dependency stores that are large and rarely the intended search target.
 * A caller opts back into any of these by naming it as a literal (non-glob)
 * segment of the pattern (e.g. `node_modules/**\/*.js`).
 */
const DEFAULT_PRUNE_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

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

/**
 * Recursively collect files matching a glob pattern.
 */
async function collectMatches(dir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  const maxResults = 500;
  // Directory names the caller explicitly named as literal pattern segments
  // are exempt from default pruning (opt back into node_modules/.git/etc.).
  const literalSegments = literalPatternSegments(pattern);
  // Compile the pattern once; the walker tests every entry against it.
  const matcher = globToRegExp(pattern);

  async function walk(currentPath: string, relPath: string): Promise<boolean> {
    if (matches.length >= maxResults) {
      return true;
    }

    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        if (matches.length >= maxResults) {
          return true;
        }

        const entryPath = path.join(currentPath, entry.name);
        const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;

        // Test if this entry matches the pattern
        if (matcher.test(entryRel)) {
          matches.push(entryRel);
        }

        // Recurse into directories to find deeper matches, but skip the
        // default-pruned dirs (node_modules/.git/.hg/.svn) unless the caller
        // named them literally in the pattern. The search root itself is
        // never pruned here (it is walked directly, not as a child entry).
        if (entry.isDirectory()) {
          if (DEFAULT_PRUNE_DIRS.has(entry.name) && !literalSegments.has(entry.name)) {
            continue;
          }
          const shouldStop = await walk(entryPath, entryRel);
          if (shouldStop) {
            return true;
          }
        }
      }
    } catch {
      // Silently skip inaccessible directories
    }

    return false;
  }

  await walk(dir, '');
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
  return async (input: unknown, _signal: AbortSignal, context?: ToolHandlerContext) => {
  // Validate input shape
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected an object', isError: true };
  }

  const obj = input as GlobInput;
  const pattern = obj.pattern;
  // Effective cwd priority:
  // 1. context?.resolveBase — permission-system anchor (from dispatcher)
  // 2. context?.cwd — per-call back-compat alias
  // 3. factory-level cwd — session worktree isolation
  // 4. process.cwd() fallback
  const rawPath = obj.path ?? context?.resolveBase ?? context?.cwd ?? cwd ?? process.cwd();

  // Validate required field
  if (typeof pattern !== 'string') {
    return { content: 'Invalid input: pattern must be a string', isError: true };
  }

  if (pattern.trim() === '') {
    return { content: 'Invalid input: pattern cannot be empty', isError: true };
  }

  // Validate optional field
  if (typeof rawPath !== 'string') {
    return { content: 'Invalid input: path must be a string', isError: true };
  }

  let basePath: string;
  try {
    basePath = resolveAndContain(rawPath, context, 'read');
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
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
    const matches = await collectMatches(basePath, pattern);

    // No matches
    if (matches.length === 0) {
      return {
        content: `No files matched pattern '${pattern}' in ${basePath}`,
      };
    }

    // Return matches, noting if capped
    let output = matches.join('\n');
    if (matches.length >= 500) {
      output += '\n[results capped at 500 entries]';
    }

    return { content: output };
  } catch (err) {
    // Handle specific error types
    if (err instanceof Error) {
      if ('code' in err && err.code === 'ENOENT') {
        return { content: `Path not found: ${basePath}`, isError: true };
      }
      if ('code' in err && err.code === 'EACCES') {
        return { content: `Permission denied: ${basePath}`, isError: true };
      }
      // Generic error
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
