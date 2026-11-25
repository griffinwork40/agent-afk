/**
 * Display helpers extracted from the ACP permission files so that
 * acp.tool-kind.ts (and future display-only consumers) do not import from the
 * permission layer. Pure and lexical — no filesystem access, no policy decisions.
 *
 * Sources:
 *   acp.permission.labels   → delegationSuffix
 *   acp.permission.paths    → outsidePaths (+ all transitive helpers)
 *   acp.permission.sensitive → sensitiveMarkers (+ all transitive helpers)
 *
 * @module cli/commands/acp.tool-display
 */
import path from 'node:path';
import { gitReadReachesOutside } from './acp.tool-display.git.js';

// ---------------------------------------------------------------------------
// Shared type
// ---------------------------------------------------------------------------

/** The path flavour a decision uses; the platform's by default, `path.win32`/`path.posix` in tests. */
export type PathFlavor = typeof path.posix;

// ---------------------------------------------------------------------------
// Delegation suffix  (from acp.permission.labels)
// ---------------------------------------------------------------------------

const DELEGATION_TOOLS = new Set(['agent', 'skill', 'compose', 'remote_agent']);
/** In-process children are asked per tool call (D9). */
const DELEGATION_SUFFIX = ' (each subagent tool call is asked separately)';
/** remote_agent runs elsewhere; this session's prompts do not cover it (D9). */
const REMOTE_SUFFIX = ' (runs on another machine; its actions are NOT asked in this session)';

export function delegationSuffix(toolName: string): string {
  if (toolName === 'remote_agent') return REMOTE_SUFFIX;
  return DELEGATION_TOOLS.has(toolName) ? DELEGATION_SUFFIX : '';
}

// ---------------------------------------------------------------------------
// Outside-path helpers  (from acp.permission.paths)
// ---------------------------------------------------------------------------

const PATH_KEYS = [
  'file_path', 'filePath', 'path', 'paths', 'cwd', 'dir', 'directory', 'root', 'file', 'files',
  'target', 'source', 'destination', 'dest', 'output', 'base_dir', 'workdir',
  'input_path', 'output_path', 'image_paths', 'repo',
];
/** git options that relocate the repository or write a file; the handler rejects them too. */
const GIT_RELOCATE = /^(?:-C|--git-dir|--work-tree|--namespace|--exec-path|--output|-o)(?:=|$)/;
const GLOB_META = /[*?{}[\]]/;
const BRACE_ABSOLUTE_ARM = /[{,]\s*(?:[\\/~]|[A-Za-z]:)/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ASCII_UPPER = /[A-Z]/g;

function win32SamePrefix(root: string, abs: string): boolean {
  const fold = (s: string): string => s.replace(ASCII_UPPER, (c) => c.toLowerCase());
  return fold(`${abs}\\`).startsWith(fold(root.endsWith('\\') ? root : `${root}\\`));
}

/** True when `abs` is the root itself or lexically below it (Windows-safe, no raw prefix checks). */
export function isContained(root: string, abs: string, p: PathFlavor = path): boolean {
  const r = p.resolve(root);
  const a = p.resolve(abs);
  const rel = p.relative(r, a);
  if (p.isAbsolute(rel)) return false;
  const segments = rel === '' ? [] : rel.split(/[\\/]/);
  if (segments[0] === '..') return false;
  if (p.sep === '/') return true;
  return !segments.some((s) => /[. ]$/.test(s)) && win32SamePrefix(r, a);
}

export function driveless(raw: string, p: PathFlavor = path): boolean {
  return p.sep === '\\' && /^[\\/](?![\\/])/.test(raw);
}

function usableCwd(cwd: string | undefined, p: PathFlavor): cwd is string {
  return typeof cwd === 'string' && cwd.length > 0 && !cwd.includes('\u0000') && p.isAbsolute(cwd);
}

function scanValue(raw: unknown, base: string | undefined, root: string | undefined, out: string[], p: PathFlavor): void {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\u0000')) {
    out.push(typeof raw === 'string' ? raw.replace(/\u0000/g, '') || '(invalid path)' : '(invalid path)');
    return;
  }
  if (driveless(raw, p)) { out.push(raw); return; }
  if (raw.startsWith('~') || raw.startsWith(':') || base === undefined || root === undefined) {
    out.push(base !== undefined && !raw.startsWith('~') && !raw.startsWith(':') ? p.resolve(base, raw) : raw);
    return;
  }
  const abs = p.resolve(base, raw);
  if (!isContained(root, abs, p)) out.push(abs);
}

function scanKey(value: unknown, base: string | undefined, root: string | undefined, out: string[], p: PathFlavor): void {
  if (Array.isArray(value)) {
    for (const item of value) scanValue(item, base, root, out, p);
    return;
  }
  scanValue(value, base, root, out, p);
}

function scanGlobPattern(pattern: unknown, base: string | undefined, root: string | undefined, out: string[], p: PathFlavor): void {
  if (pattern === undefined) return;
  if (typeof pattern !== 'string' || base === undefined || root === undefined) {
    out.push(typeof pattern === 'string' ? pattern : '(invalid pattern)');
    return;
  }
  const segments = pattern.split(/[\\/]/);
  const meta = segments.findIndex((s) => GLOB_META.test(s));
  const literal = meta < 0 ? segments : segments.slice(0, meta);
  const rest = meta < 0 ? [] : segments.slice(meta);
  const prefix = literal.join('/');
  const start = p.isAbsolute(pattern) && !p.isAbsolute(prefix) ? `${prefix}/` : prefix;
  if (start.startsWith('~') || driveless(start, p)) { out.push(pattern); return; }
  const abs = p.resolve(base, start === '' ? '.' : start);
  const inside = isContained(root, abs, p);
  if (!inside || rest.some((s) => s.includes('..')) || BRACE_ABSOLUTE_ARM.test(pattern)) {
    out.push(inside ? pattern : abs);
  }
}

/** True when a delegation input relocates its children away from the session cwd. */
export function relocatesChildren(
  toolName: string, input: Record<string, unknown>, cwd: string | undefined, p: PathFlavor = path,
): boolean {
  const isolates = (v: unknown): boolean => v !== undefined && v !== 'none';
  if (isolates(input['isolation'])) return true;
  if (input['continuation_chain_id'] !== undefined) return true;
  if (Array.isArray(input['nodes']) && input['nodes'].some((n) => !isRecord(n) || isolates(n['isolation']))) return true;
  if (input['cwd'] !== undefined && !(usableCwd(cwd, p) && typeof input['cwd'] === 'string'
    && !driveless(input['cwd'], p) && p.resolve(cwd, input['cwd']) === p.resolve(cwd))) return true;
  return toolName === 'compose' && Array.isArray(input['nodes']) && input['nodes'].some((n) => isRecord(n) && n['cwd'] !== undefined);
}

/** A call whose effective target depends on the caller's own cwd: no path argument, or a relative one. */
export function dependsOnCallerCwd(input: Record<string, unknown>, p: PathFlavor = path): boolean {
  const present = PATH_KEYS.filter((k) => input[k] !== undefined);
  if (present.length === 0) return true;
  return present.some((k) => {
    const v = input[k];
    return (Array.isArray(v) ? v : [v]).some((x) => typeof x !== 'string' || !p.isAbsolute(x));
  });
}

/**
 * Every target of this call that is not lexically inside `cwd`, as absolute
 * paths where resolvable. Empty means no argument leaves the session directory.
 */
export function outsidePaths(
  toolName: string, input: Record<string, unknown>, cwd: string | undefined, callerCwd?: string,
  p: PathFlavor = path,
): string[] {
  const out: string[] = [];
  const root = usableCwd(cwd, p) ? p.resolve(cwd) : undefined;
  const caller = callerCwd === undefined ? root : usableCwd(callerCwd, p) ? p.resolve(callerCwd) : undefined;
  let base = caller;
  if (toolName === 'glob' && input['path'] !== undefined) {
    const g = input['path'];
    base = caller !== undefined && typeof g === 'string' && g.length > 0 && !g.includes('\u0000') && !g.startsWith('~')
      && !driveless(g, p) ? p.resolve(caller, g) : undefined;
  }
  for (const key of PATH_KEYS) {
    if (input[key] !== undefined) scanKey(input[key], caller, root, out, p);
  }
  if (toolName === 'glob') scanGlobPattern(input['pattern'], base, root, out, p);
  if (toolName === 'patch_apply' && Array.isArray(input['changes'])) {
    for (const change of input['changes']) scanValue(isRecord(change) ? change['path'] : undefined, caller, root, out, p);
  }
  if (toolName === 'compose' && Array.isArray(input['nodes'])) {
    for (const node of input['nodes']) if (isRecord(node) && node['cwd'] !== undefined) scanValue(node['cwd'], caller, root, out, p);
  }
  if (toolName === 'git_read' && input['args'] !== undefined) {
    const args = input['args'];
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || GIT_RELOCATE.test(a))) {
      out.push('(git repository relocation)');
    }
  }
  if (caller !== undefined && root !== undefined && !isContained(root, caller, p) && dependsOnCallerCwd(input, p)) out.push(caller);
  if (toolName === 'git_read' && gitReadReachesOutside(input, caller)) out.push('(git content outside the session directory)');
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Sensitive write-target markers  (from acp.permission.sensitive)
// ---------------------------------------------------------------------------

export const GIT_MARKER = '(git internals)';
export const CONFIG_MARKER = '(project config that runs commands)';
export const AGENT_MARKER = '(agent instructions or definitions)';

const GIT_FILES = new Set(['.gitattributes', '.gitmodules']);
const CONFIG_FILES = new Set(['.mcp.json', 'afk.config.json', '.envrc']);
const CONFIG_DIRS = new Set(['.husky', '.vscode', '.github', '.devcontainer']);
const SHORT_CONFIG = /^(?:husky|vscode|github|devcon)~\d+$/;
const SHORT_ENVRC = /^envrc~\d+$/;
const AFK_CONFIG_FILES = new Set(['settings.json', 'worktree-setup.json']);
const SHORT_GIT = /^git(?:att|mod)?~\d+$/;
const INSTRUCTION_FILES = new Set(['afk.md']);
const SHORT_AFK = /^afk~\d+$/;
const SHORT_CLAUDE = /^claude~\d+$/;

function fold(segment: string, p: PathFlavor): string {
  const lower = segment.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (p.sep !== '\\') return lower;
  return lower.replace(/:.*$/, '').replace(/[. ]+$/, '');
}

function segmentList(value: string, p: PathFlavor): string[] {
  return value.split(/[\\/]/).filter((s) => s.length > 0).map((s) => fold(s, p));
}

/** The marker for one write target, or '' when it is not sensitive. */
export function sensitiveMarker(raw: string, base: string | undefined, p: PathFlavor = path): string {
  const lists = [segmentList(raw, p)];
  if (base !== undefined && p.isAbsolute(base)) lists.push(segmentList(p.resolve(base, raw), p));
  const isGit = (s: string): boolean => s === '.git' || GIT_FILES.has(s) || (p.sep === '\\' && SHORT_GIT.test(s));
  if (lists.some((segs) => segs.some(isGit))) return GIT_MARKER;
  const isConfigSegment = (s: string): boolean => CONFIG_DIRS.has(s) || (p.sep === '\\' && SHORT_CONFIG.test(s));
  for (const segs of lists) {
    const last = segs[segs.length - 1] ?? '';
    const parent = segs[segs.length - 2] ?? '';
    if (CONFIG_FILES.has(last) || (parent === '.afk' && AFK_CONFIG_FILES.has(last))) return CONFIG_MARKER;
    if (segs.some(isConfigSegment) || (p.sep === '\\' && SHORT_ENVRC.test(last))) return CONFIG_MARKER;
  }
  const isAfk = (s: string): boolean => s === '.afk' || (p.sep === '\\' && SHORT_AFK.test(s));
  const isClaude = (s: string): boolean => s === '.claude' || (p.sep === '\\' && SHORT_CLAUDE.test(s));
  const isAgent = (segs: string[]): boolean =>
    segs.some(isAfk) || segs.some(isClaude) || INSTRUCTION_FILES.has(segs[segs.length - 1] ?? '');
  return lists.some(isAgent) ? AGENT_MARKER : '';
}

function writeTargets(toolName: string, input: Record<string, unknown>): unknown[] {
  if (toolName === 'write_file' || toolName === 'edit_file') return [input['file_path']];
  if (toolName === 'patch_apply' && Array.isArray(input['changes'])) {
    return input['changes'].map((c: unknown) => (typeof c === 'object' && c !== null ? (c as Record<string, unknown>)['path'] : undefined));
  }
  return [];
}

/**
 * Distinct markers for every sensitive write target of this call, in a stable
 * order (git, then config, then instructions).
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
  return [GIT_MARKER, CONFIG_MARKER, AGENT_MARKER].filter((m) => found.has(m));
}
