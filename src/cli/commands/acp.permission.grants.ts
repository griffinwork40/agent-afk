/**
 * Which tools may be remembered with "Always allow" (profile section 6, D18).
 * Opt-in and fail closed: a tool is grantable only when listed here, and a
 * remembered grant covers a call only when every argument of that call is one
 * the entry knows and every declared location resolves inside the session cwd,
 * lexically and by real path (acp.permission.realpath).
 *
 * @module cli/commands/acp.permission.grants
 */
import path from 'node:path';
import { driveless, isContained, type PathFlavor } from './acp.permission.paths.js';
import { sensitiveMarker, sensitiveMarkers } from './acp.permission.sensitive.js';
import { nativeProbe, realTarget, type FsProbe } from './acp.permission.realpath.js';

// Contract: each entry was written from the tool's real handler, not its name.
//  - write_file (handlers/write-file.ts parseWriteFileInput, resolveAndContain):
//    location `file_path`, required (a missing or non-string value is refused by
//    the handler, so nothing is written); other keys: `content`.
//  - edit_file (handlers/edit-file.ts parseEditFileInput, resolveAndContain):
//    location `file_path`, required; other keys: `old_string`, `new_string`,
//    `replace_all`, `expected_hash`.
//  - patch_apply (handlers/patch-apply.ts parsePatchApplyInput, validatedWriteTarget):
//    locations `changes[].path`, each required; per-change keys `path`,
//    `expected_hash`, `edits`, `content`; top-level keys `changes`, `dry_run`.
// Relative locations resolve against the caller's resolve base (the session
// cwd, or a forked child's own cwd). There is no default location: a call with
// no location is refused by the handler. Any other tool is asked every time.
interface GrantEntry {
  /** Every top-level argument the handler reads. Anything else: not covered. */
  readonly keys: ReadonlySet<string>;
  /** The location values of this call, or undefined when the shape is not understood. */
  locations(input: Record<string, unknown>): unknown[] | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const filePathOnly = (input: Record<string, unknown>): unknown[] =>
  input['file_path'] === undefined ? [] : [input['file_path']];

const PATCH_CHANGE_KEYS = new Set(['path', 'expected_hash', 'edits', 'content']);

function patchLocations(input: Record<string, unknown>): unknown[] | undefined {
  const changes = input['changes'];
  if (changes === undefined) return [];
  if (!Array.isArray(changes)) return undefined;
  const out: unknown[] = [];
  for (const change of changes) {
    if (!isRecord(change) || !Object.keys(change).every((k) => PATCH_CHANGE_KEYS.has(k))) return undefined;
    out.push(change['path']);
  }
  return out;
}

const GRANTABLE: ReadonlyMap<string, GrantEntry> = new Map<string, GrantEntry>([
  ['write_file', { keys: new Set(['file_path', 'content']), locations: filePathOnly }],
  ['edit_file', {
    keys: new Set(['file_path', 'old_string', 'new_string', 'replace_all', 'expected_hash']),
    locations: filePathOnly,
  }],
  ['patch_apply', { keys: new Set(['changes', 'dry_run']), locations: patchLocations }],
]);

/** The tools that may ever be offered "Always allow", in a stable order (for docs and tests). */
export const GRANTABLE_TOOLS: readonly string[] = [...GRANTABLE.keys()];

/** True when this tool may be offered "Always allow" at all. */
export function isGrantable(toolName: string): boolean {
  return GRANTABLE.has(toolName);
}

function insideLocation(raw: unknown, base: string, root: string, p: PathFlavor): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\u0000') || raw.startsWith('~')) return false;
  return !driveless(raw, p) && isContained(root, p.resolve(base, raw), p);
}

/**
 * Filesystem half of the fit (A1): the REAL path each location would reach
 * (links and junctions followed, a not-yet-existing remainder re-appended) is
 * inside the REAL session directory and not sensitive there. Any doubt is false.
 */
function realFits(locations: unknown[], base: string, root: string, p: PathFlavor, probe: FsProbe): boolean {
  const realRoot = realTarget(root, p, probe);
  if (realRoot === undefined) return false;
  return locations.every((raw) => {
    if (typeof raw !== 'string') return false;
    const real = realTarget(p.resolve(base, raw), p, probe);
    if (real === undefined || !isContained(realRoot, real, p)) return false;
    // Only the part below the session directory is checked: its ancestors are not written.
    return sensitiveMarker(p.relative(realRoot, real), undefined, p) === '';
  });
}

/**
 * True when a remembered grant for this tool may cover this exact call (and when
 * this call may be offered "Always allow"): the tool is listed, every argument
 * is known, every location resolves inside `cwd` both lexically and by real
 * path, and no location is a sensitive target (acp.permission.sensitive),
 * lexically or by real path. Any doubt is false.
 *
 * `probe` is the file system the real-path step asks. It defaults to the host
 * file system when `p` is the host's own path flavour (always, in production);
 * `null` (the default for a foreign flavour in tests) runs the lexical half only.
 */
export function grantFits(
  toolName: string, input: Record<string, unknown>, cwd: string | undefined, callerCwd?: string,
  p: PathFlavor = path, probe: FsProbe | null = p === path ? nativeProbe : null,
): boolean {
  const entry = GRANTABLE.get(toolName);
  if (entry === undefined) return false;
  if (typeof cwd !== 'string' || !p.isAbsolute(cwd) || cwd.includes('\u0000') || driveless(cwd, p)) return false;
  if (callerCwd !== undefined && (!p.isAbsolute(callerCwd) || callerCwd.includes('\u0000') || driveless(callerCwd, p))) return false;
  if (!Object.keys(input).every((k) => entry.keys.has(k))) return false;
  const locations = entry.locations(input);
  if (locations === undefined) return false;
  const root = p.resolve(cwd);
  const base = callerCwd === undefined ? root : p.resolve(callerCwd);
  if (!locations.every((raw) => insideLocation(raw, base, root, p))) return false;
  // Git internals and project config that runs commands are asked every time.
  if (sensitiveMarkers(toolName, input, base, p).length > 0) return false;
  return probe === null || realFits(locations, base, root, p, probe);
}
