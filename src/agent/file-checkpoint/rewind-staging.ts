/** Identity-pinned synchronous staging for rewind's security-sensitive writes. */
import { statSync, realpathSync, mkdirSync, writeFileSync, chmodSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

interface DirectoryPin { path: string; real: string; dev: number; ino: number }

function pin(path: string): DirectoryPin {
  const real = realpathSync.native(path);
  const info = statSync(path);
  if (!info.isDirectory()) throw new Error(`Rewind parent is not a directory: ${path}`);
  return { path, real, dev: info.dev, ino: info.ino };
}

function unchanged(pins: DirectoryPin[]): void {
  for (const saved of pins) {
    const now = pin(saved.path);
    if (now.real !== saved.real || now.dev !== saved.dev || now.ino !== saved.ino) {
      throw new Error(`Rewind parent identity changed: ${saved.path}`);
    }
  }
}

/** Pin an existing destination parent for synchronous deletion guards too. */
export function pinRewindParent(target: string): () => void {
  const pins = [pin(dirname(target))];
  return () => unchanged(pins);
}

export function stageRewindFile(target: string, content: Buffer, validate: () => void, mode = 0o600): void {
  const missing: string[] = [];
  let ancestor = dirname(target);
  let initial: DirectoryPin;
  for (;;) {
    try { initial = pin(ancestor); break; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      missing.unshift(ancestor);
      const parent = dirname(ancestor);
      if (parent === ancestor) throw err;
      ancestor = parent;
    }
  }
  const pins = [initial];
  const created: string[] = [];
  let temp: string | undefined;
  // Invariant: identity/policy checks and every mkdir, temp write and rename
  // share a synchronous event-loop tick. No same-process retarget can run in
  // staging; external-process races remain bounded by checks before each write.
  const guard = () => { unchanged(pins); validate(); };
  try {
    for (const directory of missing) {
      guard();
      mkdirSync(directory);
      created.push(directory);
      pins.push(pin(directory));
    }
    guard();
    temp = join(dirname(target), `.tmp-${randomBytes(6).toString('hex')}`);
    writeFileSync(temp, content, { flag: 'wx', mode });
    guard();
    chmodSync(temp, mode);
    guard();
    renameSync(temp, target);
    temp = undefined;
  } catch (err) {
    // Never clean up through a retargeted directory: that could delete outside
    // the grant. Only remove our own artifacts while every identity still fits.
    try {
      unchanged(pins);
      if (temp) unlinkSync(temp);
      for (const directory of created.reverse()) rmdirSync(directory);
    } catch { /* best effort; refuse unsafe cleanup */ }
    throw err;
  }
}
