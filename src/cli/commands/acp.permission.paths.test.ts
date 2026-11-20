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
      expect(requiresAsk(n, n === 'glob' ? { pattern: '**/*.ts' } : {}, cwd), n).toBe(false);
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
