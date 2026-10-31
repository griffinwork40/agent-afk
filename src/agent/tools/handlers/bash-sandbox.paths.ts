/** Live sandbox path policy. No filesystem topology is cached. */
import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { getUnresolvedWriteDenylist } from './write-denylist.js';

/** Resolve missing tails too, but refuse dangling links and inaccessible ancestors. */
export function canonicalSandboxPath(input: string): string {
  if (input.includes('\0')) throw new Error('Sandbox path contains NUL');
  let current = path.resolve(input);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // ENOENT from realpath may mean a dangling symlink, not an absent leaf.
      try {
        lstatSync(current);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        tail.unshift(path.basename(current));
        current = parent;
        continue;
      }
      throw new Error(`Sandbox cannot resolve dangling path: ${current}`);
    }
  }
}

export function sandboxWriteFloor(): readonly string[] {
  return [...new Set(getUnresolvedWriteDenylist().flatMap((entry) => [
    path.resolve(entry), canonicalSandboxPath(entry),
  ]))];
}

/** Deny renaming any ancestor that could relocate a protected pathname. */
export function sandboxFloorAncestors(floor: readonly string[]): readonly string[] {
  const ancestors = new Set<string>();
  for (const entry of floor) {
    let parent = path.dirname(entry);
    for (;;) {
      ancestors.add(parent);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  return [...ancestors];
}

function contains(root: string, target: string): boolean {
  // Resolve both sides so POSIX kernel roots (path.posix.join) and OS-native
  // grants (canonicalSandboxPath) share the same drive prefix on Windows.
  const nr = path.resolve(root);
  const nt = path.resolve(target);
  const relative = path.relative(nr, nt);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Linux cannot subtract absent credential leaves from a writable bind safely.
 * Refuse the ENTIRE spawn for overlapping grants, in either direction, including
 * canonical aliases. This also prevents creation/rename of protected entries.
 */
export function assertDisjointSandboxGrants(grants: readonly string[], floor: readonly string[]): void {
  for (const grant of grants) {
    for (const blocked of floor) {
      if (contains(grant, blocked) || contains(blocked, grant)) {
        throw new Error(`Sandbox writable grant overlaps protected write floor: ${grant} / ${blocked}`);
      }
    }
  }
}

/** SBPL strings use Scheme escaping, not shell escaping. Refuse controls rather
 * than relying on undocumented TinyScheme escapes; quote and backslash are safe.
 */
export function sandboxSchemeString(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Sandbox path contains unsupported control character');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
