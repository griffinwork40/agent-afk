/**
 * Handler for the `glob` tool.
 *
 * Recursively matches files against a glob pattern within a directory.
 * Supports basic glob patterns: * (any filename chars), ** (any path segment),
 * and ? (single char). Returns up to 500 results.
 *
 * @module agent/tools/handlers/glob
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';

/**
 * Check if a relative path matches a glob pattern.
 * Supports:
 *   - * matches any characters except /
 *   - ** matches zero or more path segments (any directories)
 *   - ? matches a single character except /
 */
function matchesGlobPattern(relPath: string, pattern: string): boolean {
  // Normalize paths to use forward slashes
  const normalizedPath = relPath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Handle ** pattern which can match multiple directory levels
  if (normalizedPattern.includes('**')) {
    const patternParts = normalizedPattern.split('**');
    let currentPos = 0;

    for (let i = 0; i < patternParts.length; i++) {
      const part = patternParts[i] ?? '';

      // Convert the non-** part to a regex
      const partRegex = convertGlobPartToRegex(part);

      if (i === 0) {
        // First part must match from the beginning
        const match = normalizedPath.match(new RegExp(`^${partRegex}`));
        if (!match) return false;
        currentPos = match[0].length;
      } else if (i === patternParts.length - 1) {
        // Last part must match to the end
        const regex = new RegExp(`${partRegex}$`);
        if (!normalizedPath.slice(currentPos).match(regex)) return false;
      } else {
        // Middle parts must match somewhere after the current position
        const regex = new RegExp(partRegex);
        const match = normalizedPath.slice(currentPos).match(regex);
        if (!match) return false;
        const matchIndex = match.index ?? 0;
        currentPos += matchIndex + match[0].length;
      }
    }
    return true;
  }

  // Simple pattern without **
  const regex = new RegExp(`^${convertGlobPartToRegex(normalizedPattern)}$`);
  return regex.test(normalizedPath);
}

/**
 * Convert a non-** glob pattern segment to regex.
 */
function convertGlobPartToRegex(part: string): string {
  return part
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}

/**
 * Recursively collect files matching a glob pattern.
 */
async function collectMatches(dir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  const maxResults = 500;

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
        if (matchesGlobPattern(entryRel, pattern)) {
          matches.push(entryRel);
        }

        // Always recurse into directories to find deeper matches
        if (entry.isDirectory()) {
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
