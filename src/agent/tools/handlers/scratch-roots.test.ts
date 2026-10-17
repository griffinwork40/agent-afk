/**
 * Pins the "OS temp dir is an implicit WRITE root for confined sessions"
 * contract (scratch-roots.ts) and, just as importantly, what it must NOT relax:
 * credential paths reached through the temp dir (symlinks into ~/.ssh, a
 * dangling link, an operator write-denylist entry under tmp) stay denied.
 *
 * Motivation: ~300 fork write denials in a month of witness telemetry, mostly
 * `/tmp/commit-msg.txt` and `/tmp/pr-body*.md`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAndContain, wouldBeRestricted, _resetRootRealpathCacheForTests } from './_cwd-utils.js';
import { isWithinScratchRoot, realScratchRoots, _resetScratchRootsCacheForTests } from './scratch-roots.js';
import { scanCandidatePaths } from './bash-scan-exempt.js';
import { writeFileHandler } from './write-file.js';
import { editFileHandler } from './edit-file.js';
import { validatePatchChanges } from './patch-validate.js';
import { _resetWriteDenylistCacheForTests } from './write-denylist.js';
import { createPathApprovalHook } from '../hooks/path-approval-hook.js';
import type { ToolHandlerContext } from '../types.js';
import type { GrantManager } from '../grant-manager.js';
import type { PreToolUseContext } from '../../hooks.js';

// A confined fork whose only granted root is NOT under the temp dir. The fake
// HOME (redirect-paths-env.ts) lives under node_modules/.cache, never in tmp.
const ROOT = path.join(os.homedir(), 'worktree');
const ctx = (): ToolHandlerContext =>
  ({ cwd: ROOT, resolveBase: ROOT, readRoots: [ROOT], writeRoots: [ROOT] }) as ToolHandlerContext;
const live = (): AbortSignal => new AbortController().signal;

/**
 * The POSIX temp literals as they exist on THIS host (realpath'd). Empty on a
 * host without them (Windows), which keeps every test below portable instead
 * of gating it on the platform (posix-guard R4).
 */
function hostTmpLiterals(): string[] {
  const out: string[] = [];
  for (const p of ['/tmp', '/private/tmp']) {
    try {
      out.push(realpathSync.native(p));
    } catch {
      /* absent on this host */
    }
  }
  return out;
}

let scratch: string;

beforeEach(() => {
  mkdirSync(ROOT, { recursive: true });
  scratch = mkdtempSync(path.join(os.tmpdir(), 'afk-scratch-roots-'));
  _resetScratchRootsCacheForTests();
  _resetRootRealpathCacheForTests();
  _resetWriteDenylistCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
  _resetScratchRootsCacheForTests();
  _resetWriteDenylistCacheForTests();
});

describe('scratch roots — membership', () => {
  it('covers os.tmpdir() and its realpath', () => {
    const roots = realScratchRoots();
    expect(roots).toContain(realpathSync.native(os.tmpdir()));
    expect(isWithinScratchRoot(realpathSync.native(scratch))).toBe(true);
  });

  it('covers /tmp and /private/tmp wherever they exist off Windows', () => {
    // Windows' host-resolved `/tmp` is a drive-relative X:\tmp, deliberately
    // NOT a scratch root there (scratch-roots.ts realScratchRoots).
    if (process.platform !== 'win32') {
      for (const lit of hostTmpLiterals()) {
        expect(isWithinScratchRoot(path.join(lit, 'commit-msg.txt'))).toBe(true);
      }
    }
    expect(isWithinScratchRoot(path.join(realpathSync.native(os.tmpdir()), 'x'))).toBe(true);
  });

  it('never treats the home dir, the fs root, or a lookalike prefix as scratch', () => {
    expect(isWithinScratchRoot(os.homedir())).toBe(false);
    expect(isWithinScratchRoot(path.parse(os.homedir()).root)).toBe(false);
  });

  it('a sibling sharing a scratch root name prefix is not scratch', () => {
    // Only OUTERMOST roots: a nested root (an afk session TMPDIR such as
    // /tmp/afk-<uid>/… inside /private/tmp) has siblings that are legitimately
    // scratch because they sit under the enclosing root.
    const all = realScratchRoots();
    const outermost = all.filter(
      (r) => !all.some((o) => o !== r && r.startsWith(o + path.sep)),
    );
    for (const root of outermost) {
      expect(isWithinScratchRoot(`${root}-evil${path.sep}x`)).toBe(false);
    }
  });
});

describe('scratch roots — confined write allowed', () => {
  it('resolveAndContain admits a write under os.tmpdir() outside every granted root', () => {
    const target = path.join(scratch, 'pr-body.md');
    expect(resolveAndContain(target, ctx(), 'write')).toBe(target);
    expect(wouldBeRestricted(target, ctx(), 'write').restricted).toBe(false);
  });

  it('admits the literal /tmp/commit-msg.txt and /private/tmp spellings where they exist', () => {
    // The dominant telemetry case. Unresolved spellings: computeContainment
    // must realpath them itself (macOS /tmp -> /private/tmp).
    if (process.platform !== 'win32') {
      const spellings = ['/tmp/commit-msg.txt', '/private/tmp/pr-body-1.md'].filter((p) =>
        existsSync(path.dirname(p)),
      );
      for (const p of spellings) {
        expect(wouldBeRestricted(p, ctx(), 'write').restricted).toBe(false);
      }
    }
  });

  it('applies to WRITE containment only — read scope is unchanged', () => {
    expect(wouldBeRestricted(path.join(scratch, 'x.txt'), ctx(), 'read').restricted).toBe(true);
  });

  it('a `..` traversal out of the temp dir is still restricted', () => {
    // Climb from the scratch dir all the way to the fs root, then back down
    // into the (non-tmp) home dir, without lexical normalization.
    const realScratch = realpathSync.native(scratch);
    const { root } = path.parse(realScratch);
    const depth = realScratch.slice(root.length).split(path.sep).filter(Boolean).length;
    const home = os.homedir();
    const escape = [scratch, ...Array<string>(depth).fill('..'), home.slice(path.parse(home).root.length), 'elsewhere.txt'].join(path.sep);
    expect(wouldBeRestricted(escape, ctx(), 'write').restricted).toBe(true);
  });

  it('write_file / edit_file / patch_apply validation all succeed under the temp dir', async () => {
    const f = path.join(scratch, 'commit-msg.txt');
    const w = await writeFileHandler({ file_path: f, content: 'subject\n' }, live(), ctx());
    expect(w.isError).toBeFalsy();
    expect(readFileSync(f, 'utf8')).toBe('subject\n');

    const e = await editFileHandler(
      { file_path: f, old_string: 'subject', new_string: 'fix: subject' },
      live(),
      ctx(),
    );
    expect(e.isError).toBeFalsy();
    expect(readFileSync(f, 'utf8')).toBe('fix: subject\n');

    const v = await validatePatchChanges(
      [{ path: path.join(scratch, 'new.md'), content: 'body' }],
      ROOT,
      ctx(),
    );
    expect(v.errors).toEqual([]);
  });

  it('bash scan and typed tools agree: temp paths are not reported as escapes', () => {
    const cmd = `printf x > ${path.join(scratch, 'a.txt')} && cat /tmp/pr-body.md`;
    expect(scanCandidatePaths(cmd, os.homedir())).toEqual([]);
  });
});

describe('scratch roots — credential floor is NOT relaxed', () => {
  let sshDir: string;
  beforeEach(() => {
    sshDir = path.join(os.homedir(), '.ssh');
    mkdirSync(sshDir, { recursive: true });
  });
  afterEach(() => rmSync(sshDir, { recursive: true, force: true }));

  it('a temp-dir DIRECTORY symlink into ~/.ssh resolves through realpath and is denied', async () => {
    const link = path.join(scratch, 'keys');
    symlinkSync(sshDir, link, 'dir');
    const target = path.join(link, 'authorized_keys');
    expect(wouldBeRestricted(target, ctx(), 'write').restricted).toBe(true);
    const r = await writeFileHandler({ file_path: target, content: 'ssh-ed25519 AAAA' }, live(), ctx());
    expect(r.isError).toBe(true);
    expect(existsSync(path.join(sshDir, 'authorized_keys'))).toBe(false);
  });

  it('a DANGLING temp-dir file symlink to ~/.ssh/authorized_keys is denied (target re-check)', async () => {
    const link = path.join(scratch, 'pr-body.md');
    symlinkSync(path.join(sshDir, 'authorized_keys'), link);
    const r = await writeFileHandler({ file_path: link, content: 'ssh-ed25519 AAAA' }, live(), ctx());
    expect(r.isError).toBe(true);
    expect(existsSync(path.join(sshDir, 'authorized_keys'))).toBe(false);
  });

  it('the write-denylist still applies to a path INSIDE the temp dir', async () => {
    const secret = path.join(scratch, 'secret');
    vi.stubEnv('AFK_WRITE_DENYLIST', secret);
    _resetWriteDenylistCacheForTests();
    const r = await writeFileHandler(
      { file_path: path.join(secret, 'token'), content: 'x' },
      live(),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/denylist|protected|not allowed|refus/i);
    expect(existsSync(path.join(secret, 'token'))).toBe(false);
  });
});

describe('scratch roots — path-approval hook agrees for a forked sub-agent', () => {
  function grantManager(): GrantManager {
    const roots = [ROOT];
    return {
      addReadRoot() {},
      addWriteRoot() {},
      revokeRoot() {},
      getGrants: () => ({ resolveBase: ROOT, readRoots: roots.slice(), writeRoots: roots.slice() }),
    } as unknown as GrantManager;
  }
  const forkCtx = (toolName: string, file_path: string): PreToolUseContext =>
    ({
      event: 'PreToolUse',
      toolName,
      input: { file_path, content: 'x' },
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      grantManager: grantManager(),
    }) as unknown as PreToolUseContext;

  it('does not auto-deny a fork write_file into the temp dir', async () => {
    const { preToolUse } = createPathApprovalHook({ getCwd: () => ROOT, surface: 'repl' });
    const d = await preToolUse(forkCtx('write_file', path.join(scratch, 'commit-msg.txt')));
    expect(d.decision).toBeUndefined();
  });

  it('still auto-denies a fork write_file outside both its roots and tmp', async () => {
    const { preToolUse } = createPathApprovalHook({ getCwd: () => ROOT, surface: 'repl' });
    const d = await preToolUse(forkCtx('write_file', path.join(os.homedir(), 'elsewhere', 'x.txt')));
    expect(d.decision).toBe('block');
  });

  it('still auto-denies a fork READ of the temp dir (read scope unchanged)', async () => {
    const { preToolUse } = createPathApprovalHook({ getCwd: () => ROOT, surface: 'repl' });
    const d = await preToolUse(forkCtx('read_file', path.join(scratch, 'commit-msg.txt')));
    expect(d.decision).toBe('block');
  });
});
