import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isContained, outsidePaths } from './acp.permission.paths.js';
import { permissionOptions, requiresAsk } from './acp.permission.policy.js';

const cwd = path.join(os.tmpdir(), 'acp-p1b-ws');
const out = path.join(os.tmpdir(), 'acp-p1b-other', 'secret.txt');

describe('D10 lexical containment', () => {
  it('uses path.relative, not prefixes: a sibling sharing the prefix is outside', () => {
    expect(isContained(cwd, path.join(cwd, 'a', 'b'))).toBe(true);
    expect(isContained(cwd, cwd)).toBe(true);
    expect(isContained(cwd, `${cwd}-evil`)).toBe(false);
    expect(isContained(cwd, path.dirname(cwd))).toBe(false);
    expect(isContained(cwd, path.join(cwd, '..foo'))).toBe(true);
  });
  it('windows drive and UNC roots are outside a POSIX-or-Windows cwd', () => {
    const w = path.win32;
    expect(w.relative('C:\\ws', 'D:\\x')).toBe('D:\\x');
    expect(isContained(cwd, path.resolve(cwd, '..', '..'))).toBe(false);
  });
});

describe('D10 auto-allow only inside the session cwd', () => {
  it('a read with no path argument defaults to the cwd and is not asked', () => {
    for (const n of ['grep', 'glob', 'list_directory', 'git_read', 'memory_search', 'config_get']) {
      // git_read needs a subcommand to be a call at all; `{}` is refused by the tool and asked (fail closed).
      const input = n === 'glob' ? { pattern: '**/*.ts' } : n === 'git_read' ? { subcommand: 'status' } : {};
      expect(requiresAsk(n, input, cwd), n).toBe(false);
    }
  });
  it('inside paths stay auto-allowed, outside paths are asked', () => {
    expect(requiresAsk('read_file', { file_path: path.join(cwd, 'a.txt') }, cwd)).toBe(false);
    expect(requiresAsk('read_file', { file_path: 'sub/a.txt' }, cwd)).toBe(false);
    expect(requiresAsk('read_file', { file_path: out }, cwd)).toBe(true);
    expect(requiresAsk('read_file', { file_path: '../x' }, cwd)).toBe(true);
    expect(requiresAsk('read_file', { file_path: 'sub/../../x' }, cwd)).toBe(true);
    expect(requiresAsk('grep', { pattern: 'k', path: path.dirname(cwd) }, cwd)).toBe(true);
    expect(requiresAsk('list_directory', { path: '/' }, cwd)).toBe(true);
    expect(requiresAsk('json_query', { path: out, query: '.' }, cwd)).toBe(true);
  });
  it('fails closed on unresolvable values and a missing cwd', () => {
    for (const v of [7, '', 'a\u0000b', '~/.ssh/id_rsa', '~', ':(top)x', ['ok', 3], null]) {
      expect(requiresAsk('read_file', { file_path: v }, cwd), String(v)).toBe(true);
    }
    expect(requiresAsk('read_file', { file_path: 'a.txt' }, undefined)).toBe(true);
    expect(requiresAsk('read_file', { file_path: 'a.txt' }, 'relative/cwd')).toBe(true);
  });
  it('scans generic path argument names, lists and cwd on auto-allowed tools', () => {
    expect(requiresAsk('git_read', { subcommand: 'diff', paths: ['src', '../../etc'] }, cwd)).toBe(true);
    expect(requiresAsk('git_read', { subcommand: 'diff', paths: ['src'] }, cwd)).toBe(false);
    expect(requiresAsk('grep', { pattern: 'x', cwd: '/' }, cwd)).toBe(true);
    expect(requiresAsk('artifact_list', { directory: out }, cwd)).toBe(true);
    expect(requiresAsk('get_runtime_state', { root: '/' }, cwd)).toBe(true);
  });
  it('git_read repository relocation options are asked', () => {
    for (const a of ['-C', '--git-dir=/x', '--work-tree=/x', '--output=/tmp/o']) {
      expect(requiresAsk('git_read', { subcommand: 'log', args: [a] }, cwd), a).toBe(true);
    }
    expect(requiresAsk('git_read', { subcommand: 'log', args: ['--oneline'] }, cwd)).toBe(false);
    expect(requiresAsk('git_read', { subcommand: 'log', args: 'oops' }, cwd)).toBe(true);
  });
  it('git_read: content that can come from outside the session directory is asked', () => {
    const ask = (input: Record<string, unknown>) => requiresAsk('git_read', input, cwd);
    // Revision paths and object names reach any file in the repository.
    expect(ask({ subcommand: 'show', args: ['HEAD:../other/file'] })).toBe(true);
    expect(ask({ subcommand: 'show', args: ['HEAD:./inside.txt'] })).toBe(true);
    expect(ask({ subcommand: 'show', args: [':0:secret'] })).toBe(true);
    expect(ask({ subcommand: 'show', args: ['HEAD^{tree}'], paths: ['.'] })).toBe(true);
    expect(ask({ subcommand: 'show', args: ['0123abcd'], paths: ['a.txt'] })).toBe(true);
    expect(ask({ subcommand: 'cat-file', args: ['-p', 'HEAD:other/s.txt'] })).toBe(true);
    expect(ask({ subcommand: 'diff', args: ['HEAD:a', 'HEAD:b'] })).toBe(true);
    expect(ask({ subcommand: 'grep', args: ['HEAD:other'], pattern: 'x' })).toBe(true);
    expect(ask({ subcommand: 'blame', args: ['HEAD:../x'], paths: ['a.txt'] })).toBe(true);
    // Patch output without a pathspec ranges over the whole repository.
    for (const sub of ['show', 'diff']) expect(ask({ subcommand: sub }), sub).toBe(true);
    expect(ask({ subcommand: 'show', args: ['HEAD'] })).toBe(true);
    expect(ask({ subcommand: 'diff', args: ['main..HEAD', '--cached'] })).toBe(true);
    expect(ask({ subcommand: 'log', args: ['-p'] })).toBe(true);
    expect(ask({ subcommand: 'log', args: ['-Ssecret'] })).toBe(true);
    expect(ask({ subcommand: 'log', args: ['--unified=3'] })).toBe(true);
    expect(ask({ subcommand: 'log', args: ['-p', '--follow'], paths: ['a.txt'] })).toBe(true);
    // Not understood: refused by the tool's policy, so asked (fail closed).
    expect(ask({ subcommand: 'show', args: ['--ext-diff'] })).toBe(true);
    expect(ask({ subcommand: 'nope' })).toBe(true);
    expect(ask({ subcommand: 'log', args: [3] })).toBe(true);
  });
  it('git_read: metadata and content scoped inside the session directory are not asked', () => {
    const ask = (input: Record<string, unknown>) => requiresAsk('git_read', input, cwd);
    for (const input of [
      { subcommand: 'status', args: ['--short'] },
      { subcommand: 'branch', args: ['-a'] },
      { subcommand: 'tag' },
      { subcommand: 'log', args: ['--oneline', '--max-count=20'] },
      { subcommand: 'log', args: ['--stat', 'main..HEAD'] },
      { subcommand: 'rev-parse', args: ['HEAD'] },
      { subcommand: 'ls-files' },
      { subcommand: 'show', args: ['--stat', 'HEAD'] },
      { subcommand: 'show', args: ['--no-patch', '--format=%s', 'HEAD'] },
      { subcommand: 'diff', args: ['--name-only'] },
      { subcommand: 'diff', paths: ['src'] },
      { subcommand: 'diff', args: ['HEAD~1', 'HEAD'], paths: ['.'] },
      { subcommand: 'show', args: ['HEAD'], paths: ['a.txt'] },
      { subcommand: 'log', args: ['-p'], paths: ['src'] },
      { subcommand: 'grep', pattern: 'TODO' },
      { subcommand: 'grep', args: ['HEAD'], pattern: 'TODO' },
      { subcommand: 'blame', paths: ['a.txt'] },
      { subcommand: 'cat-file', args: ['-t', 'HEAD'] },
    ]) expect(ask(input), JSON.stringify(input)).toBe(false);
  });
  it('glob roots: absolute pattern, .. segments and absolute brace arms are asked', () => {
    expect(requiresAsk('glob', { pattern: `${path.dirname(cwd)}/**` }, cwd)).toBe(true);
    expect(requiresAsk('glob', { pattern: '../**/*.ts' }, cwd)).toBe(true);
    expect(requiresAsk('glob', { pattern: 'src/**/../../../*' }, cwd)).toBe(true);
    expect(requiresAsk('glob', { pattern: '{src,/etc}/*' }, cwd)).toBe(true);
    expect(requiresAsk('glob', { pattern: 'src/**/*.ts', path: 'sub' }, cwd)).toBe(false);
    expect(requiresAsk('glob', { pattern: '*', path: '..' }, cwd)).toBe(true);
  });
  it('worktree list is auto-allowed only with no other arguments', () => {
    expect(requiresAsk('worktree', { action: 'list' }, cwd)).toBe(false);
    expect(requiresAsk('worktree', { action: 'list', repo: '/elsewhere' }, cwd)).toBe(true);
  });
  it('reports absolute paths for display', () => {
    expect(outsidePaths('read_file', { file_path: '../x.txt' }, cwd)).toEqual([path.resolve(cwd, '../x.txt')]);
    expect(outsidePaths('patch_apply', { changes: [{ path: out }, { path: 'in.txt' }] }, cwd)).toEqual([out]);
  });
});

describe('D11 allow_always availability', () => {
  it('is never offered for bash, delegation tools, or an outside-cwd request', () => {
    for (const n of ['bash', 'agent', 'skill', 'compose', 'remote_agent']) {
      expect(permissionOptions(n).map((o) => o.optionId), n).toEqual(['allow_once', 'reject_once']);
    }
    expect(permissionOptions('read_file', true).map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
    expect(permissionOptions('write_file').map((o) => o.optionId)).toEqual(['allow_once', 'allow_always', 'reject_once']);
  });
});
