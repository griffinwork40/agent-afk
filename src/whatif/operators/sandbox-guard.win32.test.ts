/**
 * Win32 semantics regression tests for sandbox-guard.ts containment helper.
 *
 * Issue #703: the original containment check used trailingSlash() with a
 * hardcoded '/' separator, so paths like "C:\Temp\afk-foo\home\skills\a"
 * (all backslashes from realpathSync) failed the startsWith("C:\...\home/")
 * check.  Issue #3029 replaced the trailingSlash idiom with isInside(), which
 * uses path.relative() — sep-aware and matching the _cwd-utils.ts idiom.
 *
 * This file mocks 'path' to win32 semantics so that path.relative / isAbsolute
 * use backslash rules on any host (precedent: bash-scan-exempt.win32.test.ts /
 * PR #2605). 'node:fs' is mocked so that realpathSync returns win32-style
 * backslash paths without needing a real Windows filesystem.
 *
 * Tests prove BOTH directions: a path inside the sandbox is allowed, a path
 * outside is refused. Containment is not weakened.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

// -- path mock: win32 semantics (hoisted by vitest) --------------------------
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  const win = { ...actual.win32, posix: actual.posix, win32: actual.win32 };
  return { ...win, default: win };
});

// -- fs mock: existsSync always true, mkdirSync noop, realpathSync returns
//    paths as-is (simulating Windows where short- and long-name expansion is
//    not needed for these test paths). -----------------------------------
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const fakeRealpath = (p: string): string => p;
  (fakeRealpath as unknown as { native: (p: string) => string }).native = (p: string): string => p;
  return {
    ...actual,
    existsSync: (): boolean => true,
    mkdirSync: (): void => undefined,
    realpathSync: fakeRealpath,
  };
});

// Dynamically import the module AFTER both mocks are wired.
const { assertInsideSandbox } = await import('./sandbox-guard.js');

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constants — all backslash paths, as they would appear from realpathSync on
// the Windows CI runner.
// ---------------------------------------------------------------------------

const WIN_TMP = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
const SANDBOX_HOME = `${WIN_TMP}\\afk-HmRmEc\\home`;
const SANDBOX_CWD = `${WIN_TMP}\\afk-HmRmEc\\project`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assertInsideSandbox under win32 path semantics', () => {
  const env = {
    label: 'candidate' as const,
    home: SANDBOX_HOME,
    cwd: SANDBOX_CWD,
    launch: { env: {} },
  };

  // ----- ACCEPT cases -------------------------------------------------------

  it('accepts an exact match on env.home', () => {
    expect(() => assertInsideSandbox(SANDBOX_HOME, env)).not.toThrow();
  });

  it('accepts a deep path inside env.home with backslash separator', () => {
    // isInside() uses path.relative(home, deepPath) under win32 semantics,
    // which returns 'skills\\a' — no '..' prefix, not absolute → accepted.
    // (The old trailingSlash('/')+startsWith check would have returned false
    // here because "C:\...\home\skills\a".startsWith("C:\...\home/") is false.)
    const deepPath = `${SANDBOX_HOME}\\skills\\a`;
    expect(() => assertInsideSandbox(deepPath, env)).not.toThrow();
  });

  it('accepts a path inside env.cwd with backslash separator', () => {
    const insideCwd = `${SANDBOX_CWD}\\src\\index.ts`;
    expect(() => assertInsideSandbox(insideCwd, env)).not.toThrow();
  });

  it('accepts an exact match on env.cwd', () => {
    expect(() => assertInsideSandbox(SANDBOX_CWD, env)).not.toThrow();
  });

  // ----- REJECT cases -------------------------------------------------------

  it('rejects a path completely outside the sandbox', () => {
    const outside = 'C:\\Users\\runneradmin\\AppData\\Roaming\\evil';
    expect(() => assertInsideSandbox(outside, env)).toThrow(/containment violation/);
  });

  it('rejects a sibling of env.home (prefix without separator — classic prefix attack)', () => {
    // "C:\...\home-evil" shares the string prefix "C:\...\home" but is NOT
    // inside it.  path.relative(home, sibling) returns '..\\home-evil' under
    // win32 semantics — starts with '..' → rejected.
    const sibling = SANDBOX_HOME + '-evil';
    expect(() => assertInsideSandbox(sibling, env)).toThrow(/containment violation/);
  });

  it('rejects the Windows filesystem root', () => {
    expect(() => assertInsideSandbox('C:\\', env)).toThrow(/containment violation/);
  });

  it('rejects a path in a completely different drive', () => {
    expect(() => assertInsideSandbox('D:\\attacker\\payload', env)).toThrow(
      /containment violation/,
    );
  });
});
