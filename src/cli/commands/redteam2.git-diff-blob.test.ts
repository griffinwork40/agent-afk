/**
 * Red team round 2: `git_read diff <ref> -- <file>` with a ref that names a
 * blob OUTSIDE the session cwd diffs that blob against the working-tree file
 * and prints the blob's full content as `-` lines. The profile (section 6,
 * D20) claims "`diff` with a pathspec prints nothing for a blob revision
 * (verified against git)"; that was verified only with a directory pathspec
 * (`-- .`) or two revisions. A single blob revision plus a FILE pathspec
 * inside the cwd prints the outside blob, and the call is auto-allowed.
 *
 * Asserts the SAFE behaviour (asked); fails on 6f18f96c7.
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

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt2-diffblob-'));
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

describe('redteam2: git_read diff <blob-ref> -- <file inside cwd>', () => {
  for (const input of [
    { subcommand: 'diff', args: ['release-notes'], paths: ['a.txt'] },
    { subcommand: 'diff', args: ['release-notes', '--', 'a.txt'] },
    { subcommand: 'diff', args: ['--word-diff', 'release-notes'], paths: ['a.txt'] },
    { subcommand: 'diff', args: ['--unified=0', 'release-notes'], paths: ['a.txt'] },
  ]) {
    it(`${JSON.stringify(input)} prints the outside blob and must be asked`, async () => {
      const handler = createGitReadHandler(cwd);
      const r = await handler(input, new AbortController().signal, { resolveBase: cwd } as never);
      // Precondition: the real tool returns the outside file's content.
      expect(String(r.content)).toContain('DB_PASSWORD=hunter2');
      expect(requiresAsk('git_read', input, cwd), 'outside blob content auto-allowed via diff').toBe(true);
    });
  }
});
