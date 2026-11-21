/**
 * Guarantee: every `git_read` subcommand that can print object content is
 * asked whenever a revision is not provably a commit, whatever the options or
 * pathspec (profile section 6, D20). Origin: red team round 2 showed
 * `diff <blob-ref> -- <file inside cwd>` printing an outside blob as removed
 * lines while auto-allowed. Verified against real git in a temporary repository.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requiresAsk } from './acp.permission.policy.js';
import { createGitReadHandler } from '../../agent/tools/handlers/git-read.js';

let repo = '';
let cwd = '';
const git = (args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: repo, encoding: 'utf8' });
const run = async (input: Record<string, unknown>): Promise<string> => {
  const r = await createGitReadHandler(cwd)(input, new AbortController().signal, { resolveBase: cwd } as never);
  return String(r.content);
};

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-git-content-'));
  cwd = path.join(repo, 'app');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(repo, 'secrets'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'inside\n');
  fs.writeFileSync(path.join(repo, 'secrets', 'prod.env'), 'DB_PASSWORD=hunter2\n');
  git(['init', '-q']);
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  git(['tag', 'release-notes', 'HEAD:secrets/prod.env']); // a ref naming a blob outside cwd
});
afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('git_read content rule: a non-commit revision on a content subcommand is asked', () => {
  for (const input of [
    { subcommand: 'diff', args: ['release-notes'], paths: ['a.txt'] },
    { subcommand: 'diff', args: ['release-notes', '--', 'a.txt'] },
    { subcommand: 'diff', args: ['--word-diff', 'release-notes'], paths: ['a.txt'] },
    { subcommand: 'diff', args: ['--unified=0', 'release-notes'], paths: ['a.txt'] },
    { subcommand: 'diff', args: ['-w', 'release-notes'], paths: ['a.txt'] },
    { subcommand: 'diff', args: ['--stat', '-p', 'release-notes'], paths: ['a.txt'] },
    { subcommand: 'show', args: ['-s', 'release-notes'] },
    { subcommand: 'show', args: ['--oneline', 'release-notes'], paths: ['a.txt'] },
    { subcommand: 'grep', args: ['release-notes'], paths: ['a.txt'], pattern: 'DB_' },
    { subcommand: 'cat-file', args: ['blob', 'release-notes'] },
  ]) {
    it(`${JSON.stringify(input)} prints the outside blob and is asked`, async () => {
      // Precondition: the real tool returns the outside file's content.
      expect(await run(input)).toContain('DB_PASSWORD=hunter2');
      expect(requiresAsk('git_read', input, cwd), 'outside blob content auto-allowed').toBe(true);
    });
  }

  it('every content subcommand asks for a bare ref, even where git happens to print nothing', () => {
    for (const input of [
      { subcommand: 'diff', args: ['--stat', 'release-notes'], paths: ['a.txt'] },
      { subcommand: 'diff', args: ['--name-only', 'release-notes'], paths: ['a.txt'] },
      { subcommand: 'diff', args: ['release-notes', 'HEAD'], paths: ['.'] },
      { subcommand: 'blame', args: ['release-notes'], paths: ['a.txt'] },
      { subcommand: 'cat-file', args: ['-t', 'release-notes', 'HEAD'] },
      { subcommand: 'log', args: ['-p', 'release-notes'], paths: ['a.txt'] },
    ]) expect(requiresAsk('git_read', input, cwd), JSON.stringify(input)).toBe(true);
  });

  it('commit-proven revisions and metadata-only forms stay auto-allowed', async () => {
    for (const input of [
      { subcommand: 'diff', args: ['HEAD'], paths: ['a.txt'] },
      { subcommand: 'diff', args: ['release-notes~0', 'HEAD'], paths: ['a.txt'] },
      { subcommand: 'show', args: ['--stat', 'HEAD'] },
      { subcommand: 'blame', args: ['HEAD'], paths: ['a.txt'] },
      { subcommand: 'cat-file', args: ['-t', 'release-notes'] },
      { subcommand: 'cat-file', args: ['-s', 'release-notes'] },
      { subcommand: 'log', args: ['--oneline', 'release-notes'] },
    ]) {
      expect(requiresAsk('git_read', input, cwd), JSON.stringify(input)).toBe(false);
      expect(await run(input), JSON.stringify(input)).not.toContain('DB_PASSWORD');
    }
  });
});
