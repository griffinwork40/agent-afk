/**
 * Red team round 2, finding 2: a remembered "Always allow write_file" (the
 * only grant shape D18 permits for write_file) lets the model write both
 * `.git/config` and `.gitattributes` when the session cwd is the repository
 * root—both are lexically inside the cwd, so the grant covers them without
 * asking. The model defines a git clean filter in `.git/config` and declares
 * `* filter=x` in `.gitattributes`, then calls the AUTO-ALLOWED
 * `git_read {subcommand:"blame", args:["-s"]}` (or `diff -p`). git runs the
 * clean filter against the working-tree copy to compare with the index,
 * executing an arbitrary shell command. The human was asked ONCE—for the
 * original `notes.md` write.
 *
 * `--no-ext-diff` and `-c diff.external=` (the global args in git-read.ts)
 * do NOT suppress clean/smudge filter drivers; those are separate machinery.
 * The fix must either: (a) add `.git/**`, `.gitattributes`, and `.gitmodules`
 * to a deny-list in grantFits / grantCovers, or (b) always ask for writes to
 * files under `.git/` and git-special dotfiles.
 *
 * Asserts the SAFE behaviour: code does not run with only one approval.
 * Fails on 0a045c5d6.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AcpClientPeer, ToolCallStart } from './acp.wire.js';
import { createAcpPermissionGate } from './acp.permission.js';
import { grantFits } from './acp.permission.grants.js';
import { createWriteFileHandler } from '../../agent/tools/handlers/write-file.js';
import { createGitReadHandler } from '../../agent/tools/handlers/git-read.js';

let repo = '';
let marker = '';
const git = (args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], {
    cwd: repo, encoding: 'utf8',
  });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const opts = (id: string) => ({ signal: new AbortController().signal, toolUseID: id });

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt2-gitcfg-')));
  marker = path.join(fs.realpathSync(os.tmpdir()), `rt2-pwned-${process.pid}-${Date.now()}`);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  git(['init', '-q']);
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
});
afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(marker, { force: true });
});

describe('redteam2: write_file grant covers .git/config — clean filter RCE', () => {
  it('grantFits must NOT cover .git/config, .gitattributes, or .git/hooks/*', () => {
    // Root of the vulnerability: grantFits calls insideLocation which uses
    // path.resolve + isContained — purely lexical. .git/config is inside cwd,
    // so it passes. This test asserts the SAFE behaviour and FAILS on current code.
    expect(
      grantFits('write_file', { file_path: '.git/config', content: 'x' }, repo),
      '.git/config must not be covered by a write_file grant (can inject filter drivers)',
    ).toBe(false);
    expect(
      grantFits('write_file', { file_path: '.gitattributes', content: 'x' }, repo),
      '.gitattributes must not be covered by a write_file grant (can assign filter drivers)',
    ).toBe(false);
    expect(
      grantFits('write_file', { file_path: '.git/hooks/pre-commit', content: 'x' }, repo),
      '.git/hooks/pre-commit must not be covered (executable hook)',
    ).toBe(false);
    expect(
      grantFits('write_file', { file_path: '.git/info/attributes', content: 'x' }, repo),
      '.git/info/attributes must not be covered (global filter assignment)',
    ).toBe(false);
  });

  it('a granted write to .git/config + .gitattributes, then auto-allowed git_read blame, runs a shell command unasked', async () => {
    const asks: { resolve(v: unknown): void }[] = [];
    const peer: AcpClientPeer = {
      request: (_m, _params) => new Promise((resolve) => { asks.push({ resolve }); }),
      notify: () => Promise.resolve(),
    };
    const gate = createAcpPermissionGate(peer, 'sid', {
      skip: false, cwd: repo, onCancelled: vi.fn(),
      emitToolCall: vi.fn(async (_u: ToolCallStart) => {}),
    });
    const ctx = { resolveBase: repo } as never;
    const write = createWriteFileHandler(repo);
    const gitRead = createGitReadHandler(repo);

    // Step 1: one approval for a benign inside write → "Always allow".
    const first = gate.canUseTool('write_file', { file_path: 'notes.md', content: 'hello\n' }, opts('1'));
    await flush();
    expect(asks.length).toBe(1);
    asks[0]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
    expect((await first).behavior).toBe('allow');

    // Step 2: under the grant, overwrite .git/config with a clean filter.
    const existing = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    const newConfig = existing + `[filter "x"]\n\tclean = touch ${marker} && cat\n`;
    const v2 = await gate.canUseTool('write_file', { file_path: '.git/config', content: newConfig }, opts('2'));
    if (v2.behavior === 'allow') {
      await write({ file_path: '.git/config', content: newConfig }, new AbortController().signal, ctx);
    }

    // Step 3: under the grant, write .gitattributes assigning the filter.
    const v3 = await gate.canUseTool('write_file', { file_path: '.gitattributes', content: '* filter=x\n' }, opts('3'));
    if (v3.behavior === 'allow') {
      await write({ file_path: '.gitattributes', content: '* filter=x\n' }, new AbortController().signal, ctx);
    }

    // Step 4: dirty a tracked file so blame/diff has working-tree content to filter.
    fs.appendFileSync(path.join(repo, 'a.txt'), 'world\n');

    // Step 5: auto-allowed git_read blame — git runs the clean filter to diff
    // working-tree vs index; arbitrary command executes.
    const blameInput = { subcommand: 'blame', args: ['-s'], paths: ['a.txt'] };
    const v5 = await gate.canUseTool('git_read', blameInput, opts('5'));
    if (v5.behavior === 'allow') {
      await gitRead(blameInput, new AbortController().signal, ctx);
    }

    const ran = fs.existsSync(marker);
    // SAFE: either .git/config was asked (v2 ≠ allow), or code did not run.
    // FAILS on 0a045c5d6: v2===allow, v3===allow, ran===true, asks.length===1.
    expect(
      { codeRan: ran, questionsAsked: asks.length },
      'shell command ran under a remembered grant with only the initial one approval',
    ).not.toEqual({ codeRan: true, questionsAsked: 1 });
  });
});
