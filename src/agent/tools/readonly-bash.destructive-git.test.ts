/**
 * Bypass forms of the destructive-git gate found by executing
 * `classifyDestructiveGit` at 8ec61fe3d (PR #4360 triage): every string in the
 * `blocks` tables returned allow before this change. The `still allows` tables
 * pin forms that are allowed on purpose so the tightening does not overreach.
 * Strings are passed to the classifier only, never run.
 */
import { describe, it, expect } from 'vitest';
import { classifyDestructiveGit } from './readonly-bash.tokenizer.js';

function expectBlocked(cmd: string): void {
  const v = classifyDestructiveGit(cmd);
  expect(v.destructive, `expected "${cmd}" to be destructive`).toBe(true);
  expect(v.reason).toBeTruthy();
}

function expectAllowed(cmd: string): void {
  const v = classifyDestructiveGit(cmd);
  expect(v.destructive, `expected "${cmd}" to be allowed, got: ${v.reason ?? ''}`).toBe(false);
}

describe('classifyDestructiveGit: interpreter -c strings and eval', () => {
  const blocks = [
    'sh -c "git checkout main"',
    "bash -c 'git reset --hard'",
    'zsh -c "git checkout main"',
    'env bash -c "git reset --hard"',
    'sudo sh -c "git checkout main"',
    'bash -lc "git reset --hard"',
    'sh -c "cd x && git clean -fd"',
    "eval 'git checkout main'",
    'eval git checkout main',
    '/bin/bash -c "git restore ."',
    'bash -o pipefail -c "git checkout main"',
    `sh -c "sh -c 'git checkout main'"`,
    'if true; then bash -c "git clean -fd"; fi',
  ];
  for (const cmd of blocks) it(`blocks: ${cmd}`, () => expectBlocked(cmd));

  const allows = [
    'sh -c "git status"',
    "bash -c 'git log --oneline'",
    'bash -c "echo hi"',
    "eval 'git diff'",
    'bash script.sh',
  ];
  for (const cmd of allows) it(`still allows: ${cmd}`, () => expectAllowed(cmd));
});

describe('classifyDestructiveGit: command substitution as the command name', () => {
  const blocks = [
    '$(echo git) checkout main',
    '`echo git` checkout main',
    '$(which git) reset --hard',
    'cd x && $(echo git) clean -fd',
  ];
  for (const cmd of blocks) it(`blocks: ${cmd}`, () => expectBlocked(cmd));

  const allows = [
    'echo "$(git rev-parse HEAD)"',
    'git -C $(pwd) status',
    'git log $(git merge-base HEAD main)..HEAD',
  ];
  for (const cmd of allows) it(`still allows: ${cmd}`, () => expectAllowed(cmd));
});

describe('classifyDestructiveGit: inline git aliases', () => {
  const blocks = [
    'git -c alias.co=checkout co main',
    'git -c alias.nuke="reset --hard" nuke',
    "git -c 'alias.x=!git checkout main' x",
  ];
  for (const cmd of blocks) it(`blocks: ${cmd}`, () => expectBlocked(cmd));
  it('still allows a read-only alias: git -c alias.st=status st', () => {
    expectAllowed('git -c alias.st=status st');
  });
});

describe('classifyDestructiveGit: branch-creation exemption is narrow', () => {
  const blocks = [
    'git switch -c x --discard-changes main',
    'git checkout -b x -- src/a.ts',
    'git checkout -b x -f main',
    'git checkout -B x --merge main',
    'git switch -C x --force main',
  ];
  for (const cmd of blocks) it(`blocks: ${cmd}`, () => expectBlocked(cmd));

  const allows = [
    'git checkout -b x',
    'git switch -c x',
    'git checkout -b x origin/main',
    'git switch -c rescue-wip HEAD',
    'git checkout -B x',
    'git switch -C x',
  ];
  for (const cmd of allows) it(`still allows: ${cmd}`, () => expectAllowed(cmd));
});

describe('classifyDestructiveGit: plumbing and worktree forms', () => {
  const blocks = [
    'git read-tree -u --reset HEAD',
    'git read-tree -u -m HEAD',
    'git checkout-index -a -f',
    'git checkout-index --force --all',
    'git worktree remove --force .',
    'git worktree remove -f ../other',
  ];
  for (const cmd of blocks) it(`blocks: ${cmd}`, () => expectBlocked(cmd));

  const allows = [
    'git read-tree HEAD',
    'git checkout-index -a',
    'git worktree remove ../other',
    'git worktree list',
  ];
  for (const cmd of allows) it(`still allows: ${cmd}`, () => expectAllowed(cmd));
});

describe('classifyDestructiveGit: forms allowed on purpose stay allowed', () => {
  const allows = [
    'git show HEAD:f > f',
    'git stash',
    'git stash push -m wip',
    'git status',
    'git diff HEAD',
  ];
  for (const cmd of allows) it(`still allows: ${cmd}`, () => expectAllowed(cmd));
});

describe('classifyDestructiveGit: file-restore policy is unchanged', () => {
  // Awaiting the owner's decision; this PR must not loosen or tighten it.
  const blocks = ['git checkout -- src/a.ts', 'git checkout src/a.ts', 'git restore src/a.ts'];
  for (const cmd of blocks) it(`blocks: ${cmd}`, () => expectBlocked(cmd));
});

describe('classifyDestructiveGit: nesting fails closed past the depth limit', () => {
  it('treats git inside a very deep nest as destructive', () => {
    let cmd = 'git status';
    for (let i = 0; i < 8; i++) cmd = `eval ${JSON.stringify(cmd)}`;
    expect(classifyDestructiveGit(cmd).destructive).toBe(true);
  });
  it('does not block a deep nest that never mentions git', () => {
    let cmd = 'echo hi';
    for (let i = 0; i < 8; i++) cmd = `eval ${JSON.stringify(cmd)}`;
    expect(classifyDestructiveGit(cmd).destructive).toBe(false);
  });
});
