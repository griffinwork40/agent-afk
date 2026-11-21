/**
 * Filesystem step of the "Always allow" grant fit check (profile section 6,
 * D18). The lexical check in acp.permission.grants cannot see a symbolic link
 * (or a Windows junction) inside the session directory that points outside it
 * or at a sensitive target; this module resolves the real path a write would
 * reach so the grant check can compare real path against real path.
 *
 * @module cli/commands/acp.permission.realpath
 */
import fs from 'node:fs';
import type { PathFlavor } from './acp.permission.paths.js';

/** The two filesystem questions the check asks; injectable so tests can fake a file system. */
export interface FsProbe {
  /** Canonical path of an existing entry, every link followed; throws when it cannot be resolved. */
  realpath(p: string): string;
  /** True when anything (a dangling link included) exists at `p`, false when nothing does; throws on doubt. */
  lexists(p: string): boolean;
}

/** The host file system: `fs.realpathSync.native` (resolves junctions and drive mappings on Windows). */
export const nativeProbe: FsProbe = {
  realpath: (p) => fs.realpathSync.native(p),
  lexists: (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined,
};

// Contract: the real path of the nearest EXISTING ancestor (the target itself
// when it exists), with the part that does not exist yet re-appended
// unchanged. A component that exists but cannot be resolved (a dangling link,
// a link loop, a permission error, a file used as a directory) makes the
// result undefined, so the caller fails closed: writing through a dangling
// link creates its target, wherever that is.
/** Real path a write to the absolute path `abs` would reach, or undefined when it cannot be placed. */
export function realTarget(abs: string, p: PathFlavor, probe: FsProbe): string | undefined {
  let current = p.resolve(abs);
  const missing: string[] = [];
  for (;;) {
    let real: unknown;
    try {
      real = probe.realpath(current);
    } catch {
      let exists: boolean;
      try { exists = probe.lexists(current); } catch { return undefined; }
      if (exists) return undefined;
      const parent = p.dirname(current);
      if (parent === current) return undefined;
      missing.unshift(p.basename(current));
      current = parent;
      continue;
    }
    if (typeof real !== 'string' || real.length === 0 || real.includes('\u0000') || !p.isAbsolute(real)) return undefined;
    return missing.length === 0 ? real : p.join(real, ...missing);
  }
}
