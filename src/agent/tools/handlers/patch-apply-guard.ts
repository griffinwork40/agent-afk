/** Recheck validated patch destinations across asynchronous checkpoint/commit boundaries.
 * This closes deterministic await-boundary races, not arbitrary OS-level TOCTOU.
 */
import { lstat, readFile } from 'fs/promises';
import { dirname } from 'path';
import type { ToolHandlerContext } from '../types.js';
import { validatedWriteTarget } from '../../file-checkpoint/write-policy.js';
import { sha256Hex } from './patch-validate.js';

function fail(code: string, path: string): never {
  throw Object.assign(new Error(`${code}: patch destination changed after validation: ${path}`), { code });
}

/** Capture inode identities BEFORE any checkpoint callback can run. */
export async function capturePatchGuard(
  contents: Map<string, string | null>, context: ToolHandlerContext | undefined, cwd?: string,
): Promise<(path: string) => Promise<void>> {
  const identities = new Map<string, Array<{ path: string; dev: number; ino: number }>>();
  // Ancestors absent at capture time may be created later (mkdir), but never
  // as a symlink: a dangling link resolves to itself and passes containment.
  const absent = new Map<string, string[]>();
  for (const [path, content] of contents) {
    const chain: Array<{ path: string; dev: number; ino: number }> = [];
    const missing: string[] = [];
    let current = path;
    for (;;) {
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) fail('path_identity_changed', current);
        if (current === path && content === null) fail('path_identity_changed', current);
        chain.push({ path: current, dev: info.dev, ino: info.ino });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (current === path && content !== null) throw err;
        if (current !== path) missing.push(current);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    identities.set(path, chain);
    absent.set(path, missing);
  }
  return async (path) => {
    // Re-run containment/denylist checks, then require the same canonical target.
    if (await validatedWriteTarget(path, context, cwd) !== path) fail('path_identity_changed', path);
    for (const identity of identities.get(path) ?? []) {
      const info = await lstat(identity.path);
      if (info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) {
        fail('path_identity_changed', identity.path);
      }
    }
    for (const ancestor of absent.get(path) ?? []) {
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) fail('path_identity_changed', ancestor);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    const before = contents.get(path);
    if (before === null) {
      try {
        await lstat(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      fail('path_identity_changed', path);
    }
    if (before === undefined) fail('missing_snapshot', path);
    if (sha256Hex(await readFile(path, 'utf8')) !== sha256Hex(before)) fail('hash_mismatch', path);
  };
}
