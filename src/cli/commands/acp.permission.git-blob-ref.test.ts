/**
 * RED TEAM (R2), class A: `git_read` content classification treats a bare
 * ref name as a commit. A ref (tag) that points at a BLOB is printed in full
 * by `show <ref> -- .` and `cat-file -p <ref>`; the `-- .` pathspec does not
 * restrict a blob. namesObject (acp.permission.git.ts:35-37) only catches
 * `:`, `^{` and hex ids, so both calls are auto-allowed. (git.git itself
 * ships such a tag: `junio-gpg-pub`.)
 *
 * Asserts the SAFE behaviour; FAILS on afk/acp-v1 bc8ac988d.
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
const git = (args: string[], at = repo) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: at, encoding: 'utf8' });

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-blobref-'));
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

describe('redteam A: git_read ref that names a blob', () => {
  for (const input of [
    { subcommand: 'show', args: ['release-notes'], paths: ['.'] },
    { subcommand: 'cat-file', args: ['-p', 'release-notes'] },
  ]) {
    it(`${JSON.stringify(input)} returns outside content and must be asked`, async () => {
      const handler = createGitReadHandler(cwd);
      const r = await handler(input, new AbortController().signal, { resolveBase: cwd } as never);
      // Precondition: the real tool returns the outside file's content.
      expect(String(r.content)).toContain('DB_PASSWORD=hunter2');
      // SAFE: asked. On this code: auto-allowed.
      expect(requiresAsk('git_read', input, cwd), 'content outside the session cwd auto-allowed').toBe(true);
    });
  }
});
