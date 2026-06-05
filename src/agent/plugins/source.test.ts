/**
 * Tests for the plugin source parser. Covers all four resolution branches,
 * GitHub shorthand expansion, `~` expansion, and the local/shorthand
 * ambiguity rule.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { parseSource, expandHome } from './source.js';

let tmpDir: string;

beforeEach(() => {
  const raw = join(tmpdir(), `afk-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  tmpDir = realpathSync(raw);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('expandHome', () => {
  it('returns home dir for bare ~', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('expands ~/subdir', () => {
    expect(expandHome('~/foo/bar')).toBe(join(homedir(), 'foo/bar'));
  });

  it('leaves inputs without ~ untouched', () => {
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('./relative')).toBe('./relative');
    expect(expandHome('owner/repo')).toBe('owner/repo');
  });
});

describe('parseSource — local paths', () => {
  it('resolves an absolute existing directory to a local source', () => {
    const parsed = parseSource(tmpDir);
    expect(parsed).toEqual({ type: 'local', path: tmpDir });
  });

  it('resolves a relative existing directory to a local source', () => {
    const cwd = process.cwd();
    try {
      process.chdir(tmpDir);
      mkdirSync(join(tmpDir, 'nested'));
      const parsed = parseSource('./nested');
      expect(parsed).toEqual({ type: 'local', path: join(tmpDir, 'nested') });
    } finally {
      process.chdir(cwd);
    }
  });

  it('expands ~ in local paths', () => {
    // Use an existing directory inside $HOME for the probe.
    const parsed = parseSource('~');
    expect(parsed).toEqual({ type: 'local', path: homedir() });
  });
});

describe('parseSource — git URLs', () => {
  it('parses https git URL', () => {
    expect(parseSource('https://github.com/owner/repo.git')).toEqual({
      type: 'git',
      url: 'https://github.com/owner/repo.git',
    });
  });

  it('parses ssh-style git@ URL', () => {
    expect(parseSource('git@github.com:owner/repo.git')).toEqual({
      type: 'git',
      url: 'git@github.com:owner/repo.git',
    });
  });

  it('parses git:// URL', () => {
    expect(parseSource('git://example.com/foo.git')).toEqual({
      type: 'git',
      url: 'git://example.com/foo.git',
    });
  });

  it('parses ssh:// URL', () => {
    expect(parseSource('ssh://git@example.com/foo.git')).toEqual({
      type: 'git',
      url: 'ssh://git@example.com/foo.git',
    });
  });
});

describe('parseSource — GitHub shorthand', () => {
  it('expands owner/repo to an https clone URL', () => {
    expect(parseSource('anthropics/claude-plugins-official')).toEqual({
      type: 'github',
      owner: 'anthropics',
      repo: 'claude-plugins-official',
      url: 'https://github.com/anthropics/claude-plugins-official.git',
    });
  });

  it('accepts dots and dashes in owner/repo names', () => {
    expect(parseSource('foo-bar/baz.qux')).toEqual({
      type: 'github',
      owner: 'foo-bar',
      repo: 'baz.qux',
      url: 'https://github.com/foo-bar/baz.qux.git',
    });
  });

  it('strips a trailing .git suffix from the repo name', () => {
    expect(parseSource('owner/repo.git')).toEqual({
      type: 'github',
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo.git',
    });
  });
});

describe('parseSource — marketplace shorthand', () => {
  it('parses <mp>:<plugin>', () => {
    expect(parseSource('my-registry:example-plugin')).toEqual({
      type: 'marketplace-ref',
      marketplace: 'my-registry',
      plugin: 'example-plugin',
    });
  });

  it('parses identical mp and plugin names', () => {
    expect(parseSource('example-plugin:example-plugin')).toEqual({
      type: 'marketplace-ref',
      marketplace: 'example-plugin',
      plugin: 'example-plugin',
    });
  });

  it('does not match git@host:owner/repo (which contains both : and /)', () => {
    expect(parseSource('git@github.com:owner/repo.git')).toEqual({
      type: 'git',
      url: 'git@github.com:owner/repo.git',
    });
  });

  it('does not match strings with extra colons', () => {
    expect(() => parseSource('a:b:c')).toThrow(/could not resolve plugin source/);
  });
});

describe('parseSource — errors & edge cases', () => {
  it('throws for empty input', () => {
    expect(() => parseSource('')).toThrow(/plugin source is required/);
    expect(() => parseSource('   ')).toThrow(/plugin source is required/);
  });

  it('throws when nothing matches and the path does not exist', () => {
    expect(() => parseSource('not a valid source')).toThrow(/could not resolve plugin source/);
  });

  it('throws when an obvious-path input does not exist', () => {
    expect(() => parseSource('/this/path/should/never/exist/on/any/box')).toThrow(
      /could not resolve plugin source/,
    );
  });

  it('prefers shorthand when an owner/repo-shaped input is not a filesystem path', () => {
    // `owner/repo` with no matching dir on disk → github shorthand.
    const parsed = parseSource('anthropics/claude-plugins-official');
    expect(parsed.type).toBe('github');
  });
});
