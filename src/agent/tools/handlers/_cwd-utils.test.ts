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
import { resolveAndContain, wouldBeRestricted, extractCandidatePaths } from './_cwd-utils.js';
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

describe('allowAll bypass (bypassPermissions mode)', () => {
  // External invariant: both functions MUST agree under allowAll too —
  // resolveAndContain admits the path (no throw), wouldBeRestricted reports
  // not-restricted — so the path-approval hook skips its prompt for exactly the
  // paths the handler will then accept.
  it('resolveAndContain admits an out-of-root path when allowAll is set', () => {
    expect(resolveAndContain(OUTSIDE, ctx({ allowAll: true }))).toBe(OUTSIDE);
    expect(resolveAndContain(OUTSIDE, ctx({ allowAll: true }), 'write')).toBe(OUTSIDE);
  });

  it('wouldBeRestricted reports not-restricted for an out-of-root path when allowAll is set', () => {
    const r = wouldBeRestricted(OUTSIDE, ctx({ allowAll: true }));
    expect(r.restricted).toBe(false);
    expect(r.resolved).toBe(OUTSIDE);
    expect(wouldBeRestricted(OUTSIDE, ctx({ allowAll: true }), 'write').restricted).toBe(false);
  });

  it('allowAll does not disturb in-root resolution (relative paths still anchor to resolveBase)', () => {
    expect(resolveAndContain('src/foo.ts', ctx({ allowAll: true }))).toBe(INSIDE);
    expect(wouldBeRestricted(INSIDE, ctx({ allowAll: true })).restricted).toBe(false);
  });
});

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

// ---------------------------------------------------------------------------
// extractCandidatePaths — best-effort path token extractor for the bash
// handler's advisory containment scan (issue #354). Explicitly NOT a shell
// parser; these tests pin the documented best-effort contract.
// ---------------------------------------------------------------------------
describe('extractCandidatePaths', () => {
  it('extracts absolute path tokens', () => {
    expect(extractCandidatePaths('cat /etc/hosts')).toEqual(['/etc/hosts']);
  });

  it('extracts home-relative tokens (~/… and bare ~)', () => {
    expect(extractCandidatePaths('cat ~/.ssh/id_rsa')).toEqual(['~/.ssh/id_rsa']);
    expect(extractCandidatePaths('ls ~')).toEqual(['~']);
  });

  it('extracts multiple distinct paths and dedupes repeats', () => {
    expect(extractCandidatePaths('cp /a/b /c/d')).toEqual(['/a/b', '/c/d']);
    expect(extractCandidatePaths('diff /a /a')).toEqual(['/a']);
  });

  it('ignores relative tokens, flags, and non-path words', () => {
    expect(extractCandidatePaths('ls -la src/foo.ts ./bar --color=auto')).toEqual([]);
    expect(extractCandidatePaths('echo hello world')).toEqual([]);
  });

  it('strips surrounding quotes from a path token', () => {
    expect(extractCandidatePaths('cat "/etc/hosts"')).toEqual(['/etc/hosts']);
    expect(extractCandidatePaths("cat '/etc/hosts'")).toEqual(['/etc/hosts']);
  });

  it('trims trailing shell punctuation abutting a path', () => {
    expect(extractCandidatePaths('cd /tmp/foo; ls')).toEqual(['/tmp/foo']);
    expect(extractCandidatePaths('cat /a/b, /c/d')).toEqual(['/a/b', '/c/d']);
    expect(extractCandidatePaths('(cat /etc/hosts)')).toEqual(['/etc/hosts']);
  });

  it('does NOT understand shell constructs (documented best-effort gap)', () => {
    // The extractor does not resolve/expand shell semantics — it only sees
    // literal tokens. This is the whole reason the scan is advisory-only.
    //
    // env-var indirection: the synthesized path is invisible (no leading / or ~).
    expect(extractCandidatePaths('cat $HOME/.ssh/id_rsa')).toEqual([]);
    expect(extractCandidatePaths('cat ${SECRET_DIR}/key')).toEqual([]);
    // A path whose VALUE is produced by substitution (e.g. `$(cat pathfile)`)
    // is NOT understood — the extractor cannot see the runtime value:
    expect(extractCandidatePaths('cat $(cat pathfile)')).toEqual([]);
  });

  it('picks up literal path tokens inside shell constructs (harmless false-positive)', () => {
    // Conversely, a LITERAL path appearing inside a $()/backticks IS picked up
    // naively — the extractor does not know it is inside a substitution. This
    // is a harmless over-report: it would at worst produce one advisory warning.
    // It is documented behavior, NOT a guarantee that $()/backticks are parsed.
    expect(extractCandidatePaths('cat $(printf /etc/hosts)')).toContain('/etc/hosts');
    expect(extractCandidatePaths('cat `echo /etc/hosts`').length).toBeGreaterThan(0);
  });

  it('returns an empty array for a command with no path-like tokens', () => {
    expect(extractCandidatePaths('git status')).toEqual([]);
    expect(extractCandidatePaths('')).toEqual([]);
  });
});

describe('fallbackBase — factory-cwd resolve tier (issue #434)', () => {
  // A context with NO resolveBase/cwd — the out-of-dispatcher invocation shape.
  const baseless = {
    cwd: undefined,
    resolveBase: undefined,
    readRoots: undefined,
    writeRoots: undefined,
  } as ToolHandlerContext;

  it('anchors a relative path to fallbackBase when context carries no base', () => {
    // Without fallbackBase this resolves against process.cwd(); with it, BASE.
    expect(resolveAndContain('src/foo.ts', baseless, 'read', BASE)).toBe(INSIDE);
  });

  it('enforces containment against [fallbackBase] when context carries no base', () => {
    expect(() => resolveAndContain(OUTSIDE, baseless, 'read', BASE)).toThrow(/outside the allowed/);
    expect(wouldBeRestricted(OUTSIDE, baseless, 'read', BASE).restricted).toBe(true);
    expect(wouldBeRestricted(INSIDE, baseless, 'read', BASE).restricted).toBe(false);
  });

  it('context base wins over fallbackBase (no-op on the dispatcher path)', () => {
    // context.resolveBase = BASE; a bogus fallbackBase must be ignored.
    expect(resolveAndContain('src/foo.ts', ctx(), 'read', '/tmp/other')).toBe(INSIDE);
    expect(wouldBeRestricted(INSIDE, ctx(), 'read', '/tmp/other').restricted).toBe(false);
  });

  it('undefined fallbackBase preserves the unconfined fall-through (invariant guard)', () => {
    // No context base AND no fallbackBase → resolveBase undefined → no enforcement.
    // This is the load-bearing top-level-session invariant; do not "fix" it.
    expect(resolveAndContain(OUTSIDE, baseless, 'read', undefined)).toBe(OUTSIDE);
    expect(wouldBeRestricted(OUTSIDE, baseless, 'read', undefined).restricted).toBe(false);
  });
});
