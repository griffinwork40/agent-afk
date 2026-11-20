/**
 * Sensitive write targets inside the session directory (profile section 6).
 * A write to one of these can change what a later, auto-allowed call executes
 * or reveals, so it is asked every time, never offered "Always allow" and never
 * covered by a remembered grant. Pure and lexical, like acp.permission.paths.
 *
 * @module cli/commands/acp.permission.sensitive
 */
import path from 'node:path';
import type { PathFlavor } from './acp.permission.paths.js';

// Contract: names are matched per path segment, ASCII case folded on every
// flavour (macOS and Windows file systems are case-insensitive by default).
// Under the win32 flavour a segment also loses trailing dots and spaces and any
// `:stream` suffix (NTFS ignores or redirects them), and the 8.3 short names
// `GIT~N` / `GITATT~N` / `GITMOD~N` count too. Sources of the names:
//  - git: any `.git` segment (the directory, a nested repository's, or a
//    regular `.git` file that points at another git directory), and
//    `.gitattributes` / `.gitmodules` at any depth (filter drivers, submodules).
//  - project MCP config: `<cwd>/.mcp.json` (agent/mcp/config-loader.ts
//    getProjectMcpConfigPath; its servers are spawned).
//  - project hook config: `<cwd>/afk.config.json` and `<cwd>/.afk/settings.json`
//    (agent/hooks/config-loader.ts loadHooksConfig project-local layers).
//  - `<cwd>/.afk/worktree-setup.json` (agent/worktree/worktree-setup.ts runs
//    its commands in new worktrees).
// The project files are matched at any depth, since a child may run elsewhere.
export const GIT_MARKER = '(git internals)';
export const CONFIG_MARKER = '(project config that runs commands)';

const GIT_FILES = new Set(['.gitattributes', '.gitmodules']);
const CONFIG_FILES = new Set(['.mcp.json', 'afk.config.json']);
const AFK_CONFIG_FILES = new Set(['settings.json', 'worktree-setup.json']);
const SHORT_GIT = /^git(?:att|mod)?~\d+$/;

function fold(segment: string, p: PathFlavor): string {
  const lower = segment.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (p.sep !== '\\') return lower;
  return lower.replace(/:.*$/, '').replace(/[. ]+$/, '');
}

function segments(value: string, p: PathFlavor): string[] {
  return value.split(/[\\/]/).filter((s) => s.length > 0).map((s) => fold(s, p));
}

/** The marker for one write target, or '' when it is not sensitive. */
export function sensitiveMarker(raw: string, base: string | undefined, p: PathFlavor = path): string {
  // Both the raw value (any `.git` segment, even one a `..` later leaves) and
  // the resolved target are checked; either one sensitive is enough.
  const lists = [segments(raw, p)];
  if (base !== undefined && p.isAbsolute(base)) lists.push(segments(p.resolve(base, raw), p));
  const isGit = (s: string): boolean => s === '.git' || GIT_FILES.has(s) || (p.sep === '\\' && SHORT_GIT.test(s));
  if (lists.some((segs) => segs.some(isGit))) return GIT_MARKER;
  for (const segs of lists) {
    const last = segs[segs.length - 1] ?? '';
    const parent = segs[segs.length - 2] ?? '';
    if (CONFIG_FILES.has(last) || (parent === '.afk' && AFK_CONFIG_FILES.has(last))) return CONFIG_MARKER;
  }
  return '';
}

/** The write targets of a file-writing tool call; empty for other tools. */
function writeTargets(toolName: string, input: Record<string, unknown>): unknown[] {
  if (toolName === 'write_file' || toolName === 'edit_file') return [input['file_path']];
  if (toolName === 'patch_apply' && Array.isArray(input['changes'])) {
    return input['changes'].map((c: unknown) => (typeof c === 'object' && c !== null ? (c as Record<string, unknown>)['path'] : undefined));
  }
  return [];
}

/**
 * Distinct markers for every sensitive write target of this call, in a stable
 * order (git first). Non-string targets are left to the grant and outside checks.
 */
export function sensitiveMarkers(
  toolName: string, input: Record<string, unknown>, base: string | undefined, p: PathFlavor = path,
): string[] {
  const found = new Set<string>();
  for (const raw of writeTargets(toolName, input)) {
    if (typeof raw === 'string' && raw.length > 0) {
      const m = sensitiveMarker(raw.replace(/\u0000/g, ''), base, p);
      if (m !== '') found.add(m);
    }
  }
  return [GIT_MARKER, CONFIG_MARKER].filter((m) => found.has(m));
}
