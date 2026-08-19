import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import type { SessionStats, SlashContext } from '../types.js';
import { diffCmd } from './diff.js';

const dirs: string[] = [];

afterEach(() => {
  delete process.env['AFK_DIFF_LINES'];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

describe('/diff', () => {
  it('passes a pathspec as data instead of shell syntax', async () => {
    const cwd = repo();
    const marker = join(cwd, 'injected');
    writeFileSync(join(cwd, 'file.txt'), 'changed\n');
    const { ctx } = context(cwd);

    await diffCmd.handler(ctx, `file.txt;touch ${marker}`);

    expect(() => execFileSync('test', ['-e', marker])).toThrow();
  });

  it('renders mode-only changes that have no text patch headers', async () => {
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
