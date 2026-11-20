/**
 * Regression guard for red team R2 break 3 (D20): `git_read` content classification treats a bare
 * ref name as a commit. A ref (tag) that points at a BLOB is printed in full
 * by `show <ref> -- .` and `cat-file -p <ref>`; the `-- .` pathspec does not
 * restrict a blob. namesObject (acp.permission.git.ts:35-37) only catches
 * `:`, `^{` and hex ids, so both calls are auto-allowed. (git.git itself
 * ships such a tag: `junio-gpg-pub`.)
 *
 * Asserts the SAFE behaviour; failed on afk/acp-v1 bc8ac988d before D20.
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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-blobref-'));
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

describe('D20: git_read ref that names a blob', () => {
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

describe('D20: revisions that are not provably commits', () => {
  it('real git: every newly asked form prints the blob, every commit-peeled form does not', async () => {
    git(['tag', '-a', '-m', 'm', 'annotated-notes', 'HEAD:secrets/prod.env']);
    const handler = createGitReadHandler(cwd);
    const run = async (input: Record<string, unknown>) =>
      String((await handler(input, new AbortController().signal, { resolveBase: cwd } as never)).content);
    for (const input of [
      { subcommand: 'show', args: ['--stat', 'release-notes'] },
      { subcommand: 'show', args: ['--no-patch', '--format=%s', 'release-notes'] },
      { subcommand: 'grep', args: ['release-notes'], pattern: 'DB_' },
      { subcommand: 'for-each-ref', args: ['--format=%(raw)', 'refs/tags/release-notes'] },
      { subcommand: 'for-each-ref', args: ['--format=%(*raw)', 'refs/tags/annotated-notes'] },
      { subcommand: 'tag', args: ['--format=%(raw)'] },
    ]) {
      expect(await run(input), JSON.stringify(input)).toContain('DB_PASSWORD=hunter2');
      expect(requiresAsk('git_read', input, cwd), JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      { subcommand: 'show', args: ['release-notes~0'], paths: ['.'] },
      { subcommand: 'show', args: ['release-notes^{commit}'], paths: ['.'] },
      { subcommand: 'grep', args: ['release-notes~0'], pattern: 'DB_' },
      { subcommand: 'log', args: ['--oneline', 'release-notes'] },
    ]) {
      expect(await run(input), JSON.stringify(input)).not.toContain('DB_PASSWORD=hunter2');
      expect(requiresAsk('git_read', input, cwd), JSON.stringify(input)).toBe(false);
    }
  });
  it('lexical: cat-file -p always asks; bare refs on show/grep/diff ask; HEAD forms stay allowed', () => {
    const ask = (input: Record<string, unknown>) => requiresAsk('git_read', input, cwd);
    expect(ask({ subcommand: 'cat-file', args: ['-p', 'HEAD~1'] })).toBe(true);
    expect(ask({ subcommand: 'show', args: ['v1.0'], paths: ['a.txt'] })).toBe(true);
    expect(ask({ subcommand: 'diff', args: ['v1', 'v2'], paths: ['.'] })).toBe(true);
    expect(ask({ subcommand: 'grep', args: ['main'], pattern: 'x' })).toBe(true);
    expect(ask({ subcommand: 'show', args: ['HEAD'], paths: ['a.txt'] })).toBe(false);
    expect(ask({ subcommand: 'diff', args: ['HEAD~1', 'HEAD'], paths: ['.'] })).toBe(false);
    expect(ask({ subcommand: 'diff', args: ['main~0..HEAD'], paths: ['.'] })).toBe(false);
    expect(ask({ subcommand: 'show', args: ['--stat', 'HEAD^2'] })).toBe(false);
  });
});
