/**
 * Lexical outside-the-session-directory scan for the ACP permission policy
 * (profile section 6, decision D10). Pure: no filesystem access, so a symbolic
 * link inside the cwd that points outside it is NOT detected (documented).
 *
 * @module cli/commands/acp.permission.paths
 */
import path from 'node:path';
import { gitReadReachesOutside } from './acp.permission.git.js';

// Contract: every argument a tool could treat as a filesystem location is
// scanned, under generic names as well as the obvious ones, so a new path
// argument on an auto-allowed tool fails closed (asked), never silently allowed.
// A value that cannot be resolved lexically (wrong type, NUL, `~`, pathspec
// magic, a missing or relative session cwd) is reported as outside.
const PATH_KEYS = [
  'file_path', 'filePath', 'path', 'paths', 'cwd', 'dir', 'directory', 'root', 'file', 'files',
  'target', 'source', 'destination', 'dest', 'output', 'base_dir', 'workdir',
  // Tool-specific locations read from the handlers (D18): model_complete
  // `input_path`, image_generate and image_edit `output_path`, image_edit
  // `image_paths`, worktree `repo`. Display and the outside check only:
  // remembered grants never rely on this list (acp.permission.grants).
  'input_path', 'output_path', 'image_paths', 'repo',
];
/** git options that relocate the repository or write a file; the handler rejects them too. */
const GIT_RELOCATE = /^(?:-C|--git-dir|--work-tree|--namespace|--exec-path|--output|-o)(?:=|$)/;
const GLOB_META = /[*?{}[\]]/;
const BRACE_ABSOLUTE_ARM = /[{,]\s*(?:[\\/~]|[A-Za-z]:)/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when `abs` is the root itself or lexically below it (Windows-safe, no prefix checks). */
export function isContained(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/)[0] !== '..';
}

function usableCwd(cwd: string | undefined): cwd is string {
  return typeof cwd === 'string' && cwd.length > 0 && !cwd.includes('\u0000') && path.isAbsolute(cwd);
}

/** Absolute display form of an outside target; the raw value when it cannot be resolved. */
function scanValue(raw: unknown, base: string | undefined, root: string | undefined, out: string[]): void {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\u0000')) {
    out.push(typeof raw === 'string' ? raw.replace(/\u0000/g, '') || '(invalid path)' : '(invalid path)');
    return;
  }
  if (raw.startsWith('~') || raw.startsWith(':') || base === undefined || root === undefined) {
    out.push(base !== undefined && !raw.startsWith('~') && !raw.startsWith(':') ? path.resolve(base, raw) : raw);
    return;
  }
  const abs = path.resolve(base, raw);
  if (!isContained(root, abs)) out.push(abs);
}

function scanKey(value: unknown, base: string | undefined, root: string | undefined, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) scanValue(item, base, root, out);
    return;
  }
  scanValue(value, base, root, out);
}

/** Glob patterns walk from their literal prefix; `..` or an absolute brace arm leaves the base. */
function scanGlobPattern(pattern: unknown, base: string | undefined, root: string | undefined, out: string[]): void {
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
  const start = prefix === '' && path.isAbsolute(pattern) ? path.parse(pattern).root : prefix;
  if (start.startsWith('~')) { out.push(pattern); return; }
  const abs = path.resolve(base, start === '' ? '.' : start);
  if (!isContained(root, abs) || rest.some((s) => s.includes('..')) || BRACE_ABSOLUTE_ARM.test(pattern)) {
    out.push(isContained(root, abs) ? pattern : abs);
  }
}

/** True when a delegation input relocates its children away from the session cwd. */
export function relocatesChildren(toolName: string, input: Record<string, unknown>, cwd: string | undefined): boolean {
  // D19: any isolation other than an explicit "none" may put children in a
  // checkout of the whole repository, outside a subdirectory session cwd.
  const isolates = (v: unknown): boolean => v !== undefined && v !== 'none';
  if (isolates(input['isolation'])) return true;
  if (Array.isArray(input['nodes']) && input['nodes'].some((n) => !isRecord(n) || isolates(n['isolation']))) return true;
  if (input['cwd'] !== undefined && !(usableCwd(cwd) && typeof input['cwd'] === 'string'
    && path.resolve(cwd, input['cwd']) === path.resolve(cwd))) return true;
  return toolName === 'compose' && Array.isArray(input['nodes']) && input['nodes'].some((n) => isRecord(n) && n['cwd'] !== undefined);
}

/** A call whose effective target depends on the caller's own cwd: no path argument, or a relative one. */
export function dependsOnCallerCwd(input: Record<string, unknown>): boolean {
  const present = PATH_KEYS.filter((k) => input[k] !== undefined);
  if (present.length === 0) return true;
  return present.some((k) => {
    const v = input[k];
    return (Array.isArray(v) ? v : [v]).some((x) => typeof x !== 'string' || !path.isAbsolute(x));
  });
}

/**
 * Every target of this call that is not lexically inside `cwd`, as absolute
 * paths where resolvable. Empty means no argument leaves the session directory
 * (a call without a path argument defaults to the cwd and is inside).
 */
export function outsidePaths(
  toolName: string, input: Record<string, unknown>, cwd: string | undefined, callerCwd?: string,
): string[] {
  const out: string[] = [];
  const root = usableCwd(cwd) ? path.resolve(cwd) : undefined;
  // A forked child's relative paths resolve against its own cwd; containment is always the session cwd.
  const caller = callerCwd === undefined ? root : usableCwd(callerCwd) ? path.resolve(callerCwd) : undefined;
  let base = caller;
  if (toolName === 'glob' && input['path'] !== undefined) {
    const p = input['path'];
    base = caller !== undefined && typeof p === 'string' && p.length > 0 && !p.includes('\u0000') && !p.startsWith('~')
      ? path.resolve(caller, p) : undefined;
  }
  for (const key of PATH_KEYS) {
    if (input[key] !== undefined) scanKey(input[key], caller, root, out);
  }
  if (toolName === 'glob') scanGlobPattern(input['pattern'], base, root, out);
  if (toolName === 'patch_apply' && Array.isArray(input['changes'])) {
    for (const change of input['changes']) scanValue(isRecord(change) ? change['path'] : undefined, caller, root, out);
  }
  // compose nodes may each name their own cwd.
  if (toolName === 'compose' && Array.isArray(input['nodes'])) {
    for (const node of input['nodes']) if (isRecord(node) && node['cwd'] !== undefined) scanValue(node['cwd'], caller, root, out);
  }
  if (toolName === 'git_read' && input['args'] !== undefined) {
    const args = input['args'];
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || GIT_RELOCATE.test(a))) {
      out.push('(git repository relocation)');
    }
  }
  // A caller cwd outside the session cwd is outside for anything that defaults to it.
  if (caller !== undefined && root !== undefined && !isContained(root, caller) && dependsOnCallerCwd(input)) out.push(caller);
  if (toolName === 'git_read' && gitReadReachesOutside(input, caller)) out.push('(git content outside the session directory)');
  return [...new Set(out)];
}
