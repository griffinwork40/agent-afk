/**
 * Equivalence (golden / characterization) tests for check 2 of
 * `createBashRestrictionHook` — the restricted-root substring guard.
 *
 * Purpose (#3847, step B):
 *   These tests pin the **current allow/deny outcomes** for a representative
 *   set of commands BEFORE the credential-floor decision is routed through
 *   `decidePathAccess`. They must pass identically before and after that
 *   migration; any divergence indicates a behaviour change that must be
 *   investigated before merging.
 *
 * Scope: check 2 only. Check 1 (interpreter-eval guard) is covered by the
 * main bash-restriction-hook.test.ts suite. This file focuses on the
 * substring scan and its interaction with the credential floor, grant
 * filtering, headless floor, and carve-outs.
 *
 * Threat-model invariant (load-bearing — do not weaken):
 *   - Paths that are DENIED today must remain denied after the migration.
 *   - Paths that are ALLOWED today must remain allowed after the migration.
 *   - No new denials or grants are introduced by this step.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { homedir } from 'os';
import { join, resolve } from 'path';

import { createBashRestrictionHook } from './bash-restriction-hook.js';
import { _resetReadDenylistCacheForTests } from '../handlers/read-denylist.js';
import { resetAfkHomeWarnLatchForTests } from '../afk-home-warn.js';
import { safeRealpath } from '../handlers/write-denylist.js';
import type { GrantManager } from '../grant-manager.js';
import type { PreToolUseContext } from '../../hooks.js';

const HOME = homedir();

afterEach(() => {
  vi.unstubAllEnvs();
  _resetReadDenylistCacheForTests();
  resetAfkHomeWarnLatchForTests();
});

// ---------------------------------------------------------------------------
// Helpers — mirrors the shape used in the main test suite
// ---------------------------------------------------------------------------

/** Grant manager rooted at /tmp/repo (narrow, does NOT cover any credential root). */
function narrowGrants(): GrantManager {
  const base = resolve('/tmp/repo');
  return {
    addReadRoot: () => {},
    addWriteRoot: () => {},
    revokeRoot: () => {},
    getGrants() {
      return { resolveBase: base, readRoots: [base], writeRoots: [base] };
    },
  };
}

/** Grant manager rooted at HOME — simulates a wide-scoped interactive session. */
function homeAnchoredGrants(): GrantManager {
  return {
    addReadRoot: () => {},
    addWriteRoot: () => {},
    revokeRoot: () => {},
    getGrants() {
      return { resolveBase: HOME, readRoots: [HOME], writeRoots: [HOME] };
    },
  };
}

/** Interactive context (grant manager wired, nonInteractive absent). */
function ctx(command: string, gm: GrantManager = narrowGrants()): PreToolUseContext {
  return { event: 'PreToolUse', toolName: 'bash', input: { command }, grantManager: gm };
}

/** Headless context — no grant manager, simulating production nonInteractive. */
function headlessCtx(command: string): PreToolUseContext {
  return { event: 'PreToolUse', toolName: 'bash', input: { command } };
}

/** nonInteractive=true with a real grant manager — the production headless shape. */
function prodHeadless(command: string): PreToolUseContext {
  return {
    event: 'PreToolUse',
    toolName: 'bash',
    input: { command },
    grantManager: homeAnchoredGrants(),
    nonInteractive: true,
  };
}

const hook = createBashRestrictionHook({ disableInterpreterGuard: true });

// ---------------------------------------------------------------------------
// DENIED — BUILTIN_READ_DENYLIST credential roots (interactive, narrow grants)
//
// These are the credential paths that `decidePathAccess` must agree with after
// the migration. The lexical scan finds them; the policy point must confirm.
// ---------------------------------------------------------------------------

describe('check2-policy equivalence: BUILTIN_READ_DENYLIST roots — interactive, narrow grants', () => {
  it.each([
    ['~/.ssh root', `cat ~/.ssh/id_rsa`],
    ['~/.ssh id_ed25519', `cat ${HOME}/.ssh/id_ed25519`],
    ['~/.aws', `cat ${HOME}/.aws/credentials`],
    ['~/.gnupg', `ls ${HOME}/.gnupg/`],
    ['~/.config/gcloud', `cat ${HOME}/.config/gcloud/application_default_credentials.json`],
    ['~/.afk/config', `cat ${HOME}/.afk/config/afk.env`],
    ['~/.npmrc', `cat ${HOME}/.npmrc`],
    ['~/.docker/config.json', `cat ${HOME}/.docker/config.json`],
    ['~/.git-credentials', `cat ${HOME}/.git-credentials`],
    ['~/.netrc', `cat ${HOME}/.netrc`],
    ['~/.config/gh/hosts.yml', `cat ${HOME}/.config/gh/hosts.yml`],
    ['~/.kube/config', `cat ${HOME}/.kube/config`],
    ['~/.password-store', `cat ${HOME}/.password-store/email.gpg`],
    ['/etc/shadow', 'cat /etc/shadow'],
    ['/etc/sudoers', 'cat /etc/sudoers'],
  ] as [string, string][])(
    'DENIED: %s',
    (_label, command) => {
      const decision = hook(ctx(command));
      expect(decision.decision).toBe('block');
      expect(decision.ruleId).toBe('bash-restriction.restricted-path');
    },
  );
});

// ---------------------------------------------------------------------------
// DENIED — bash-only extras (wider than BUILTIN_READ_DENYLIST)
// ---------------------------------------------------------------------------

describe('check2-policy equivalence: bash-only extra roots — interactive, narrow grants', () => {
  it.each([
    ['~/Library/Application Support', `cat "${HOME}/Library/Application Support/Google/Chrome/Default/Cookies"`],
    ['~/Library/LaunchAgents', `cat ${HOME}/Library/LaunchAgents/com.example.plist`],
    ['~/Library/LaunchDaemons', `cat ${HOME}/Library/LaunchDaemons/com.example.plist`],
    ['/Library/LaunchAgents', 'cat /Library/LaunchAgents/com.example.plist'],
    ['/Library/LaunchDaemons', 'cat /Library/LaunchDaemons/com.example.plist'],
    ['~/.config/gh (dir-wide)', `ls ${HOME}/.config/gh/`],
  ] as [string, string][])(
    'DENIED: %s',
    (_label, command) => {
      const decision = hook(ctx(command));
      expect(decision.decision).toBe('block');
      expect(decision.ruleId).toBe('bash-restriction.restricted-path');
    },
  );
});

// ---------------------------------------------------------------------------
// DENIED — headless floor (no grant filtering, production nonInteractive shape)
// ---------------------------------------------------------------------------

describe('check2-policy equivalence: headless floor (nonInteractive=true + home-anchored GM)', () => {
  // On headless surfaces the full builtin floor is used with NO grant
  // filtering (#2302). These must remain denied even when the grant manager's
  // resolveBase covers the whole home directory.
  it.each([
    ['~/.ssh key', `cat ${HOME}/.ssh/id_rsa`],
    ['~/.afk/config (env)', `cat ${HOME}/.afk/config/afk.env`],
    ['~/.afk/config (append)', `echo x >> ${HOME}/.afk/config/afk.env`],
    ['~/.afk/config/mcp.json (headless blocks carve-out)', `cat ${HOME}/.afk/config/mcp.json`],
    ['~/.afk/config/schedules.json (headless blocks carve-out)', `echo x >> ${HOME}/.afk/config/schedules.json`],
    ['/etc/shadow', 'cat /etc/shadow'],
  ] as [string, string][])(
    'DENIED on headless: %s',
    (_label, command) => {
      const decision = hook(prodHeadless(command));
      expect(decision.decision).toBe('block');
      expect(decision.reason).toMatch(/headless surface/);
    },
  );

  // No-grant-manager headless path (alternative headless shape).
  it.each([
    ['~/.ssh key (no-GM)', `cat ${HOME}/.ssh/id_rsa`],
    ['~/.afk/config (no-GM)', `cat ${HOME}/.afk/config/afk.env`],
  ] as [string, string][])(
    'DENIED on headless (no grant manager): %s',
    (_label, command) => {
      const decision = hook(headlessCtx(command));
      expect(decision.decision).toBe('block');
    },
  );
});

// ---------------------------------------------------------------------------
// ALLOWED — ordinary commands that must NOT be blocked
// ---------------------------------------------------------------------------

describe('check2-policy equivalence: ALLOWED ordinary commands', () => {
  it.each([
    ['ls', 'ls'],
    ['git status', 'git status'],
    ['pnpm test', 'pnpm test'],
    ['which git', 'which git'],
    ['cat /etc/passwd (world-readable, not in denylist)', 'cat /etc/passwd'],
    ['echo hi', 'echo hi'],
    ['ls /tmp', 'ls /tmp'],
    ['cat /usr/local/bin/python3-config (not interpreter match)', 'cat /usr/local/bin/python3-config'],
  ] as [string, string][])(
    'ALLOWED: %s',
    (_label, command) => {
      expect(hook(ctx(command)).decision).not.toBe('block');
    },
  );
});

// ---------------------------------------------------------------------------
// ALLOWED — interactive carve-outs (exact-file allowlist, provably read-only)
// ---------------------------------------------------------------------------

describe('check2-policy equivalence: interactive read carve-outs', () => {
  it('allows cat of ~/.afk/config/mcp.json on interactive surface', () => {
    // isProvablyReadOnly gate lets the scrub blank the exact-file carve-out.
    expect(hook(ctx(`cat ${join(HOME, '.afk', 'config', 'mcp.json')}`)).decision).not.toBe('block');
  });

  it('allows cat of ~/.afk/config/mcp.json with ~ spelling on interactive surface', () => {
    expect(hook(ctx('cat ~/.afk/config/mcp.json')).decision).not.toBe('block');
  });
});

// ---------------------------------------------------------------------------
// ALLOWED — grant-filtered interactive: home-anchored grants drop credential
//            roots from the restricted set (Option A, #740)
// ---------------------------------------------------------------------------

describe('check2-policy equivalence: home-anchored grants drop home-dir credential roots', () => {
  const homeCtx = (command: string) => ctx(command, homeAnchoredGrants());

  it('allows cat ~/.ssh/id_rsa when resolveBase=HOME (grant covers the root)', () => {
    // This is Option A, #740: resolveBase containment can drop a builtin
    // credential root from the bash restriction list. The typed tools still
    // floor it; only the shell surface relaxes.
    expect(hook(homeCtx(`cat ${HOME}/.ssh/id_rsa`)).decision).not.toBe('block');
  });

  it('allows cat ~/.afk/config/afk.env when resolveBase=HOME', () => {
    expect(hook(homeCtx(`cat ${HOME}/.afk/config/afk.env`)).decision).not.toBe('block');
  });

  it('still blocks /etc/shadow even with home-anchored grants (outside home)', () => {
    // /etc/shadow is outside HOME; no home-anchored grant covers it.
    expect(hook(homeCtx('cat /etc/shadow')).decision).toBe('block');
  });
});

// ---------------------------------------------------------------------------
// Block message shape — invariants that must be preserved post-migration
// ---------------------------------------------------------------------------

describe('check2-policy equivalence: block message invariants', () => {
  it.each([false, true])('distinguishes credential-floor matches from bash-only extras (headless=%s)', (headless) => {
    vi.stubEnv('AFK_READ_DENYLIST', '');
    _resetReadDenylistCacheForTests();
    const context = headless ? prodHeadless : ctx;
    const credential = hook(context('cat /etc/shadow'));
    const extraRoot = join(HOME, 'Library', 'LaunchAgents');
    const extra = hook(context(`cat "${extraRoot}/x.plist"`));
    expect(credential.decision).toBe('block');
    expect(credential.reason).toContain(`restricted path (/etc/shadow) (credential floor: ${safeRealpath('/etc/shadow')})`);
    expect(extra.decision).toBe('block');
    expect(extra.reason).toContain(`restricted path (${extraRoot})`);
    expect(extra.reason).not.toContain('credential floor:');
    expect(hook(context('cat /etc/passwd')).decision).not.toBe('block');
  });

  it.each([false, true])('retains the matched root when an operator floor is wider (headless=%s)', (headless) => {
    vi.stubEnv('AFK_READ_DENYLIST', HOME);
    _resetReadDenylistCacheForTests();
    const context = headless ? prodHeadless : ctx;
    const d = hook(context(`cat ${HOME}/.ssh/id_rsa`));
    expect(d.decision).toBe('block');
    expect(d.reason).toContain(`restricted path (${join(HOME, '.ssh')}) (credential floor: ${safeRealpath(HOME)})`);
    expect(hook(context('cat /etc/passwd')).decision).not.toBe('block');
  });

  it('interactive block names /allow-dir escape hatch', () => {
    const d = hook(ctx(`cat ${HOME}/.ssh/id_rsa`));
    expect(d.decision).toBe('block');
    expect(d.reason).toMatch(/\/allow-dir/);
    expect(d.reason).not.toMatch(/headless surface/);
  });

  it('headless block does NOT name /allow-dir (no human to approve)', () => {
    const d = hook(prodHeadless(`cat ${HOME}/.ssh/id_rsa`));
    expect(d.decision).toBe('block');
    expect(d.reason).toMatch(/headless surface/);
    expect(d.reason).not.toMatch(/\/allow-dir/);
  });

  it('LaunchAgents block names `afk service install`', () => {
    const d = hook(ctx(`cat ${HOME}/Library/LaunchAgents/x.plist`));
    expect(d.decision).toBe('block');
    expect(d.reason).toContain('afk service install');
  });

  it('~/.afk/config block names config_get / config_set', () => {
    const d = hook(ctx(`cat ${HOME}/.afk/config/afk.env`));
    expect(d.decision).toBe('block');
    expect(d.reason).toContain('config_get');
    expect(d.reason).toContain('config_set');
  });

  it('ruleId is bash-restriction.restricted-path for all check-2 blocks', () => {
    const commands = [
      `cat ${HOME}/.ssh/id_rsa`,
      `cat ${HOME}/.aws/credentials`,
      `cat ${HOME}/.afk/config/afk.env`,
      'cat /etc/shadow',
    ];
    for (const command of commands) {
      const d = hook(ctx(command));
      expect(d.ruleId).toBe('bash-restriction.restricted-path');
    }
  });
});

// ---------------------------------------------------------------------------
// Documented bypass — variable assembly; pinned as invariant (must NOT change)
// ---------------------------------------------------------------------------

describe('check2-policy equivalence: documented bypass invariant', () => {
  it('variable assembly slips through (threat-model invariant — do not fix)', () => {
    // This pins the documented non-goal: the hook only blocks ACCIDENTAL access.
    // Variable-assembled paths are out of scope; OS-level sandboxing is needed
    // for adversarial containment. If this test starts failing because someone
    // "fixed" the bypass, re-read the module-header threat model first.
    expect(hook(ctx('H=$HOME; cat $H/.ssh/id_rsa')).decision).not.toBe('block');
  });

  it('$HOME normalization IS caught (counterpoint)', () => {
    expect(hook(ctx('cat $HOME/.ssh/id_rsa')).decision).toBe('block');
    expect(hook(ctx('cat ~/.ssh/id_rsa')).decision).toBe('block');
  });
});
