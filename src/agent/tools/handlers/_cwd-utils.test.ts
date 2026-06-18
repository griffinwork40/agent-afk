/**
 * Tests for the path containment helpers used by all filesystem handlers
 * AND the path-approval PreToolUse hook.
 *
 * The two functions MUST agree on what "contained" means: `resolveAndContain`
 * throws when out-of-bounds, `wouldBeRestricted` returns `restricted: true`
 * on the SAME inputs. Drift would mean the hook prompts for paths the
 * handler then accepts (over-prompting) or skips paths the handler then
 * rejects (silent containment failure).
 */

import { describe, expect, it, afterEach } from 'vitest';
import { resolveAndContain, wouldBeRestricted } from './_cwd-utils.js';
import type { ToolHandlerContext } from '../types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';

const BASE = '/tmp/repo';
const OUTSIDE = '/etc/passwd';
const INSIDE = '/tmp/repo/src/foo.ts';

function ctx(overrides: Partial<ToolHandlerContext> = {}): ToolHandlerContext {
  return {
    cwd: BASE,
    resolveBase: BASE,
    readRoots: [BASE],
    writeRoots: [BASE],
    ...overrides,
  };
}

describe('resolveAndContain', () => {
  it('returns the absolute path for inputs inside the resolveBase', () => {
    expect(resolveAndContain(INSIDE, ctx())).toBe(INSIDE);
    expect(resolveAndContain('src/foo.ts', ctx())).toBe(INSIDE);
  });

  it('throws when path falls outside every allowed root', () => {
    expect(() => resolveAndContain(OUTSIDE, ctx())).toThrow(/outside the allowed/);
  });

  it('falls through to abs (no enforcement) when no resolveBase set', () => {
    expect(
      resolveAndContain(OUTSIDE, {
        cwd: undefined,
        resolveBase: undefined,
        readRoots: undefined,
        writeRoots: undefined,
      } as ToolHandlerContext),
    ).toBe(OUTSIDE);
  });

  it('accepts paths inside an extra granted root', () => {
    const extra = '/tmp/other';
    expect(
      resolveAndContain('/tmp/other/secrets.json', ctx({ readRoots: [BASE, extra] })),
    ).toBe('/tmp/other/secrets.json');
  });

  it('throws on writes to a read-only path', () => {
    expect(() =>
      resolveAndContain('/tmp/other/x.txt', ctx({ readRoots: [BASE, '/tmp/other'] }), 'write'),
    ).toThrow(/outside the allowed write roots/);
  });
});

describe('wouldBeRestricted', () => {
  it('agrees with resolveAndContain for inside paths (restricted=false)', () => {
    const verdict = wouldBeRestricted(INSIDE, ctx());
    expect(verdict.restricted).toBe(false);
    expect(verdict.resolved).toBe(INSIDE);
  });

  it('agrees with resolveAndContain for outside paths (restricted=true)', () => {
    const verdict = wouldBeRestricted(OUTSIDE, ctx());
    expect(verdict.restricted).toBe(true);
    expect(verdict.resolved).toBe(OUTSIDE);
    expect(verdict.roots).toContain(BASE);
  });

  it('returns restricted=false when no resolveBase (enforcement disabled)', () => {
    const verdict = wouldBeRestricted(OUTSIDE, {
      cwd: undefined,
      resolveBase: undefined,
      readRoots: undefined,
      writeRoots: undefined,
    } as ToolHandlerContext);
    expect(verdict.restricted).toBe(false);
  });

  it('distinguishes read vs write containment', () => {
    const c = ctx({ readRoots: [BASE, '/tmp/extra'], writeRoots: [BASE] });
    expect(wouldBeRestricted('/tmp/extra/x.txt', c, 'read').restricted).toBe(false);
    expect(wouldBeRestricted('/tmp/extra/x.txt', c, 'write').restricted).toBe(true);
  });

  it('resolves relative paths against resolveBase', () => {
    const verdict = wouldBeRestricted('src/foo.ts', ctx());
    expect(verdict.restricted).toBe(false);
    expect(verdict.resolved).toBe(INSIDE);
  });

  it('does not throw when restricted (key contract: returns instead of throws)', () => {
    expect(() => wouldBeRestricted(OUTSIDE, ctx())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Symlink containment tests (H1 security fix)
// ---------------------------------------------------------------------------

describe('symlink containment', () => {
  // Track tmp dirs created per test so afterEach can clean them up.
  const tmps: string[] = [];

  afterEach(() => {
    for (const tmp of tmps.splice(0)) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function makeTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmps.push(dir);
    return dir;
  }

  // (a) SYMLINK ESCAPE
  // A symlink that lives INSIDE the granted root but points OUTSIDE must be
  // treated as restricted by both functions.
  it('(a) symlink escape: rootDir/link -> outsideDir is restricted', () => {
    const rootDir = makeTmp('afk-root-');
    const outsideDir = makeTmp('afk-outside-');

    // Create the outside secret file.
    const secretFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'secret');

    // Create a symlink INSIDE the root pointing to the outside dir.
    const linkPath = path.join(rootDir, 'link');
    fs.symlinkSync(outsideDir, linkPath);

    const candidate = path.join(rootDir, 'link', 'secret.txt');
    const c = ctx({ resolveBase: rootDir, readRoots: [rootDir], writeRoots: [rootDir] });

    // wouldBeRestricted must return restricted=true.
    expect(wouldBeRestricted(candidate, c).restricted).toBe(true);

    // resolveAndContain must throw (same verdict, throwing form).
    expect(() => resolveAndContain(candidate, c)).toThrow(/outside the allowed/);
  });

  // (b) LEGIT SYMLINKED ROOT
  // If the root itself is reached via a symlink, a real child inside it must
  // still be allowed (not restricted). This guards against over-blocking when
  // the user's home or workspace is symlinked.
  it('(b) legit symlinked root: child of symlinked root is not restricted', () => {
    const realRoot = makeTmp('afk-real-');
    const symlinkRoot = path.join(os.tmpdir(), `afk-symroot-${Date.now()}`);
    tmps.push(symlinkRoot);
    fs.symlinkSync(realRoot, symlinkRoot);

    // Create a real file inside the real root.
    const childFile = path.join(realRoot, 'child.txt');
    fs.writeFileSync(childFile, 'hello');

    // The root in context is the SYMLINKED path; the candidate is the REAL path.
    const c = ctx({ resolveBase: symlinkRoot, readRoots: [symlinkRoot], writeRoots: [symlinkRoot] });

    expect(wouldBeRestricted(childFile, c).restricted).toBe(false);
    expect(resolveAndContain(childFile, c)).toBe(childFile);
  });

  // (c) PREFIX BOUNDARY REGRESSION PIN
  // Granting "<base>/Library" must NOT allow access to "<base>/Lib".
  // path.relative yields '../Lib' — starts with '..' — so it must be
  // restricted. This pins the boundary so a future startsWith refactor can't
  // silently break it.
  it('(c) prefix boundary: granted Library does not allow sibling Lib', () => {
    const base = makeTmp('afk-prefix-');
    const grantedRoot = path.join(base, 'Library');
    const candidate = path.join(base, 'Lib');

    // Neither directory needs to exist for this lexical test; but create them
    // so realpathSafe can resolve all ancestors up to base (which does exist).
    fs.mkdirSync(grantedRoot, { recursive: true });
    // NOTE: candidate dir does NOT exist — tests the not-yet-existing fallback.

    const c = ctx({ resolveBase: grantedRoot, readRoots: [grantedRoot], writeRoots: [grantedRoot] });

    expect(wouldBeRestricted(candidate, c).restricted).toBe(true);
    expect(() => resolveAndContain(candidate, c)).toThrow(/outside the allowed/);
  });

  // (d) DRIFT REGRESSION: both functions agree for standard inside + outside paths.
  // Exercises real fs paths so realpathSafe runs, verifying the symlink-resolution
  // layer doesn't break agreement on normal (non-symlink) inputs.
  it('(d) drift check: both functions agree on real inside and outside paths', () => {
    const rootDir = makeTmp('afk-drift-');
    const insideFile = path.join(rootDir, 'file.txt');
    fs.writeFileSync(insideFile, 'data');

    const outsideFile = '/etc/hosts'; // always exists

    const c = ctx({ resolveBase: rootDir, readRoots: [rootDir], writeRoots: [rootDir] });

    // Inside: wouldBeRestricted=false, resolveAndContain does not throw.
    expect(wouldBeRestricted(insideFile, c).restricted).toBe(false);
    expect(() => resolveAndContain(insideFile, c)).not.toThrow();

    // Outside: wouldBeRestricted=true, resolveAndContain throws.
    expect(wouldBeRestricted(outsideFile, c).restricted).toBe(true);
    expect(() => resolveAndContain(outsideFile, c)).toThrow(/outside the allowed/);
  });
});
