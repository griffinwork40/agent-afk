/**
 * Tests for `createBashRestrictionHook` — pre-tool-use gate that hard-blocks
 * bash invocations referencing restricted paths or evaluating interpreter
 * code.
 *
 * Threat-model invariant pinned by these tests:
 *   - Substring match catches the cat /restricted/path case we observed.
 *   - The interpreter denylist catches python -c, node -e, ruby -e, sh -c.
 *   - Variable-assembled bypasses are EXPLICITLY out of scope — see
 *     `bash-restriction-hook.ts` module header. The "documented bypass"
 *     test pins that behavior.
 */

import { describe, expect, it } from 'vitest';
import { createBashRestrictionHook } from './bash-restriction-hook.js';
import type { GrantManager } from '../../../cli/slash/commands/allow-dir.js';
import type { PreToolUseContext } from '../../hooks.js';
import { homedir } from 'os';

function mockGrants(): GrantManager {
  return {
    addReadRoot: () => {},
    addWriteRoot: () => {},
    revokeRoot: () => {},
    getGrants() {
      return { resolveBase: '/tmp/repo', readRoots: ['/tmp/repo'], writeRoots: ['/tmp/repo'] };
    },
  };
}

function ctx(command: unknown): PreToolUseContext {
  return { event: 'PreToolUse', toolName: 'bash', input: { command } };
}

describe('createBashRestrictionHook — interpreter denylist', () => {
  const hook = createBashRestrictionHook({ getGrantManager: mockGrants });

  it('blocks python -c', () => {
    const decision = hook(ctx('python -c "import os; print(os.uname())"'));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Interpreter');
  });

  it('blocks python3 -c', () => {
    expect(hook(ctx('python3 -c "1+1"')).decision).toBe('block');
  });

  it('blocks node -e', () => {
    expect(hook(ctx('node -e "console.log(1)"')).decision).toBe('block');
  });

  it('blocks ruby -e', () => {
    expect(hook(ctx('ruby -e "puts 1"')).decision).toBe('block');
  });

  it('blocks osascript -e', () => {
    expect(hook(ctx('osascript -e \'tell app "Finder" to quit\'')).decision).toBe('block');
  });

  it('blocks sh -c, bash -c, zsh -c, fish -c', () => {
    expect(hook(ctx('sh -c "rm x"')).decision).toBe('block');
    expect(hook(ctx('bash -c "rm x"')).decision).toBe('block');
    expect(hook(ctx('zsh -c "rm x"')).decision).toBe('block');
    expect(hook(ctx('fish -c "rm x"')).decision).toBe('block');
  });

  it('block message names typed file tools as the proper escape', () => {
    const decision = hook(ctx('python -c "open(\\"/etc/passwd\\").read()"'));
    expect(decision.reason).toMatch(/read_file|write_file|edit_file/);
  });

  it('does NOT block paths that just CONTAIN the interpreter name', () => {
    // `which python3` shouldn't match the denylist (python3 NOT followed by -c/-e).
    expect(hook(ctx('which python3')).decision).not.toBe('block');
    expect(hook(ctx('cat /usr/local/bin/python3-config')).decision).not.toBe('block');
  });

  it('does NOT block interpreter run without eval flag', () => {
    // `python3 script.py` is fine — not running code from the command line.
    expect(hook(ctx('python3 script.py')).decision).not.toBe('block');
  });
});

describe('createBashRestrictionHook — interpreter guard opt-out (AFK_DISABLE_BASH_INTERPRETER_GUARD)', () => {
  it('skips the interpreter denylist when disableInterpreterGuard is true', () => {
    const hook = createBashRestrictionHook({
      getGrantManager: mockGrants,
      disableInterpreterGuard: true,
    });
    expect(hook(ctx('python -c "1+1"')).decision).not.toBe('block');
    expect(hook(ctx('sh -c "echo hi"')).decision).not.toBe('block');
    expect(hook(ctx('node -e "console.log(1)"')).decision).not.toBe('block');
  });

  it('opting out does NOT weaken the restricted-root substring check', () => {
    // The granular escape lifts ONLY the interpreter denylist — a bash command
    // that literally references a restricted path must still be blocked.
    const hook = createBashRestrictionHook({
      getGrantManager: mockGrants,
      disableInterpreterGuard: true,
    });
    const decision = hook(ctx(`cat ${homedir()}/.ssh/id_rsa`));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/restricted path/);
  });

  it('guard is active by default when the option is omitted', () => {
    const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
    expect(hook(ctx('python -c "1+1"')).decision).toBe('block');
  });
});

describe('createBashRestrictionHook — interpreter guard interactivity gate (H2)', () => {
  // The interpreter denylist hard-blocks only on INTERACTIVE surfaces (a wired
  // grant manager), where the model can be redirected to the prompt-able typed
  // file tools. On HEADLESS surfaces (no grant manager) it fails open by
  // default so legitimate automation (`python -c`, `sh -c`) is not hard-blocked
  // with no recourse — the day-one regression this gate fixes.

  it('does NOT block interpreter eval on a headless surface (no grant manager wired)', () => {
    const hook = createBashRestrictionHook({ getGrantManager: () => undefined });
    expect(hook(ctx('python -c "1+1"')).decision).not.toBe('block');
    expect(hook(ctx('sh -c "echo hi"')).decision).not.toBe('block');
    expect(hook(ctx('node -e "console.log(1)"')).decision).not.toBe('block');
  });

  it('DOES block interpreter eval on an interactive surface (grant manager wired)', () => {
    const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
    expect(hook(ctx('python -c "1+1"')).decision).toBe('block');
  });

  it('forceInterpreterGuard re-enables the denylist on headless surfaces', () => {
    const hook = createBashRestrictionHook({
      getGrantManager: () => undefined,
      forceInterpreterGuard: true,
    });
    const decision = hook(ctx('python -c "1+1"'));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Interpreter');
  });

  it('disableInterpreterGuard wins over forceInterpreterGuard (explicit OFF beats opt-in ON)', () => {
    const hook = createBashRestrictionHook({
      getGrantManager: mockGrants,
      disableInterpreterGuard: true,
      forceInterpreterGuard: true,
    });
    expect(hook(ctx('python -c "1+1"')).decision).not.toBe('block');
  });

  it('forcing the guard on headless does not change the substring check (stays open)', () => {
    const hook = createBashRestrictionHook({
      getGrantManager: () => undefined,
      forceInterpreterGuard: true,
    });
    // A plain restricted-path cat (no interpreter) stays open on headless —
    // forceInterpreterGuard only governs the interpreter denylist.
    expect(hook(ctx(`cat ${homedir()}/.ssh/id_rsa`)).decision).not.toBe('block');
  });
});

describe('createBashRestrictionHook — restricted-root substring', () => {
  const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
  const home = homedir();

  it('blocks `cat ~/.ssh/...`', () => {
    const decision = hook(ctx(`cat ${home}/.ssh/id_rsa`));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/restricted path/);
  });

  it('blocks `cat ~/.aws/credentials`', () => {
    const decision = hook(ctx(`cat ${home}/.aws/credentials`));
    expect(decision.decision).toBe('block');
  });

  it('block reason names the restricted prefix', () => {
    const decision = hook(ctx(`grep secret ${home}/.gnupg/keys`));
    expect(decision.reason).toContain('.gnupg');
  });

  it('normalizes ~ to HOME before checking', () => {
    const decision = hook(ctx('cat ~/.ssh/id_rsa'));
    expect(decision.decision).toBe('block');
  });

  it('does NOT block ordinary commands', () => {
    expect(hook(ctx('ls')).decision).not.toBe('block');
    expect(hook(ctx('git status')).decision).not.toBe('block');
    expect(hook(ctx('pnpm test')).decision).not.toBe('block');
    expect(hook(ctx('which git')).decision).not.toBe('block');
  });

  it('DOCUMENTED BYPASS: variable assembly slips through (threat-model invariant)', () => {
    // This test PINS the documented invariant: this hook is for accidental
    // access prevention, NOT adversarial containment. Variable-assembled
    // paths and interpreter denylist evasion are EXPLICIT non-goals.
    // If this test ever starts failing because someone "fixed" the bypass,
    // do NOT extend the parser — refer back to the threat-model invariant
    // in the module header and either accept the new behavior or escalate
    // to OS-level sandboxing.
    //
    // Why this slips: we normalize `$HOME` and `~`, but `H=$HOME; cat $H/...`
    // assigns the value to `$H` first. The substring check sees only the
    // text "cat $H/.ssh/id_rsa", which doesn't contain any restricted prefix
    // literally.
    const decision = hook(ctx('H=$HOME; cat $H/.ssh/id_rsa'));
    expect(decision.decision).not.toBe('block');
  });

  it('the straightforward $HOME / ~ form IS caught (counterpoint to bypass)', () => {
    // The non-adversarial accident case — model directly writes the path
    // using $HOME or ~. Both get normalized and matched.
    expect(hook(ctx('cat $HOME/.ssh/id_rsa')).decision).toBe('block');
    expect(hook(ctx('cat ~/.ssh/id_rsa')).decision).toBe('block');
  });
});

describe('createBashRestrictionHook — grant containment direction (F4 regression)', () => {
  const home = homedir();
  const appSupport = `${home}/Library/Application Support`;

  function grantsWith(extraReadRoot: string): GrantManager {
    return {
      addReadRoot: () => {},
      addWriteRoot: () => {},
      revokeRoot: () => {},
      getGrants() {
        return {
          resolveBase: '/tmp/repo',
          readRoots: ['/tmp/repo', extraReadRoot],
          writeRoots: ['/tmp/repo'],
        };
      },
    };
  }

  it('granting a NARROW subdir does NOT un-gate the sensitive parent or its siblings', () => {
    // Regression: before the fix `path.relative(candidate, granted)` matched a
    // granted CHILD and dropped the whole parent candidate. Granting only the
    // Cursor config dir must leave the rest of Application Support restricted.
    const hook = createBashRestrictionHook({
      getGrantManager: () => grantsWith(`${appSupport}/Cursor/User`),
    });
    const decision = hook(ctx(`cat "${appSupport}/Firefox/Profiles/logins.json"`));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Application Support');
  });

  it('granting the candidate itself (or an ancestor) DOES drop it from restriction', () => {
    // User granted ALL of Application Support → a path under it is not blocked.
    const hook = createBashRestrictionHook({
      getGrantManager: () => grantsWith(appSupport),
    });
    const decision = hook(ctx(`cat "${appSupport}/Cursor/User/settings.json"`));
    expect(decision.decision).not.toBe('block');
  });
});

describe('createBashRestrictionHook — wiring failsafes', () => {
  it('fails open when grant manager is undefined (bootstrap race)', () => {
    const hook = createBashRestrictionHook({ getGrantManager: () => undefined });
    const decision = hook(ctx(`cat ${homedir()}/.ssh/id_rsa`));
    // Substring check is gated by grant manager — when unwired, fail open.
    expect(decision.decision).not.toBe('block');
  });

  it('does NOT block on non-bash tools', () => {
    const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
    expect(hook({ event: 'PreToolUse', toolName: 'read_file', input: { file_path: '/etc/passwd' } }).decision).not.toBe('block');
  });
});
