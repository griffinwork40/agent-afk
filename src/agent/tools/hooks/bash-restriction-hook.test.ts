/**
 * Tests for `createBashRestrictionHook` — pre-tool-use gate that hard-blocks
 * bash invocations referencing restricted paths, plus interpreter `-c`/`-e`
 * one-liners whose payload references those same sensitive paths.
 *
 * Threat-model invariant pinned by these tests:
 *   - Substring match catches the cat /restricted/path case we observed.
 *   - The interpreter guard is SCOPED to credential-adjacent payloads: it
 *     catches `python -c`/`node -e`/`sh -c` one-liners that reference a
 *     sensitive path (`.ssh`, `id_rsa`, `.aws`, `/etc/shadow`, or a
 *     home path assembled at runtime), but NOT pure-computation one-liners
 *     (`python -c "1+1"`) — those touch no secret, so blocking them was pure
 *     friction. See the module-header History note.
 *   - Variable-assembled / string-split bypasses are EXPLICITLY out of scope —
 *     see `bash-restriction-hook.ts` module header. The "documented bypass"
 *     test pins that behavior.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  builtinBashSensitiveRoots,
  createBashRestrictionHook,
  deriveRestrictedSubstrings,
  SENSITIVE_PATH_SIGNAL,
} from './bash-restriction-hook.js';
import { _resetReadDenylistCacheForTests } from '../handlers/read-denylist.js';
import { resetAfkHomeWarnLatchForTests } from '../afk-home-warn.js';
import type { GrantManager } from '../../../cli/slash/commands/allow-dir.js';
import type { PreToolUseContext } from '../../hooks.js';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs';

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

describe('createBashRestrictionHook — interpreter denylist (scoped to credential-adjacent payloads)', () => {
  const hook = createBashRestrictionHook({ getGrantManager: mockGrants });

  // --- BLOCKS: interpreter one-liners that reference a sensitive path ---

  it('blocks python -c that reads an SSH key', () => {
    const decision = hook(ctx('python -c "print(open(\'~/.ssh/id_rsa\').read())"'));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Interpreter');
  });

  it('blocks node -e that references cloud credentials', () => {
    expect(
      hook(ctx('node -e "require(\'fs\').readFileSync(process.env.HOME + \'/.aws/credentials\')"'))
        .decision,
    ).toBe('block');
  });

  it('blocks sh -c that cats an SSH key', () => {
    expect(hook(ctx('sh -c "cat ~/.ssh/id_ed25519"')).decision).toBe('block');
  });

  it('blocks a home path the interpreter assembles at runtime (the gap check 2 cannot see)', () => {
    // check 2's literal-substring scan never sees this — the home dir is built
    // by expanduser at runtime — but the `.ssh` / `id_rsa` fragments do.
    expect(
      hook(ctx('python3 -c "import os; open(os.path.expanduser(\'~/.ssh/id_rsa\'))"')).decision,
    ).toBe('block');
  });

  it('blocks an interpreter one-liner assembling a Library/Application Support path', () => {
    // ~/Library/Application Support holds Chrome "Login Data" (saved passwords)
    // and Cookies (session tokens) — a deriveRestrictedSubstrings root. The
    // quote-prefixed `~` is NOT normalized, so check 2's literal scan misses it;
    // only the SENSITIVE_PATH_SIGNAL fragment (check 1) catches this.
    expect(
      hook(
        ctx(
          'python3 -c "import os; open(os.path.expanduser(\'~/Library/Application Support/Google/Chrome/Default/Login Data\'))"',
        ),
      ).decision,
    ).toBe('block');
  });

  it('DOES block interpreter reads of /etc/shadow', () => {
    expect(hook(ctx('sh -c "cat /etc/shadow"')).decision).toBe('block');
  });

  it('block message names typed file tools as the proper escape', () => {
    const decision = hook(ctx('python -c "open(\'~/.ssh/id_rsa\').read()"'));
    expect(decision.reason).toMatch(/read_file|write_file|edit_file/);
  });

  // --- PASSES: pure-computation one-liners touch no sensitive path (the calibration) ---

  it('does NOT block pure-computation python -c', () => {
    // Previously blocked as blanket friction; now allowed — no secret is touched.
    expect(hook(ctx('python -c "1+1"')).decision).not.toBe('block');
    expect(hook(ctx('python3 -c "print(2**64)"')).decision).not.toBe('block');
  });

  it('does NOT block pure-computation node -e / ruby -e', () => {
    expect(hook(ctx('node -e "console.log(1)"')).decision).not.toBe('block');
    expect(hook(ctx('ruby -e "puts 1"')).decision).not.toBe('block');
  });

  it('does NOT block sh -c / bash -c / zsh -c that touch no sensitive path', () => {
    expect(hook(ctx('sh -c "rm x"')).decision).not.toBe('block');
    expect(hook(ctx('bash -c "echo hi"')).decision).not.toBe('block');
    expect(hook(ctx('zsh -c "ls"')).decision).not.toBe('block');
  });

  it('does NOT block interpreter reads of world-readable /etc/passwd (no secret)', () => {
    // /etc/passwd is world-readable and carries no secret; /etc/shadow does.
    expect(hook(ctx('python -c "print(open(\'/etc/passwd\').read())"')).decision).not.toBe('block');
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
  it('skips the interpreter guard when disableInterpreterGuard is true', () => {
    const hook = createBashRestrictionHook({
      getGrantManager: mockGrants,
      disableInterpreterGuard: true,
    });
    // Even credential-adjacent one-liners (which WOULD block by default, and
    // which check 2 misses because the path is quote-tilde / runtime-assembled)
    // pass once the interpreter guard is disabled.
    expect(hook(ctx('python -c "open(\'~/.ssh/id_rsa\').read()"')).decision).not.toBe('block');
    expect(
      hook(ctx('node -e "require(\'fs\').readFileSync(process.env.HOME + \'/.aws/credentials\')"'))
        .decision,
    ).not.toBe('block');
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
    expect(hook(ctx('python -c "open(\'~/.ssh/id_rsa\').read()"')).decision).toBe('block');
  });
});

describe('createBashRestrictionHook — interpreter guard interactivity gate (H2)', () => {
  // The interpreter guard hard-blocks credential-adjacent one-liners only on
  // INTERACTIVE surfaces (a wired grant manager), where the model can be
  // redirected to the prompt-able typed file tools. On HEADLESS surfaces (no
  // grant manager) it fails open by default so legitimate automation is not
  // hard-blocked with no recourse — the day-one regression this gate fixes.
  //
  // `cred` is credential-adjacent (matches SENSITIVE_PATH_SIGNAL) AND uses a
  // quote-prefixed `~` that check 2's literal scan does NOT normalize, so the
  // interpreter guard (check 1) is the sole decider — isolating this behavior.
  const cred = 'python -c "open(\'~/.ssh/id_rsa\').read()"';

  it('does NOT block a credential-adjacent eval on a headless surface (no grant manager wired)', () => {
    const hook = createBashRestrictionHook({ getGrantManager: () => undefined });
    expect(hook(ctx(cred)).decision).not.toBe('block');
  });

  it('DOES block a credential-adjacent eval on an interactive surface (grant manager wired)', () => {
    const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
    expect(hook(ctx(cred)).decision).toBe('block');
  });

  it('never blocks a pure-computation eval, interactive or headless', () => {
    const interactive = createBashRestrictionHook({ getGrantManager: mockGrants });
    const headless = createBashRestrictionHook({ getGrantManager: () => undefined });
    expect(interactive(ctx('python -c "1+1"')).decision).not.toBe('block');
    expect(headless(ctx('python -c "1+1"')).decision).not.toBe('block');
  });

  it('forceInterpreterGuard re-enables the guard on headless surfaces', () => {
    const hook = createBashRestrictionHook({
      getGrantManager: () => undefined,
      forceInterpreterGuard: true,
    });
    const decision = hook(ctx(cred));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Interpreter');
  });

  it('forceInterpreterGuard still does NOT block pure computation on headless', () => {
    const hook = createBashRestrictionHook({
      getGrantManager: () => undefined,
      forceInterpreterGuard: true,
    });
    expect(hook(ctx('python -c "1+1"')).decision).not.toBe('block');
  });

  it('disableInterpreterGuard wins over forceInterpreterGuard (explicit OFF beats opt-in ON)', () => {
    const hook = createBashRestrictionHook({
      getGrantManager: mockGrants,
      disableInterpreterGuard: true,
      forceInterpreterGuard: true,
    });
    expect(hook(ctx(cred)).decision).not.toBe('block');
  });

  it('forcing the guard on headless does not change the substring check (stays open)', () => {
    const hook = createBashRestrictionHook({
      getGrantManager: () => undefined,
      forceInterpreterGuard: true,
    });
    // A plain restricted-path cat (no interpreter) stays open on headless —
    // forceInterpreterGuard only governs the interpreter guard.
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

describe('createBashRestrictionHook — context.grantManager precedence (#514)', () => {
  // #514: SessionToolDispatcher injects the EXECUTING session's provider as
  // context.grantManager (bash-restriction-hook.ts:229 —
  // `context.grantManager ?? opts.getGrantManager()`), mirroring the same
  // precedence path-approval-hook.test.ts pins in its own "#514" describe
  // block ("context.grantManager takes precedence over opts.getGrantManager").
  // Before this hook read context.grantManager at all, a forked child's
  // restricted-root view was blind to its OWN grants and pinned to whichever
  // session's ref happened to construct the hook closure.
  const home = homedir();
  const sshPath = `${home}/.ssh`;

  function grantsGranting(extraRoot: string): GrantManager {
    return {
      addReadRoot: () => {},
      addWriteRoot: () => {},
      revokeRoot: () => {},
      getGrants() {
        return {
          resolveBase: '/tmp/repo',
          readRoots: ['/tmp/repo', extraRoot],
          writeRoots: ['/tmp/repo'],
        };
      },
    };
  }

  it('uses context.grantManager over opts.getGrantManager (the ref) for the restricted-root view (#514)', () => {
    // Ref (opts.getGrantManager) grants ~/.ssh — permissive: if the hook fell
    // back to the ref, `.ssh` would be dropped from restrictedSubstrings and
    // the command would pass through unblocked.
    const refMgr = grantsGranting(sshPath);
    // Injected (context.grantManager) grants an UNRELATED root — `.ssh`
    // remains restricted under its view.
    const injectedMgr = grantsGranting('/some/other/granted-root');
    const hook = createBashRestrictionHook({ getGrantManager: () => refMgr });

    // Sanity check: using the ref alone (no injected context), this same
    // command is NOT blocked — confirms the ref really is the permissive one.
    const refOnlyDecision = hook(ctx(`cat ${sshPath}/id_rsa`));
    expect(refOnlyDecision.decision).not.toBe('block');

    // Now fire with the INJECTED (restrictive) manager on the context. If it
    // wins over the ref, `.ssh` is still restricted under its own grants and
    // the command blocks — proving the injected manager, not the ref, drove
    // the decision.
    const decision = hook({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: `cat ${sshPath}/id_rsa` },
      grantManager: injectedMgr,
    });

    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/restricted path/);
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

describe('SENSITIVE_PATH_SIGNAL stays in sync with the built-in sensitive roots', () => {
  // Invariant: every restricted root check 2 protects must ALSO be matchable by
  // check 1's lexical signal — otherwise an interpreter one-liner that assembles
  // that root at runtime (a quote-prefixed `~`, which normalizeHomeRefs leaves
  // alone) slips past BOTH checks. This test fails if a root is added to
  // builtinBashSensitiveRoots — including via the shared BUILTIN_READ_DENYLIST —
  // without a corresponding SENSITIVE_PATH_SIGNAL fragment: the exact drift that
  // once left ~/Library/Application Support (Chrome saved passwords / cookies)
  // reachable via `python -c`.
  //
  // Scoped to the BUILT-IN roots on purpose. The other two candidate sources are
  // environment-dependent — operator AFK_READ_DENYLIST entries, and the
  // symlink-resolved spelling of each built-in — so asserting lexical coverage
  // over them would make this suite pass or fail on the host's config. Those
  // still get check 2; only the interpreter guard's lexical half is built-in only.
  const allCandidates = builtinBashSensitiveRoots();

  it('covers every built-in sensitive root', () => {
    expect(allCandidates.length).toBeGreaterThan(0);
    const uncovered = allCandidates.filter((c) => !SENSITIVE_PATH_SIGNAL.test(c));
    expect(uncovered).toEqual([]);
  });
});

describe('deriveRestrictedSubstrings — no coverage regression from sharing the read denylist', () => {
  // Invariant: swapping the hand-written candidate list for the shared read
  // denylist must never DROP a root. This is the literal list as it stood on
  // main @ 38ecc28 (bash-restriction-hook.ts:298-309 before the change); every
  // entry has to survive, whichever source now contributes it. A future edit
  // that narrows the shared list fails here instead of silently un-gating a
  // path bash has refused since the hook was written.
  const home = homedir();
  const historical = [
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
    join(home, '.config', 'gh'),
    join(home, '.netrc'),
    join(home, 'Library', 'Application Support'),
    join(home, '.password-store'),
    '/etc/shadow',
    '/etc/sudoers',
    '/private/etc/sudoers',
  ];

  it('still covers every root the pre-share list covered', () => {
    const current = deriveRestrictedSubstrings({
      resolveBase: undefined,
      readRoots: [],
      writeRoots: [],
    });
    expect(historical.filter((h) => !current.includes(h))).toEqual([]);
  });
});

describe('deriveRestrictedSubstrings — a cross-drive grant cannot empty the floor (#852)', () => {
  // Invariant: `path.win32.relative` returns a DRIVE-QUALIFIED ABSOLUTE string
  // (`C:\Users\me\.ssh`) when the two paths sit on different drives, never a
  // `..\`-prefixed one. So `!rel.startsWith('..')` alone reads a cross-drive
  // pair as "the grant covers this candidate" and DROPS it — one grant on an
  // unrelated drive emptied the entire credential floor, reachable by any
  // model-supplied readRoots entry. `!path.isAbsolute(rel)` is the fix.
  //
  // Gated to win32 because the topology is UNREACHABLE on POSIX: relative()
  // between two absolute POSIX paths is never absolute. That unreachability is
  // why the bug survived review, and it is why the platform-independent guard
  // is the predicate-identity test in subagent/root-validation.test.ts — this
  // case does not run on the default CI matrix (the windows leg is opt-in).
  it.runIf(process.platform === 'win32')(
    'keeps every candidate when the only grant sits on another drive',
    () => {
      const unfiltered = deriveRestrictedSubstrings({
        resolveBase: undefined,
        readRoots: [],
        writeRoots: [],
      });
      const otherDrive = homedir().toUpperCase().startsWith('D:') ? 'C:\\scratch' : 'D:\\scratch';
      const withCrossDriveGrant = deriveRestrictedSubstrings({
        resolveBase: undefined,
        readRoots: [otherDrive],
        writeRoots: [],
      });
      expect(withCrossDriveGrant).toEqual(unfiltered);
    },
  );
});

describe('createBashRestrictionHook — credential parity with the typed read denylist', () => {
  // Invariant: a credential path floored for read_file / grep / glob is floored
  // for bash too. Each path below was readable with `cat` while the typed tools
  // refused it, because the two lists were maintained separately;
  // builtinBashSensitiveRoots() now imports BUILTIN_READ_DENYLIST directly.
  const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
  const home = homedir();

  const newlyCovered: Array<[string, string]> = [
    ['AFK credential tree (afk.env API keys)', `${home}/.afk/config/afk.env`],
    ['AFK config that may carry a literal apiKey', `${home}/.afk/config/afk.config.json`],
    ['git credential store', `${home}/.git-credentials`],
    ['npm publish token', `${home}/.npmrc`],
    ['docker registry auth', `${home}/.docker/config.json`],
    ['kube config', `${home}/.kube/config`],
    ['gcloud credentials', `${home}/.config/gcloud/credentials.db`],
    ['macOS master.passwd', '/private/etc/master.passwd'],
    // Invariant: BOTH spellings of an /etc root, because this scan is lexical.
    // The denylist names only the `/private` form, and macOS symlinks `/etc` —
    // so `cat /etc/master.passwd` reached the same file the typed tools refuse
    // until withEtcAliases() derived the twin (PR #734 review, MAJOR 2).
    ['macOS master.passwd via the /etc symlink', '/etc/master.passwd'],
    ['/etc/shadow via its /private real path', '/private/etc/shadow'],
  ];

  for (const [label, credentialPath] of newlyCovered) {
    it(`blocks cat of the ${label}`, () => {
      const decision = hook(ctx(`cat ${credentialPath}`));
      expect(decision.decision).toBe('block');
      expect(decision.reason).toMatch(/restricted path/);
    });
  }

  it('blocks an interpreter one-liner assembling the AFK credential tree at runtime', () => {
    expect(
      hook(ctx('python -c "import os; open(os.path.expanduser(\'~/.afk/config/afk.env\')).read()"'))
        .decision,
    ).toBe('block');
  });

  it('leaves ~/.afk/state readable — forks read preflight inputs, todos, transcripts there', () => {
    // The read denylist floors ~/.afk/CONFIG only, never ~/.afk/state
    // (#544/#547/#554). Sharing the list must not smuggle state into the block.
    expect(hook(ctx(`cat ${home}/.afk/state/todos/session.json`)).decision).not.toBe('block');
    expect(hook(ctx(`ls ${home}/.afk/state`)).decision).not.toBe('block');
    expect(
      hook(ctx('python -c "open(os.path.expanduser(\'~/.afk/state/x.json\')).read()"')).decision,
    ).not.toBe('block');
  });

  it('leaves ~/.afk/plugins readable — only ~/.afk/CONFIG is floored, not sibling AFK subdirs', () => {
    // Pins the same CONFIG-only scoping as the state test above, for the
    // plugins subdirectory: a future widening of the denied `config` root that
    // spares only `state` (and not `plugins`) would otherwise go uncaught.
    expect(hook(ctx(`cat ${home}/.afk/plugins/some-plugin/SKILL.md`)).decision).not.toBe('block');
    expect(hook(ctx(`ls ${home}/.afk/plugins`)).decision).not.toBe('block');
    expect(
      hook(ctx('python -c "open(os.path.expanduser(\'~/.afk/plugins/some-plugin/SKILL.md\')).read()"'))
        .decision,
    ).not.toBe('block');
  });

  it('leaves ~/.afk/logs readable — only ~/.afk/CONFIG is floored, not sibling AFK subdirs', () => {
    // Same scoping pin as above, for the logs subdirectory.
    expect(hook(ctx(`cat ${home}/.afk/logs/telegram.log`)).decision).not.toBe('block');
    expect(hook(ctx(`ls ${home}/.afk/logs`)).decision).not.toBe('block');
    expect(
      hook(ctx('python -c "open(os.path.expanduser(\'~/.afk/logs/telegram.log\')).read()"')).decision,
    ).not.toBe('block');
  });
});

describe('createBashRestrictionHook — mcp.json carve-out parity (#728)', () => {
  const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
  const home = homedir();
  const mcp = `${home}/.afk/config/mcp.json`;

  it('allows the MCP registry in every home spelling', () => {
    expect(hook(ctx(`cat ${mcp}`)).decision).not.toBe('block');
    expect(hook(ctx('cat ~/.afk/config/mcp.json')).decision).not.toBe('block');
    expect(hook(ctx('cat $HOME/.afk/config/mcp.json')).decision).not.toBe('block');
  });

  it('is EXACT-file: backups and pseudo-children stay blocked', () => {
    expect(hook(ctx(`cat ${mcp}.bak`)).decision).toBe('block');
    expect(hook(ctx(`cat ${mcp}/child.json`)).decision).toBe('block');
    expect(hook(ctx(`cat ${home}/.afk/config/mcp.json.old`)).decision).toBe('block');
  });

  // Regression (glob-suffix carve-out bypass): the exact-ref lookahead class
  // used to omit shell glob/brace metacharacters (`*`, `?`, `[`, `]`, `{`,
  // `}`), so e.g. `mcp.json*` satisfied the negative lookahead and the WHOLE
  // `.../config/mcp.json` span got scrubbed to the placeholder — dropping the
  // only text carrying the denied `.../config` root, even though the shell
  // expands the glob to siblings (`mcp.json.bak`) the carve-out was never
  // meant to cover. Each spelling gets its own `it()` so a regression in any
  // one of them cannot hide behind the others (short-circuit-safe).
  it('is EXACT-file: a `*`-glob-extended reference stays blocked', () => {
    expect(hook(ctx(`cat ${mcp}*`)).decision).toBe('block');
  });

  it('is EXACT-file: a `{,.bak}`-brace-extended reference stays blocked', () => {
    expect(hook(ctx(`cat ${mcp}{,.bak}`)).decision).toBe('block');
  });

  it('is EXACT-file: a `[.]bak`-bracket-glob-extended reference stays blocked', () => {
    expect(hook(ctx(`cat ${mcp}[.]bak`)).decision).toBe('block');
  });

  it('is EXACT-file: a `?`-glob-extended reference stays blocked', () => {
    expect(hook(ctx(`cat ${mcp}?`)).decision).toBe('block');
  });

  it('regression: the bare exact reference and its quoted form both stay allowed', () => {
    // Counterpoint to the glob-suffix test above: a real exact reference (no
    // trailing glob/brace metacharacter) must still hit the carve-out, quoted
    // or not — the fix only narrows what counts as "exact", it must not
    // un-allow the file the carve-out exists for.
    expect(hook(ctx(`cat ${mcp}`)).decision).not.toBe('block');
    expect(hook(ctx(`cat "${mcp}"`)).decision).not.toBe('block');
  });

  it('does not launder a credential sibling riding along in the same command', () => {
    expect(hook(ctx(`cat ${mcp} ${home}/.afk/config/afk.env`)).decision).toBe('block');
  });

  it('extends the carve-out to the interpreter guard', () => {
    expect(
      hook(ctx('python -c "import json; json.load(open(\'~/.afk/config/mcp.json\'))"')).decision,
    ).not.toBe('block');
  });

  // PR #805 P1 — quote-concatenation bypass. Shell concatenates
  // `~/.ssh/config".bak"` into `~/.ssh/config.bak`; before the second
  // lookahead, `scrubAllowlistedRefs` treated the `"` as an exact-file
  // boundary, blanked the `.ssh/config` span, and left nothing for the
  // scanner to match → the hook returned allow for a denied sibling. The
  // escalation is traversal: `cat ~/.ssh/config"/../github_key"` resolves to
  // an ARBITRARILY-NAMED private key, defeating the whole-dir `~/.ssh` floor.
  // The fix scrubs ONLY when the trailing quote is NOT followed by a path
  // char, so a legitimately quoted whole exact ref (`"~/.ssh/config"`) still
  // scrubs and stays allowed while a quote-concatenated suffix stays blocked.
  // These exercise the mcp.json surface (pre-existing hole) and the ssh
  // surface (the surface this PR extends the hole onto).
  it('P1: mcp.json quote-concat suffix stays blocked (config".bak" analogue)', () => {
    expect(hook(ctx(`cat ${mcp}".bak"`)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.afk/config/mcp.json"/../afk.env"`)).decision).toBe('block');
  });

  it('P1: mcp.json single-quote and backtick concat stay blocked (all shell quotes)', () => {
    expect(hook(ctx(`cat ${mcp}'.bak'`)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.afk/config/mcp.json'/../afk.env'`)).decision).toBe('block');
    expect(hook(ctx(`cat ${mcp}\`.bak\``)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.afk/config/mcp.json\`/../afk.env\``)).decision).toBe('block');
  });

  it('P1: a quoted whole exact ref still scrubs and stays allowed (no regression)', () => {
    // The second lookahead rejects ONLY `" + path-char`; a closing quote
    // followed by EOL/space must still match the carve-out and scrub.
    expect(hook(ctx(`cat "${mcp}"`)).decision).not.toBe('block');
    expect(hook(ctx(`cat "~/.afk/config/mcp.json"`)).decision).not.toBe('block');
    expect(hook(ctx(`cat "${mcp}" 2>/dev/null`)).decision).not.toBe('block');
  });
});

// PR #805 — ssh config / known_hosts carve-out parity on the bash surface.
// `READ_ALLOWLIST_REL` is shared, so the carve-out propagates here structurally;
// these pin that propagation so a future refactor of `allowlistedFileForms`
// cannot silently invert the carve-out on the bash surface without a failing
// test. Mirrors the mcp.json parity block above.
describe('createBashRestrictionHook — ssh config / known_hosts carve-out parity (#579 O2)', () => {
  const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
  const home = homedir();
  const sshConfig = `${home}/.ssh/config`;
  const knownHosts = `${home}/.ssh/known_hosts`;

  it('allows the ssh carve-outs in every home spelling', () => {
    expect(hook(ctx(`cat ${sshConfig}`)).decision).not.toBe('block');
    expect(hook(ctx('cat ~/.ssh/config')).decision).not.toBe('block');
    expect(hook(ctx('cat $HOME/.ssh/config')).decision).not.toBe('block');
    expect(hook(ctx(`cat ${knownHosts}`)).decision).not.toBe('block');
    expect(hook(ctx('cat ~/.ssh/known_hosts')).decision).not.toBe('block');
  });

  it('is EXACT-file: backups, pseudo-children, and well-known keys stay blocked', () => {
    expect(hook(ctx(`cat ${sshConfig}.bak`)).decision).toBe('block');
    expect(hook(ctx(`cat ${sshConfig}/child`)).decision).toBe('block');
    expect(hook(ctx(`cat ${knownHosts}.old`)).decision).toBe('block');
    expect(hook(ctx(`cat ${sshConfig}/../id_rsa`)).decision).toBe('block');
    expect(hook(ctx(`cat ${sshConfig}/../github_key`)).decision).toBe('block');
    expect(hook(ctx(`cat ${home}/.ssh/id_rsa`)).decision).toBe('block');
    expect(hook(ctx(`cat ${home}/.ssh/github_key`)).decision).toBe('block');
  });

  it('P1: quote-concatenated sibling/traversal stays blocked (the bypass this PR closes)', () => {
    // Codex's exact example + the private-key traversal escalation.
    expect(hook(ctx(`cat ${sshConfig}".bak"`)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.ssh/config".bak"`)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.ssh/config"/../github_key"`)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.ssh/config"/../id_rsa"`)).decision).toBe('block');
    expect(hook(ctx(`cat $HOME/.ssh/config"/../github_key"`)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.ssh/known_hosts"/../github_key"`)).decision).toBe('block');
  });

  it('P1: single-quote and backtick concat stay blocked (all shell quotes)', () => {
    expect(hook(ctx(`cat ${sshConfig}'.bak'`)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.ssh/config'.bak'`)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.ssh/config'/../github_key'`)).decision).toBe('block');
    expect(hook(ctx(`cat $HOME/.ssh/config'/../github_key'`)).decision).toBe('block');
    expect(hook(ctx(`cat ${sshConfig}\`.bak\``)).decision).toBe('block');
    expect(hook(ctx(`cat ~/.ssh/config\`/../github_key\``)).decision).toBe('block');
  });

  it('P1: a quoted whole ssh exact ref still scrubs and stays allowed (no regression)', () => {
    expect(hook(ctx(`cat "${sshConfig}"`)).decision).not.toBe('block');
    expect(hook(ctx(`cat "~/.ssh/config"`)).decision).not.toBe('block');
    expect(hook(ctx(`cat "$HOME/.ssh/known_hosts"`)).decision).not.toBe('block');
  });

  it('is EXACT-file: glob/brace-extended siblings stay blocked', () => {
    expect(hook(ctx(`cat ${sshConfig}*`)).decision).toBe('block');
    expect(hook(ctx(`cat ${knownHosts}{,.old}`)).decision).toBe('block');
  });

  it('does not launder a key riding along in the same command', () => {
    expect(hook(ctx(`cat ${sshConfig} ${home}/.ssh/id_rsa`)).decision).toBe('block');
  });

  it('extends the carve-out to the interpreter guard', () => {
    expect(
      hook(ctx('python -c "print(open(\'~/.ssh/config\').read())"')).decision,
    ).not.toBe('block');
    expect(
      hook(ctx('python -c "print(open(\'~/.ssh/known_hosts\').read())"')).decision,
    ).not.toBe('block');
  });
});

describe('createBashRestrictionHook — relocated AFK_HOME parity', () => {
  const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
  const relocated = join(tmpdir(), 'agent-afk-relocated-home');

  afterEach(() => {
    delete process.env['AFK_HOME'];
    _resetReadDenylistCacheForTests();
  });

  it('blocks the configured absolute spelling and $AFK_HOME spelling', () => {
    process.env['AFK_HOME'] = relocated;

    expect(hook(ctx(`cat ${relocated}/config/afk.env`)).decision).toBe('block');
    expect(hook(ctx('cat "$AFK_HOME/config/afk.env"')).decision).toBe('block');
  });

  it('keeps relocated mcp.json readable in both spellings', () => {
    process.env['AFK_HOME'] = relocated;

    expect(hook(ctx(`cat ${relocated}/config/mcp.json`)).decision).not.toBe('block');
    expect(hook(ctx('cat "$AFK_HOME/config/mcp.json"')).decision).not.toBe('block');
  });

  it('keeps the relocated carve-out exact-file only', () => {
    process.env['AFK_HOME'] = relocated;

    expect(hook(ctx(`cat ${relocated}/config/mcp.json.bak`)).decision).toBe('block');
    expect(hook(ctx('cat "$AFK_HOME/config/mcp.json/child"')).decision).toBe('block');
  });

  it('blocks the configured spelling when AFK_HOME is a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-home-symlink-'));
    const target = join(root, 'target');
    const link = join(root, 'configured');
    mkdirSync(join(target, 'config'), { recursive: true });
    symlinkSync(target, link, 'dir');
    process.env['AFK_HOME'] = link;

    try {
      expect(hook(ctx(`cat ${link}/config/afk.env`)).decision).toBe('block');
      expect(hook(ctx('cat "$AFK_HOME/config/afk.env"')).decision).toBe('block');
      expect(hook(ctx(`cat ${link}/config/mcp.json`)).decision).not.toBe('block');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression: a TRAILING SEPARATOR on AFK_HOME used to fail OPEN here.
  // `$AFK_HOME` was substituted into the command text verbatim, yielding an
  // interior `//` (`/relocated//config/afk.env`), while the restricted needle
  // was built with path.join, which collapses it (`/relocated/config`). The
  // final match is a literal includes(), so the two spellings never met and
  // the command opened the very file this hook exists to block. POSIX
  // collapses interior separators, so the bypass was real, not cosmetic.
  // Fixed by resolving once at the source in configuredAfkHome().
  it('blocks a trailing-separator AFK_HOME in both spellings', () => {
    process.env['AFK_HOME'] = `${relocated}/`;

    expect(hook(ctx('cat "$AFK_HOME/config/afk.env"')).decision).toBe('block');
    expect(hook(ctx(`cat ${relocated}//config/afk.env`)).decision).toBe('block');
    expect(hook(ctx(`cat ${relocated}/config/afk.env`)).decision).toBe('block');
  });

  it('keeps the mcp.json carve-out working under a trailing-separator AFK_HOME', () => {
    process.env['AFK_HOME'] = `${relocated}/`;

    expect(hook(ctx('cat "$AFK_HOME/config/mcp.json"')).decision).not.toBe('block');
    expect(hook(ctx(`cat ${relocated}/config/mcp.json`)).decision).not.toBe('block');
  });

  // Fail-safe: getAfkHome() throws on a non-absolute AFK_HOME. configuredAfkHome()
  // must swallow it and fall back to the default floor rather than propagating.
  //
  // Test hygiene (#783 follow-up to #753): this trips the shared
  // `warnAfkHomeRejectedOnce` once-latch. Reset it first and spy on
  // console.warn so the expected warning is captured instead of leaking to
  // stderr during the run, and restore both in `finally` so the latch does
  // not stay silently consumed for the rest of this file's later tests.
  it('stays fail-safe when AFK_HOME is relative (getAfkHome() throws)', () => {
    resetAfkHomeWarnLatchForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env['AFK_HOME'] = 'relative/not-absolute';

      expect(() => hook(ctx('echo hi'))).not.toThrow();
      expect(hook(ctx('echo hi')).decision).not.toBe('block');
      // The default-home floor still applies.
      expect(hook(ctx(`cat ${join(homedir(), '.afk', 'config', 'afk.env')}`)).decision).toBe(
        'block',
      );
      // Discriminates the fail-safe from a silently-broken one: the warning
      // must actually fire. `configuredAfkHome()` is called once per `hook()`
      // invocation (3 calls above), but the shared latch caps it at 1 warn.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('[afk-home]');
      expect(warn.mock.calls[0]?.[0]).toContain('relative/not-absolute');
    } finally {
      warn.mockRestore();
      resetAfkHomeWarnLatchForTests();
    }
  });

  // paths.ts treats '' as unset. Pin that the bash surface agrees, so an empty
  // AFK_HOME can never widen the floor beyond the default-home coverage.
  it('treats an empty AFK_HOME as unset', () => {
    process.env['AFK_HOME'] = '';

    expect(hook(ctx(`cat ${join(homedir(), '.afk', 'config', 'afk.env')}`)).decision).toBe(
      'block',
    );
    expect(hook(ctx(`cat ${join(homedir(), '.afk', 'config', 'mcp.json')}`)).decision).not.toBe(
      'block',
    );
  });

  // The double-separator bypass was never AFK_HOME-specific: with NO AFK_HOME
  // set at all, `~/.afk//config/afk.env` slipped past the default-home floor,
  // because the `//` lands inside the span the needle covers. Pinned here so a
  // future change to normalizeHomeRefs cannot silently reopen the class.
  it('blocks a double separator against the DEFAULT home floor (no AFK_HOME)', () => {
    delete process.env['AFK_HOME'];
    const afkEnv = join(homedir(), '.afk', 'config', 'afk.env');

    expect(hook(ctx(`cat ${afkEnv.replace('/.afk/config/', '/.afk//config/')}`)).decision).toBe(
      'block',
    );
    expect(hook(ctx('cat ~/.afk//config/afk.env')).decision).toBe('block');
    expect(hook(ctx('cat "$HOME/.afk//config/afk.env"')).decision).toBe('block');
  });

  // The bypass is positional, not character-specific: any lexically-different
  // but POSIX-equivalent spelling that SPLITS the span a needle covers defeats
  // the literal includes(). `//`, `/./` and `/../` are the same defect. The
  // same spellings AFTER the needle were always caught, which is why the class
  // was easy to under-diagnose from the `//` report alone.
  it('blocks dot and dot-dot segments that split the needle span', () => {
    delete process.env['AFK_HOME'];

    expect(hook(ctx('cat ~/.afk/./config/afk.env')).decision).toBe('block');
    expect(hook(ctx('cat ~/.afk/../.afk/config/afk.env')).decision).toBe('block');
    expect(hook(ctx('cat "$HOME/.afk/./config/afk.env"')).decision).toBe('block');
  });

  // Braced ${VAR} is the ordinary spelling a non-adversarial model emits, so it
  // sits inside this hook's accidental-access threat model — unlike the runtime
  // variable assembly (`H=$HOME; …$H/…`) the module header rules out and the
  // "documented bypass" test pins.
  it('blocks the braced ${AFK_HOME} spelling', () => {
    process.env['AFK_HOME'] = relocated;

    expect(hook(ctx('cat ${AFK_HOME}/config/afk.env')).decision).toBe('block');
    expect(hook(ctx('cat "${AFK_HOME}/config/afk.env"')).decision).toBe('block');
    // Carve-out parity: the braced spelling of mcp.json stays readable.
    expect(hook(ctx('cat ${AFK_HOME}/config/mcp.json')).decision).not.toBe('block');
  });

  it('blocks the braced ${HOME} spelling', () => {
    delete process.env['AFK_HOME'];

    expect(hook(ctx('cat ${HOME}/.afk/config/afk.env')).decision).toBe('block');
    expect(hook(ctx('cat ${HOME}/.ssh/id_rsa')).decision).toBe('block');
  });

  // Issue #778 — SENSITIVE_PATH_SIGNAL misses a relocated AFK_HOME.
  //
  // Reachability: headless surface (no grant manager) + AFK_FORCE_BASH_INTERPRETER_GUARD=1
  // + AFK_HOME relocated outside ~/.afk.
  //
  // On this path `restrictedSubstrings` is always `[]` (no grant manager wired),
  // making `SENSITIVE_PATH_SIGNAL` the SOLE protection for the interpreter guard.
  // But the signal has a hardcoded `.afk/config` fragment that only matches the
  // default install.  A relocated config tree (`/opt/my-afk/config`) never
  // contains the literal `.afk/` substring, so the signal returned false and the
  // interpreter guard failed open — the command was not blocked.
  //
  // The fix adds a third check in `referencesSensitivePath`: test `scanned`
  // against `relocatedAfkSensitiveRoots()` so the relocated tree is always covered.
  describe('SENSITIVE_PATH_SIGNAL gap on headless + forceInterpreterGuard + relocated AFK_HOME (#778)', () => {
    const headlessForced = createBashRestrictionHook({
      getGrantManager: () => undefined, // headless — no grant manager
      forceInterpreterGuard: true, // AFK_FORCE_BASH_INTERPRETER_GUARD=1
    });

    afterEach(() => {
      delete process.env['AFK_HOME'];
      _resetReadDenylistCacheForTests();
    });

    it('blocks a python -c that opens a file in the relocated config tree (#778)', () => {
      // The relocated path contains no `.afk/` fragment — SENSITIVE_PATH_SIGNAL
      // returns false. Before the fix, the interpreter guard therefore failed open.
      const relocatedHome = '/opt/my-afk';
      process.env['AFK_HOME'] = relocatedHome;

      const cmd = `python -c "open('${relocatedHome}/config/afk.env').read()"`;
      const decision = headlessForced(ctx(cmd));
      expect(decision.decision).toBe('block');
      expect(decision.reason).toContain('Interpreter');
    });

    it('blocks sh -c referencing the relocated config tree (#778)', () => {
      const relocatedHome = '/opt/my-afk';
      process.env['AFK_HOME'] = relocatedHome;

      expect(headlessForced(ctx(`sh -c "cat ${relocatedHome}/config/afk.env"`)).decision).toBe(
        'block',
      );
    });

    it('does NOT block a pure-computation eval even with relocated AFK_HOME (#778)', () => {
      // Pure computation: no sensitive path — must still pass through.
      process.env['AFK_HOME'] = '/opt/my-afk';

      expect(headlessForced(ctx('python -c "print(2**64)"')).decision).not.toBe('block');
    });

    it('does NOT block interpreter reads of relocatedHome non-config subdirs (#778)', () => {
      // Only the config subtree is sensitive. state/, plugins/, logs/ must stay open.
      const relocatedHome = '/opt/my-afk';
      process.env['AFK_HOME'] = relocatedHome;

      expect(
        headlessForced(ctx(`python -c "open('${relocatedHome}/state/todos.json').read()"`)).decision,
      ).not.toBe('block');
    });
  });
});

describe('createBashRestrictionHook — AFK_READ_DENYLIST extras reach the bash surface', () => {
  const hook = createBashRestrictionHook({ getGrantManager: mockGrants });
  const home = homedir();

  afterEach(() => {
    delete process.env['AFK_READ_DENYLIST'];
    _resetReadDenylistCacheForTests();
  });

  it('blocks an operator-added path, in the spelling the operator used', () => {
    // On macOS tmpdir() is /var/folders/… — a symlink to /private/var/folders/….
    // getReadDenylist() hands back the RESOLVED form, which never appears in a
    // command a model actually types, so this case passes only via
    // readDenylistExtrasAsSpelled(). Do not "simplify" it to a non-symlinked
    // path: that would stop exercising the as-spelled candidate entirely.
    const extra = join(tmpdir(), 'afk-bash-restriction-secrets');
    process.env['AFK_READ_DENYLIST'] = extra;
    _resetReadDenylistCacheForTests();
    expect(hook(ctx(`cat ${extra}/token`)).decision).toBe('block');
  });

  it('re-denying the mcp.json carve-out wins here too (extras outrank the exception)', () => {
    const mcp = `${home}/.afk/config/mcp.json`;
    process.env['AFK_READ_DENYLIST'] = mcp;
    _resetReadDenylistCacheForTests();
    expect(hook(ctx(`cat ${mcp}`)).decision).toBe('block');
  });

  // The bash surface parses this var through read-denylist.ts's shared parser,
  // so tilde support has to hold HERE too — a local re-implementation drifting
  // back is what made the documented spelling a no-op on both surfaces at once
  // (PR #734 review, MAJOR 1).
  it('honors a tilde-spelled entry, the spelling the docs recommend', () => {
    process.env['AFK_READ_DENYLIST'] = '~/.afk/config/mcp.json';
    _resetReadDenylistCacheForTests();
    expect(hook(ctx(`cat ${home}/.afk/config/mcp.json`)).decision).toBe('block');
  });
});
