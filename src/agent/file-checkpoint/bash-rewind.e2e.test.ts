/**
 * #4271 acceptance, end to end with real git, the real bash and write_file
 * handlers, and the real restore: a turn edits two files and runs bash that
 * creates a third and modifies a tracked one. Rewind previews all of them,
 * restores the edits, and deletes the created file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginCheckpointTurn, endCheckpointTurn } from './turn-lifecycle.js';
import { rewindFiles } from './rewind-files.js';
import { readTurnLog } from './turn-log.js';
import { createBashHandler } from '../tools/handlers/bash.js';
import { createWriteFileHandler } from '../tools/handlers/write-file.js';
import type { ToolHandlerContext } from '../tools/types.js';

const SESSION = 'e2e-session';
let repo: string;
let state: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const read = (name: string) => readFileSync(join(repo, name), 'utf8');
const signal = () => new AbortController().signal;

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'afk-bash-rewind-repo-')));
  state = realpathSync.native(mkdtempSync(join(tmpdir(), 'afk-bash-rewind-state-')));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'one.txt'), 'one-0\n');
  writeFileSync(join(repo, 'two.txt'), 'two-0\n');
  writeFileSync(join(repo, 'tracked.txt'), 'tracked-0\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe('bash side effects are rewindable (#4271 stage 2)', () => {
  it('previews and restores tool edits plus bash-created and bash-modified files', async () => {
    const registry = beginCheckpointTurn(SESSION, 't1', state);
    const context: ToolHandlerContext = { resolveBase: repo, writeRoots: [repo], readRoots: [repo], fileCheckpoint: registry };
    const write = createWriteFileHandler(repo);
    expect((await write({ file_path: join(repo, 'one.txt'), content: 'one-1\n' }, signal(), context)).isError).not.toBe(true);
    expect((await write({ file_path: join(repo, 'two.txt'), content: 'two-1\n' }, signal(), context)).isError).not.toBe(true);
    const bash = await createBashHandler('default', repo)(
      { command: 'node -e "require(\'fs\').writeFileSync(\'three.txt\',\'new\\n\');require(\'fs\').appendFileSync(\'tracked.txt\',\'more\\n\');require(\'fs\').writeFileSync(\'ignored.txt\',\'x\')"' },
      signal(), context,
    );
    expect(bash.isError).not.toBe(true);
    endCheckpointTurn(SESSION, registry, state);
    expect(read('tracked.txt')).toBe('tracked-0\nmore\n');
    expect(readTurnLog(SESSION, state).find((e) => e.kind === 'bash')).toMatchObject({ status: 'captured', files: 2 });

    const deps = { sessionId: SESSION, enableFileCheckpointing: true, _stateDir: state, writePolicy: context };
    const preview = await rewindFiles(deps, 't1', { dryRun: true });
    expect(new Set(preview.filesChanged)).toEqual(new Set(['one.txt', 'two.txt', 'three.txt', 'tracked.txt'].map((n) => join(repo, n))));
    // The bash call has status 'captured' (tracked files were snapshotted).
    // git-ignored files are not restorable, but no per-call warning is emitted
    // for a fully-captured entry — the standing advisory is only appended when
    // at least one bash call was skipped or partial. (#1151e9cd)
    expect(preview.uncaptured).toBeUndefined();
    expect(read('one.txt')).toBe('one-1\n');

    const result = await rewindFiles(deps, 't1');
    expect(result.canRewind).toBe(true);
    expect(read('one.txt')).toBe('one-0\n');
    expect(read('two.txt')).toBe('two-0\n');
    expect(read('tracked.txt')).toBe('tracked-0\n');
    expect(existsSync(join(repo, 'three.txt'))).toBe(false);
    // Ignored files are out of scope and left alone.
    expect(read('ignored.txt')).toBe('x');
    // The user's repository was not written to by the capture.
    expect(git('status', '--porcelain').toString()).toBe('');
  });

  it('a path written by write_file then by bash in one turn keeps its pre-turn snapshot', async () => {
    const registry = beginCheckpointTurn(SESSION, 't1', state);
    const context: ToolHandlerContext = { resolveBase: repo, writeRoots: [repo], readRoots: [repo], fileCheckpoint: registry };
    await createWriteFileHandler(repo)({ file_path: join(repo, 'one.txt'), content: 'one-1\n' }, signal(), context);
    await createBashHandler('default', repo)({ command: 'node -e "require(\'fs\').writeFileSync(\'one.txt\',\'one-2\\n\')"' }, signal(), context);
    endCheckpointTurn(SESSION, registry, state);
    const result = await rewindFiles({ sessionId: SESSION, enableFileCheckpointing: true, _stateDir: state, writePolicy: context }, 't1');
    expect(result.canRewind).toBe(true);
    expect(read('one.txt')).toBe('one-0\n');
  });
});
