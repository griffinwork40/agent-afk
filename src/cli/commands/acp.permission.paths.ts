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

/** The path flavour a decision uses; the platform's by default, `path.win32`/`path.posix` in tests. */
export type PathFlavor = typeof path.posix;

const ASCII_UPPER = /[A-Z]/g;

/**
 * Win32 only: `path.win32.relative` folds case with `String.toLowerCase`, which
 * equates names NTFS keeps distinct (KELVIN SIGN U+212A and `k`; U+0130 and
 * `i` + U+0307). Re-check the prefix folding ASCII letters only, so a sibling
 * spelled with such a character is outside. Non-ASCII case variants of the
 * real root are then asked (an annoyance, never an unsafe allow).
 */
function win32SamePrefix(root: string, abs: string): boolean {
  const fold = (s: string): string => s.replace(ASCII_UPPER, (c) => c.toLowerCase());
  return fold(`${abs}\\`).startsWith(fold(root.endsWith('\\') ? root : `${root}\\`));
}

/** True when `abs` is the root itself or lexically below it (Windows-safe, no raw prefix checks). */
export function isContained(root: string, abs: string, p: PathFlavor = path): boolean {
  const r = p.resolve(root);
  const a = p.resolve(abs);
  const rel = p.relative(r, a);
  // Another drive or UNC share: relative() returns an absolute path.
  if (p.isAbsolute(rel)) return false;
  const segments = rel === '' ? [] : rel.split(/[\\/]/);
  if (segments[0] === '..') return false;
  if (p.sep === '/') return true;
  // Win32 strips trailing dots and spaces from path segments (`.. ` can name
  // the parent); path.win32 does not, so such a segment cannot be placed.
  return !segments.some((s) => /[. ]$/.test(s)) && win32SamePrefix(r, a);
}

/**
 * Win32 only: `\\x` (or `/x`) is absolute to path.isAbsolute yet names no drive.
 * The tool handlers keep it as given, so the OS reads it on the PROCESS's
 * current drive, while resolve(cwd, raw) would put it on the session cwd's
 * drive. It cannot be placed lexically, so it is treated as outside.
 */
export function driveless(raw: string, p: PathFlavor = path): boolean {
  return p.sep === '\\' && /^[\\/](?![\\/])/.test(raw);
}

function usableCwd(cwd: string | undefined, p: PathFlavor): cwd is string {
  return typeof cwd === 'string' && cwd.length > 0 && !cwd.includes('\u0000') && p.isAbsolute(cwd);
}

/** Absolute display form of an outside target; the raw value when it cannot be resolved. */
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

/** Glob patterns walk from their literal prefix; `..` or an absolute brace arm leaves the base. */
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
  // An absolute pattern walks from an absolute start. Its literal prefix may not
  // be absolute on its own: '' for `/**`, and the bare drive `C:` for `C:/**`,
  // which resolve() would read as the current directory of that drive (the base).
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
  // D19: any isolation other than an explicit "none" may put children in a
  // checkout of the whole repository, outside a subdirectory session cwd.
  const isolates = (v: unknown): boolean => v !== undefined && v !== 'none';
  if (isolates(input['isolation'])) return true;
  // A continued agent inherits its chain's cwd and isolation, which this call does not show.
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
 * paths where resolvable. Empty means no argument leaves the session directory
 * (a call without a path argument defaults to the cwd and is inside).
 */
export function outsidePaths(
  toolName: string, input: Record<string, unknown>, cwd: string | undefined, callerCwd?: string,
  p: PathFlavor = path,
): string[] {
  const out: string[] = [];
  const root = usableCwd(cwd, p) ? p.resolve(cwd) : undefined;
  // A forked child's relative paths resolve against its own cwd; containment is always the session cwd.
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
  // compose nodes may each name their own cwd.
  if (toolName === 'compose' && Array.isArray(input['nodes'])) {
    for (const node of input['nodes']) if (isRecord(node) && node['cwd'] !== undefined) scanValue(node['cwd'], caller, root, out, p);
  }
  if (toolName === 'git_read' && input['args'] !== undefined) {
    const args = input['args'];
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || GIT_RELOCATE.test(a))) {
      out.push('(git repository relocation)');
    }
  }
  // A caller cwd outside the session cwd is outside for anything that defaults to it.
  if (caller !== undefined && root !== undefined && !isContained(root, caller, p) && dependsOnCallerCwd(input, p)) out.push(caller);
  if (toolName === 'git_read' && gitReadReachesOutside(input, caller)) out.push('(git content outside the session directory)');
  return [...new Set(out)];
}
