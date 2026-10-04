// Regression (#703 Windows leg, SECURITY): on win32 the bash credential floor
// failed OPEN. `normalizeHomeRefs` rewrites every `\` in the scanned command to
// `/`, but the restricted roots come from `path.join` / `safeRealpath` and are
// backslash paths (`C:\Users\alice\.ssh`), so the literal `includes()` could
// never match: `cat ~/.ssh/id_rsa`, `cat $HOME/.aws/credentials`, the native
// `cat C:\Users\alice\.ssh\id_rsa`, and the Git Bash `cat /c/Users/alice/...`
// spelling all passed with an interactive grant manager wired.
//
// This file runs the hook under win32 `path` semantics and a win32-shaped
// `os.homedir()` on ANY host, so the regression is pinned on the default
// (POSIX) CI matrix too. It is a separate file because `vi.mock` is
// file-scoped, and because on a POSIX host `path === path.posix`, so spying on
// `path.resolve` would also clobber the posix normaliser the hook relies on
// (precedent: handlers/bash-scan-exempt.win32.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GrantManager } from '../grant-manager.js';
import type { PreToolUseContext } from '../../hooks.js';

const host = vi.hoisted(() => ({
  home: 'C:\\Users\\alice',
  /** Simulated `realpathSync` table: 8.3 short-name spelling → long spelling. */
  realpaths: new Map<string, string>(),
}));

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  const win = { ...actual.win32, posix: actual.posix, win32: actual.win32 };
  return { ...win, default: win };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const patched = { ...actual, homedir: () => host.home };
  return { ...patched, default: patched };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  // Only win32-shaped paths are simulated; anything else (the POSIX sentinel
  // dirs the global setup creates) keeps real host behaviour.
  const realpathSync = ((p: string) => {
    if (!/^[A-Za-z]:\\/.test(p)) return actual.realpathSync(p);
    for (const [short, long] of host.realpaths) {
      if (p === short || p.startsWith(`${short}\\`)) return long + p.slice(short.length);
    }
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  }) as typeof actual.realpathSync;
  const patched = { ...actual, realpathSync };
  return { ...patched, default: patched };
});

type HookModule = typeof import('./bash-restriction-hook.js');

function winGrants(extraReadRoot?: string): GrantManager {
  return {
    addReadRoot: () => {},
    addWriteRoot: () => {},
    revokeRoot: () => {},
    getGrants: () => ({
      resolveBase: 'D:\\repo',
      readRoots: ['D:\\repo', ...(extraReadRoot === undefined ? [] : [extraReadRoot])],
      writeRoots: ['D:\\repo'],
    }),
  };
}

function ctx(command: string, grantManager?: GrantManager): PreToolUseContext {
  return {
    event: 'PreToolUse',
    toolName: 'bash',
    input: { command },
    ...(grantManager !== undefined ? { grantManager } : {}),
  };
}

/**
 * Fresh module graph per scenario: `read-denylist.ts` snapshots the canonical
 * home at import, so a different simulated home needs a re-import.
 */
async function loadHook(home: string, realpaths: Array<[string, string]> = []): Promise<HookModule> {
  host.home = home;
  host.realpaths = new Map(realpaths);
  vi.resetModules();
  vi.stubEnv('AFK_HOME', `${home}\\.afk`);
  vi.stubEnv('AFK_READ_DENYLIST', '');
  // NTFS is case-insensitive; pin that instead of probing the test host's fs.
  (await import('../fs-case.js'))._resetFsCaseCacheForTests(true);
  return import('./bash-restriction-hook.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('bash-restriction hook under win32 semantics — credential floor holds (#703)', () => {
  let hook: ReturnType<HookModule['createBashRestrictionHook']>;
  let mgr: GrantManager;

  beforeEach(async () => {
    const mod = await loadHook('C:\\Users\\alice');
    mgr = winGrants();
    // Interpreter guard OFF so every decision below is check 2 (the substring
    // floor) alone — the check that was failing open.
    hook = mod.createBashRestrictionHook({ disableInterpreterGuard: true });
  });

  it.each([
    ['tilde (what a model types in Git Bash)', 'cat ~/.ssh/id_rsa'],
    ['$HOME', 'cat $HOME/.aws/credentials'],
    ['${HOME}', 'cat ${HOME}/.gnupg/secring.gpg'],
    ['native backslash', 'type C:\\Users\\alice\\.ssh\\id_rsa'],
    ['drive with forward slashes', 'cat C:/Users/alice/.ssh/id_ed25519'],
    ['Git Bash /c/ mount (the $HOME expansion inside Git Bash)', 'cat /c/Users/alice/.ssh/id_rsa'],
    ['case-folded Git Bash mount', 'cat /C/users/ALICE/.aws/credentials'],
    ['quoted native path', 'cat "C:\\Users\\alice\\.docker\\config.json"'],
    ['AFK credential tree', 'cat ~/.afk/config/afk.env'],
    ['git credential store', 'cat /c/Users/alice/.git-credentials'],
    ['kube config', 'cat $HOME/.kube/config'],
  ])('blocks the %s spelling', (_label, command) => {
    const decision = hook(ctx(command, mgr));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/restricted path/);
  });

  it('does NOT block ordinary commands or non-credential home paths', () => {
    expect(hook(ctx('ls', mgr)).decision).not.toBe('block');
    expect(hook(ctx('git status', mgr)).decision).not.toBe('block');
    expect(hook(ctx('cat ~/project/README.md', mgr)).decision).not.toBe('block');
    expect(hook(ctx('cat /c/Users/alice/.afk/state/todos/x.json', mgr)).decision).not.toBe('block');
  });

  it('keeps the exact-file carve-outs readable in every win32 spelling', () => {
    expect(hook(ctx('cat ~/.ssh/config', mgr)).decision).not.toBe('block');
    expect(hook(ctx('cat $HOME/.ssh/known_hosts', mgr)).decision).not.toBe('block');
    expect(hook(ctx('cat C:\\Users\\alice\\.ssh\\config', mgr)).decision).not.toBe('block');
    expect(hook(ctx('cat /c/Users/alice/.afk/config/mcp.json', mgr)).decision).not.toBe('block');
  });

  it('keeps the carve-outs EXACT-file: siblings and backups stay blocked', () => {
    expect(hook(ctx('cat ~/.ssh/config.bak', mgr)).decision).toBe('block');
    expect(hook(ctx('cat /c/Users/alice/.ssh/config"/../id_rsa"', mgr)).decision).toBe('block');
    expect(hook(ctx('cat C:\\Users\\alice\\.afk\\config\\mcp.json.bak', mgr)).decision).toBe('block');
  });

  it('interpreter guard still catches a native-path one-liner when enabled', async () => {
    const mod = await import('./bash-restriction-hook.js');
    const guarded = mod.createBashRestrictionHook({});
    expect(
      guarded(ctx('python -c "open(r\'C:\\Users\\alice\\.ssh\\id_rsa\').read()"', winGrants())).decision,
    ).toBe('block');
  });

  it('an explicit grant of the credential root still lifts it (grant filter unchanged)', async () => {
    const mod = await import('./bash-restriction-hook.js');
    const granted = mod.createBashRestrictionHook({ disableInterpreterGuard: true });
    const grantedMgr = winGrants('C:\\Users\\alice\\.ssh');
    expect(granted(ctx('cat ~/.ssh/id_rsa', grantedMgr)).decision).not.toBe('block');
    expect(granted(ctx('cat ~/.aws/credentials', grantedMgr)).decision).toBe('block');
  });
});

describe('bash-restriction hook under win32 semantics — 8.3 short-name home (#703)', () => {
  // USERPROFILE can be an 8.3 short path (`C:\Users\ALICE~1`). `~` / `$HOME`
  // are substituted with that raw spelling, while read-denylist.ts keys its
  // roots to the realpath'd long spelling — both must be matched.
  let hook: ReturnType<HookModule['createBashRestrictionHook']>;
  let mgr: GrantManager;

  beforeEach(async () => {
    const mod = await loadHook('C:\\Users\\ALICE~1', [['C:\\Users\\ALICE~1', 'C:\\Users\\alice.long']]);
    mgr = winGrants();
    hook = mod.createBashRestrictionHook({ disableInterpreterGuard: true });
  });

  it.each([
    'cat ~/.ssh/id_rsa',
    'cat $HOME/.aws/credentials',
    'cat C:\\Users\\alice.long\\.ssh\\id_rsa',
    'cat /c/Users/alice.long/.npmrc',
    'cat /c/Users/ALICE~1/.afk/config/afk.env',
  ])('blocks %s', (command) => {
    expect(hook(ctx(command, mgr)).decision).toBe('block');
  });

  it('a grant spelled with the short-name home lifts the realpath-keyed root', async () => {
    // Same directory, two spellings: the read denylist keys .ssh to the long
    // form while `/allow-dir ~/.ssh` resolves through the raw short home.
    const mod = await import('./bash-restriction-hook.js');
    const granted = mod.createBashRestrictionHook({ disableInterpreterGuard: true });
    const grantedMgr = winGrants('C:\\Users\\ALICE~1\\.ssh');
    expect(granted(ctx('cat ~/.ssh/id_rsa', grantedMgr)).decision).not.toBe('block');
    expect(granted(ctx('cat C:\\Users\\alice.long\\.ssh\\id_rsa', grantedMgr)).decision).not.toBe('block');
    expect(granted(ctx('cat ~/.aws/credentials', grantedMgr)).decision).toBe('block');
  });

  it('a grant on an unrelated MSYS-looking dir cannot lift the floor', async () => {
    const mod = await import('./bash-restriction-hook.js');
    const granted = mod.createBashRestrictionHook({ disableInterpreterGuard: true });
    const grantedMgr = winGrants('C:\\c');
    expect(granted(ctx('cat /c/Users/alice.long/.ssh/id_rsa', grantedMgr)).decision).toBe('block');
  });

  // Carve-out readability under an 8.3 home is deliberately NOT asserted here:
  // read-denylist-carveout.ts keys CARVEOUT_PIERCED_SOURCE to the raw
  // homedir() while the builtin roots are realpath'd, so the typed-tool layer
  // gates those carve-outs out (fail-CLOSED, over-block) before this hook sees
  // them. That is a separate, pre-existing issue outside this regression.
});

describe('restrictedRootSpellings — POSIX roots are a byte-identical no-op', () => {
  it('returns a POSIX root as its only spelling', async () => {
    const { restrictedRootSpellings } = await import('./bash-restriction-hook.win32-spellings.js');
    expect(restrictedRootSpellings('/home/alice/.ssh', '/home/alice')).toEqual(['/home/alice/.ssh']);
    expect(restrictedRootSpellings('/etc/shadow', 'C:\\Users\\alice')).toEqual(['/etc/shadow']);
  });
});
