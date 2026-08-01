import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Case-awareness for credential-floor path comparisons. */

/** Test override. Real probe results are cached by filesystem device. */
let forcedCaseInsensitive: boolean | undefined;
const caseInsensitiveByDevice = new Map<bigint | number, boolean>();

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Probe the filesystem containing `probePath` by resolving a case-flipped
 * spelling of that path's basename. Indeterminate errors deliberately remain
 * indeterminate so callers fail closed rather than caching an under-block.
 */
function probeCaseInsensitive(probePath: string): boolean | undefined {
  const base = basename(probePath);
  const flipped = base === base.toLowerCase() ? base.toUpperCase() : base.toLowerCase();
  if (flipped === base) return undefined;

  let self;
  try {
    self = statSync(probePath);
  } catch {
    return undefined;
  }

  const cached = caseInsensitiveByDevice.get(self.dev);
  if (cached !== undefined) return cached;

  try {
    const variant = statSync(join(dirname(probePath), flipped));
    const result = self.dev === variant.dev && self.ino === variant.ino;
    caseInsensitiveByDevice.set(self.dev, result);
    return result;
  } catch (error) {
    const code = errorCode(error);
    // Only resolution failures prove that the volume rejected the variant.
    // EACCES, EIO, ESTALE, and other errors tell us nothing and must fail closed.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      caseInsensitiveByDevice.set(self.dev, false);
      return false;
    }
    return undefined;
  }
}

/**
 * Whether comparisons against `protectedPath` should be case-folded.
 *
 * The nearest existing ancestor is probed, so relocated/custom denylist paths
 * use their own mounted filesystem rather than an unrelated process-wide home
 * volume. An indeterminate probe folds (the safe, deny-more direction).
 */
export function isCaseInsensitiveFs(protectedPath = homedir()): boolean {
  if (forcedCaseInsensitive !== undefined) return forcedCaseInsensitive;

  let candidate = protectedPath;
  while (true) {
    try {
      statSync(candidate);
      return probeCaseInsensitive(candidate) ?? true;
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return true;
      const parent = dirname(candidate);
      if (parent === candidate) return true;
      candidate = parent;
    }
  }
}

/**
 * Whether `real` is `blocked` itself or sits underneath it. `protectedPath`
 * identifies the filesystem whose case semantics govern the comparison.
 */
export function pathIsWithin(real: string, blocked: string, protectedPath = blocked): boolean {
  if (real === blocked || real.startsWith(blocked + '/')) return true;
  if (!isCaseInsensitiveFs(protectedPath)) return false;

  const r = real.toLowerCase();
  const b = blocked.toLowerCase();
  return r === b || r.startsWith(b + '/');
}

/** Whether a normalized bash command line mentions a protected path. */
export function textMentionsPath(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  if (!isCaseInsensitiveFs(needle)) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Reset probe state or force a volume kind. Tests only. */
export function _resetFsCaseCacheForTests(value?: boolean): void {
  forcedCaseInsensitive = value;
  caseInsensitiveByDevice.clear();
}
