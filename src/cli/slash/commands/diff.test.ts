import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSyncRetry } from '../../../__test-utils__/rm-sync-retry.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import type { SessionStats, SlashContext } from '../types.js';
import { diffCmd } from './diff.js';
import type { OutputBlock } from '../output-blocks.js';

const dirs: string[] = [];

afterEach(() => {
  delete process.env['AFK_DIFF_LINES'];
  for (const dir of dirs.splice(0)) rmSyncRetry(dir);
});

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'afk-diff-'));
  dirs.push(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  writeFileSync(join(cwd, 'file.txt'), 'one\ntwo\nthree\n');
  execFileSync('git', ['add', '.'], { cwd });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd });
  return cwd;
}

function context(cwd: string): { ctx: SlashContext; output: string[] } {
  const output: string[] = [];
  const stats = { cwd } as SessionStats;
  const write = (text = ''): void => { output.push(stripEscapeSequences(text)); };
  return {
    output,
    ctx: {
      session: { current: {} } as SlashContext['session'],
      stats,
      out: { line: write, raw: write, success: write, info: write, warn: write, error: write },
      ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    },
  };
}

async function structured(cwd: string, args = ''): Promise<OutputBlock[]> {
  const { ctx, output } = context(cwd);
  const blocks: OutputBlock[] = [];
  ctx.out.block = (block) => { blocks.push(block); };
  await diffCmd.handler(ctx, args);
  expect(output).toEqual([]);
  return blocks;
}

function preview(blocks: OutputBlock[]): string {
  const block = blocks.find((item) => item.kind === 'diff');
  if (block?.kind !== 'diff') throw new Error('Missing diff block');
  return block.diff;
}

describe('structured /diff', () => {
  it.each([undefined, '-1', 'invalid'])('caps large diffs at 60 body lines with setting %s', async (setting) => {
    const cwd = repo();
    if (setting !== undefined) process.env['AFK_DIFF_LINES'] = setting;
    writeFileSync(join(cwd, 'file.txt'), Array.from({ length: 100 }, (_, i) => `new-${i}\n`).join(''));
    const blocks = await structured(cwd);
    expect(blocks[0]).toMatchObject({ kind: 'keyValue', title: 'Uncommitted changes', entries: [
      { key: 'Files', value: '1' }, { key: 'Additions', value: '100' }, { key: 'Deletions', value: '3' },
    ] });
    const diff = preview(blocks);
    expect(diff).toContain('@@ -1,3 +1,100 @@');
    expect(diff).toContain('+new-56\n');
    expect(diff).not.toContain('+new-57\n');
    expect(diff).toContain('… 43 more diff lines');
  });

  it('keeps staged scope, path and counts distinct from unstaged changes', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'file.txt'), 'staged\n');
    execFileSync('git', ['add', 'file.txt'], { cwd });
    writeFileSync(join(cwd, 'file.txt'), 'unstaged\nextra\n');
    const staged = await structured(cwd, '--staged file.txt');
    expect(staged[0]).toMatchObject({ kind: 'keyValue', title: 'Staged changes', entries: [
      { key: 'Path', value: 'file.txt' }, { key: 'Files', value: '1' },
      { key: 'Additions', value: '1' }, { key: 'Deletions', value: '3' },
    ] });
    expect(preview(staged)).toContain('+staged');
    expect(preview(staged)).not.toContain('+unstaged');
    const uncommitted = await structured(cwd);
    expect(uncommitted[0]).toMatchObject({ title: 'Uncommitted changes', entries: [
      { key: 'Files', value: '1' }, { key: 'Additions', value: '2' }, { key: 'Deletions', value: '3' },
    ] });
    expect(preview(uncommitted)).toContain('+unstaged\n+extra');
  });

  it('shares a cap across files, retaining included headers without dangling later headers', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'second.txt'), 'before\n');
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-qm', 'second file'], { cwd });
    writeFileSync(join(cwd, 'file.txt'), 'ONE\ntwo\nthree\n');
    writeFileSync(join(cwd, 'second.txt'), 'after\n');
    process.env['AFK_DIFF_LINES'] = '4';
    const first = await structured(cwd);
    expect(first[0]).toMatchObject({ entries: [
      { key: 'Files', value: '2' }, { key: 'Additions', value: '2' }, { key: 'Deletions', value: '2' },
    ] });
    expect(preview(first)).toContain('… 2 more diff lines');
    expect(preview(first)).not.toContain('second.txt');
    process.env['AFK_DIFF_LINES'] = '5';
    const next = preview(await structured(cwd));
    expect(next).toContain('diff --git a/second.txt b/second.txt');
    expect(next).toContain('@@ -1 +1 @@\n-before\n');
    expect(next).not.toContain('+after');
    expect(next).toContain('… 1 more diff lines');
    process.env['AFK_DIFF_LINES'] = '0';
    const full = preview(await structured(cwd));
    expect(full).toContain('+after');
    expect(full).not.toContain('more diff lines');
  });
});

describe('/diff', () => {
  // Skipped on Windows: tests use POSIX 'test -e'/'touch' and chmod — genuinely POSIX-only.
  it.skipIf(process.platform === 'win32')('passes a pathspec as data instead of shell syntax', async () => {
    // Uses POSIX `test -e` and `touch` commands — POSIX-only.
    const cwd = repo();
    const marker = join(cwd, 'injected');
    writeFileSync(join(cwd, 'file.txt'), 'changed\n');
    const { ctx } = context(cwd);

    await diffCmd.handler(ctx, `file.txt;touch ${marker}`);

    expect(() => execFileSync('test', ['-e', marker])).toThrow();
  });

  // Skipped on Windows: chmod not available — genuinely POSIX-only.
  it.skipIf(process.platform === 'win32')('renders mode-only changes that have no text patch headers', async () => {
    // chmod is a POSIX-only operation — Windows does not track executable bits.
    const cwd = repo();
    chmodSync(join(cwd, 'file.txt'), 0o755);
    const { ctx, output } = context(cwd);

    await diffCmd.handler(ctx, '');

    expect(output.join('\n')).toContain('old mode 100644');
    expect(output.join('\n')).toContain('new mode 100755');
    expect(output.join('\n')).not.toContain('No changes');
  });

  it('sanitizes terminal escapes from changed lines', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'file.txt'), 'safe\x1b]52;c;clipboard\x07text\n');
    const { ctx, output } = context(cwd);

    await diffCmd.handler(ctx, '');

    const rendered = output.join('\n');
    expect(rendered).toContain('safetext');
    expect(rendered).not.toContain('\x1b');
    expect(rendered).not.toContain('clipboard');
  });

  it('honors AFK_DIFF_LINES=0 and counts context in a truncated remainder', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'file.txt'), 'ONE\ntwo\nthree\n');
    process.env['AFK_DIFF_LINES'] = '1';
    const limited = context(cwd);
    await diffCmd.handler(limited.ctx, '');
    expect(limited.output.join('\n')).toMatch(/… 3 more diff lines/);

    process.env['AFK_DIFF_LINES'] = '0';
    const unlimited = context(cwd);
    await diffCmd.handler(unlimited.ctx, '');
    expect(unlimited.output.join('\n')).not.toContain('more diff lines');
    expect(unlimited.output.join('\n')).toContain('three');
  });
});
