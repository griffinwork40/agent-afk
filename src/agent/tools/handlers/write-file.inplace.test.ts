/**
 * The in-place write fallback is not atomic: a failure partway through it
 * (e.g. ENOSPC after truncation) may have modified the target, so it must
 * never be reported as "not modified", even when an abort lands concurrently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hooks = vi.hoisted(() => ({
  forceInPlace: false,
  onInPlaceWrite: undefined as undefined | (() => void),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    // Deny W_OK so commitFileWrite routes through the in-place write
    // deterministically (independent of the running user, e.g. root).
    access: vi.fn(async (...args: Parameters<typeof actual.access>) => {
      if (hooks.forceInPlace) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return actual.access(...args);
    }),
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      if (hooks.onInPlaceWrite) return hooks.onInPlaceWrite();
      return actual.writeFile(...args);
    }),
  };
});

const { commitFileWrite, WriteAbortedUntouchedError } = await import('./write-file.atomic.js');
const { writeFileHandler } = await import('./write-file.js');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'afk-write-inplace-'));
  hooks.forceInPlace = true;
});

afterEach(() => {
  hooks.forceInPlace = false;
  hooks.onInPlaceWrite = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Make the in-place write abort `ac` and then fail like a full disk. */
function failMidWrite(ac: AbortController): void {
  hooks.onInPlaceWrite = () => {
    ac.abort({ custom: 'reason' });
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
}

describe('in-place write failing while aborted', () => {
  it('commitFileWrite rethrows the raw error, not the untouched marker', async () => {
    const f = path.join(dir, 'a.txt');
    writeFileSync(f, 'old');
    const ac = new AbortController();
    failMidWrite(ac);
    const err = await commitFileWrite(f, 'new', ac.signal).catch((e: unknown) => e);
    expect(ac.signal.aborted).toBe(true);
    expect(err).not.toBeInstanceOf(WriteAbortedUntouchedError);
    expect(err).toMatchObject({ code: 'ENOSPC' });
  });

  it('the handler does not claim "not modified"', async () => {
    const f = path.join(dir, 'h.txt');
    writeFileSync(f, 'old');
    const ac = new AbortController();
    failMidWrite(ac);
    const result = await writeFileHandler({ file_path: f, content: 'new' }, ac.signal, {
      cwd: dir,
      resolveBase: dir,
    } as Parameters<typeof writeFileHandler>[2]);
    expect(result.isError).toBe(true);
    expect(result.content).not.toMatch(/not modified/);
    expect(result.content).toMatch(/ENOSPC/);
  });

  it('an abort observed before the in-place write starts is reported as untouched', async () => {
    const f = path.join(dir, 'b.txt');
    writeFileSync(f, 'old');
    const ac = new AbortController();
    ac.abort({ custom: 'reason' });
    await expect(commitFileWrite(f, 'new', ac.signal)).rejects.toBeInstanceOf(WriteAbortedUntouchedError);
    expect(readFileSync(f, 'utf8')).toBe('old');
  });
});
