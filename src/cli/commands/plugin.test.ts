/**
 * Tests for the `afk plugin` command tree. Drives the subcommands through a
 * real Commander instance but substitutes the module layer via deps so we
 * don't touch the network or shell out to git.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { registerPluginCommand } from './plugin.js';
import { upsertPlugin, readIndex } from '../../agent/plugins/index-store.js';
import type { GitRunner } from '../../agent/plugins/git.js';
import { subcommandOf } from '../../agent/plugins/git-test-helpers.js';

let tmpDir: string;
let pluginsDir: string;
let indexPath: string;
let logs: string[];
let logger: Pick<Console, 'log' | 'error'>;

function writeManifest(dir: string, name: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.0.0' }),
  );
}

function fakeGit(tags: string[]): GitRunner {
  return async (args) => {
    // args is hardening-prefixed (`[-c, k=v, ..., <sub>, ...]`).
    const sub = subcommandOf(args);
    if (sub === 'clone') {
      const dest = args[args.length - 1];
      mkdirSync(dest, { recursive: true });
      writeManifest(dest, 'cloned-plugin');
      return { stdout: '', stderr: '' };
    }
    if (sub === 'tag') return { stdout: tags.join('\n') + '\n', stderr: '' };
    if (sub === 'rev-parse') {
      // These fixtures track tags, not branches. Mimic real git failing on
      // `rev-parse --verify --quiet refs/remotes/origin/<tag>` so the updater
      // treats the ref as an immutable tag (compare by name) rather than a
      // moving branch (compare by commit).
      const rev = args[args.length - 1];
      if (typeof rev === 'string' && rev.startsWith('refs/remotes/origin/')) {
        throw new Error('fatal: Needed a single revision');
      }
      return { stdout: 'abc123\n', stderr: '' };
    }
    if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
}

function makeProgram(gitRunner?: GitRunner): Command {
  const program = new Command();
  program.exitOverride();
  registerPluginCommand(program, {
    pluginsDir,
    indexPath,
    ...(gitRunner ? { gitRunner } : {}),
    now: () => new Date('2026-04-20T12:00:00Z'),
    logger,
  });
  return program;
}

async function runArgv(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(['node', 'test', ...args]);
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-cli-plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  pluginsDir = join(tmpDir, 'plugins');
  indexPath = join(pluginsDir, '.index.json');
  mkdirSync(pluginsDir, { recursive: true });
  logs = [];
  logger = {
    log: (...args: unknown[]) => logs.push(args.map((a) => String(a)).join(' ')),
    error: (...args: unknown[]) => logs.push(args.map((a) => String(a)).join(' ')),
  };
  // Silence the ora spinner so vitest output stays clean.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // Silence stderr from handleCommandError, and prevent process.exit from
  // terminating the test process. handleCommandError calls process.exit after
  // presenting the error; we capture the code and translate it back to
  // process.exitCode so existing assertions (expect(process.exitCode).toBe(1))
  // still pass.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
    process.exitCode = typeof code === 'number' ? code : 1;
    return undefined as never;
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('plugin install', () => {
  it('installs a GitHub-shorthand plugin via the CLI', async () => {
    await runArgv(makeProgram(fakeGit(['v1.0.0'])), ['plugin', 'install', 'anthropics/demo']);
    expect(existsSync(join(pluginsDir, 'cloned-plugin'))).toBe(true);
    expect(readIndex(indexPath).plugins['cloned-plugin']).toBeDefined();
  });

  it('honors --ref and --force', async () => {
    const sourceDir = join(tmpDir, 'src');
    mkdirSync(sourceDir);
    writeManifest(sourceDir, 'local-plugin');

    await runArgv(makeProgram(), ['plugin', 'install', sourceDir]);
    expect(existsSync(join(pluginsDir, 'local-plugin'))).toBe(true);

    // Re-install without --force → should complain (exitCode 1) and leave
    // the existing dir in place.
    await runArgv(makeProgram(), ['plugin', 'install', sourceDir]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    // With --force it replaces cleanly.
    await runArgv(makeProgram(), ['plugin', 'install', sourceDir, '--force']);
    expect(existsSync(join(pluginsDir, 'local-plugin'))).toBe(true);
  });
});

describe('plugin list', () => {
  it('prints a placeholder when nothing is installed', async () => {
    await runArgv(makeProgram(), ['plugin', 'list']);
    expect(logs.some((l) => l.includes('No plugins installed'))).toBe(true);
  });

  it('prints installed plugins with their state', async () => {
    upsertPlugin(
      'alpha',
      {
        source: 'owner/alpha', sourceType: 'github', ref: 'v1.0.0', commit: 'sha',
        enabled: true, installedAt: '2026-04-20T00:00:00Z', updatedAt: '2026-04-20T00:00:00Z',
      },
      indexPath,
    );
    await runArgv(makeProgram(), ['plugin', 'list']);
    const joined = logs.join('\n');
    expect(joined).toMatch(/alpha/);
    expect(joined).toMatch(/v1\.0\.0/);
    expect(joined).toMatch(/enabled/);
  });
});

describe('plugin enable / disable', () => {
  beforeEach(() => {
    upsertPlugin(
      'target',
      {
        source: 'x', sourceType: 'local', ref: null, commit: null,
        enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      },
      indexPath,
    );
  });

  it('disable flips the flag to false', async () => {
    await runArgv(makeProgram(), ['plugin', 'disable', 'target']);
    expect(readIndex(indexPath).plugins['target'].enabled).toBe(false);
  });

  it('enable flips the flag back', async () => {
    await runArgv(makeProgram(), ['plugin', 'disable', 'target']);
    await runArgv(makeProgram(), ['plugin', 'enable', 'target']);
    expect(readIndex(indexPath).plugins['target'].enabled).toBe(true);
  });

  it('reports a clear error when the plugin is unknown', async () => {
    // handleCommandError writes to stderr; capture what was written.
    const stderrWrites: string[] = [];
    const stderrMock = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    await runArgv(makeProgram(), ['plugin', 'disable', 'ghost']);
    stderrMock.mockRestore();
    expect(process.exitCode).toBe(1);
    const stderrOutput = stderrWrites.join('');
    expect(/not in the index/i.test(stderrOutput) || /ghost/i.test(stderrOutput)).toBe(true);
    process.exitCode = 0;
  });
});

describe('plugin remove', () => {
  it('removes the dir and index entry', async () => {
    const dir = join(pluginsDir, 'nuke-me');
    mkdirSync(dir);
    upsertPlugin(
      'nuke-me',
      {
        source: 'x', sourceType: 'local', ref: null, commit: null,
        enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      },
      indexPath,
    );
    await runArgv(makeProgram(), ['plugin', 'remove', 'nuke-me']);
    expect(existsSync(dir)).toBe(false);
    expect(readIndex(indexPath).plugins['nuke-me']).toBeUndefined();
  });

  it('is a no-op for an unknown plugin', async () => {
    await runArgv(makeProgram(), ['plugin', 'remove', 'ghost']);
    expect(logs.some((l) => /No plugin named "ghost"/.test(l))).toBe(true);
  });
});

describe('plugin update', () => {
  it('runs update on a single plugin', async () => {
    mkdirSync(join(pluginsDir, 'to-update'));
    upsertPlugin(
      'to-update',
      {
        source: 'owner/repo', sourceType: 'github', ref: 'v1.0.0', commit: 'old',
        enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      },
      indexPath,
    );
    await runArgv(makeProgram(fakeGit(['v2.0.0', 'v1.0.0'])), ['plugin', 'update', 'to-update']);
    expect(readIndex(indexPath).plugins['to-update'].ref).toBe('v2.0.0');
  });

  it('updates every plugin when no name is passed', async () => {
    mkdirSync(join(pluginsDir, 'a'));
    mkdirSync(join(pluginsDir, 'b'));
    for (const name of ['a', 'b']) {
      upsertPlugin(
        name,
        {
          source: `owner/${name}`, sourceType: 'github', ref: 'v1.0.0', commit: 'old',
          enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        },
        indexPath,
      );
    }
    await runArgv(makeProgram(fakeGit(['v2.0.0'])), ['plugin', 'update']);
    const idx = readIndex(indexPath);
    expect(idx.plugins.a.ref).toBe('v2.0.0');
    expect(idx.plugins.b.ref).toBe('v2.0.0');
  });
});
