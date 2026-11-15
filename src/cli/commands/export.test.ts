import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportSavedSession, registerExportCommand } from './export.js';
import { createSessionStats } from '../slash/session-stats.js';
import { saveSession } from '../session-store.js';
import { getAfkHome, getTraceDir } from '../../paths.js';
import { renderSessionExport } from '../session-export.js';
import { exportCmd } from '../slash/commands/export.js';
import type { SlashContext } from '../slash/types.js';

let root: string;
const startedAt = 1_700_000_000_000;

function fixture(id = 'saved-id') {
  const stats = createSessionStats('sonnet');
  Object.assign(stats, {
    sessionId: id, name: 'my-conversation', sessionStartTime: startedAt,
    totalTurns: 1, totalCostUsd: 0.25, totalDurationMs: 1234,
    turns: [{
      user: 'secret sk-ant-api03-supersecretkey1234', assistant: '<b>Answer</b>', timestamp: startedAt,
      toolEvents: [{ toolName: 'bash', toolUseId: 'tool-1', input: '{"command":"ls"}', result: 'files' }],
    }],
  });
  saveSession(stats);
  return stats;
}

function trace(label: string, sessionId?: string) {
  const dir = getTraceDir(label);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'trace.jsonl');
  writeFileSync(file, sessionId ? JSON.stringify({
    ts: new Date(startedAt).toISOString(), seq: 0, kind: 'session_phase',
    payload: { phase: 'session_id_assigned', sessionId },
  }) + '\n' : '');
  return file;
}

function program() {
  const cli = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerExportCommand(cli);
  return cli;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-export-'));
  vi.stubEnv('AFK_HOME', join(root, 'afk-home'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('afk export', () => {
  it('registers the required session argument and rejects missing sessions and unknown formats', async () => {
    expect(program().commands[0]?.name()).toBe('export');
    await expect(program().parseAsync(['export'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.missingArgument' });
    await expect(program().parseAsync(['export', 'id', '--format', 'pdf'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(existsSync(join(getAfkHome(), 'exports'))).toBe(false);
  });

  it('exports a named saved session without a trace using the shared Markdown renderer', async () => {
    const stats = fixture();
    const destination = await exportSavedSession('my-conversation', { format: 'md' });
    expect(destination).toBe(join(getAfkHome(), 'exports', 'saved-id.md'));
    const content = readFileSync(destination, 'utf8');
    // The renderer footer contains the current export timestamp.
    expect(content.replace(/\*Exported by AFK.*\n/, '')).toBe(renderSessionExport(stats, 'md').replace(/\*Exported by AFK.*\n/, ''));
    expect(content).toContain('bash');
    expect(content).toContain('files');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('sk-ant-api03-supersecretkey1234');
  });

  it('runs Commander with default md, prints the destination, and warns before sharing', async () => {
    fixture();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const out = join(root, 'review with spaces');
    await program().parseAsync(['export', 'saved-id', '--out', out], { from: 'user' });
    expect(readFileSync(out + '.md', 'utf8')).toContain('# AFK Session Export');
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(out + '.md'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Review before sharing'));
  });

  it('exports HTML with an explicit extension and escapes user content', async () => {
    fixture();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const out = join(root, 'review.html');
    await program().parseAsync(['export', 'saved-id', '--format', 'html', '--out', out], { from: 'user' });
    const content = readFileSync(out, 'utf8');
    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('&lt;b&gt;Answer&lt;/b&gt;');
    expect(existsSync(out + '.html')).toBe(false);
  });

  it('resolves witness labels through trace show session_id_assigned candidates', async () => {
    fixture();
    trace('witness-label', 'saved-id');
    const out = await exportSavedSession('witness-label', { format: 'md' });
    expect(out).toBe(join(getAfkHome(), 'exports', 'saved-id.md'));
  });

  it('uses the newest witness trace for latest, not the newest saved sidecar', async () => {
    fixture('chosen-id');
    fixture('other-id');
    const older = trace('older-label', 'other-id');
    const newest = trace('newest-label', 'chosen-id');
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newest, new Date(2000), new Date(2000));
    const out = await exportSavedSession('latest', { format: 'html' });
    expect(out).toBe(join(getAfkHome(), 'exports', 'chosen-id.html'));
  });

  it('resolves legacy trace labels that already equal the saved session id', async () => {
    fixture();
    trace('saved-id');
    expect(await exportSavedSession('latest', { format: 'md' })).toContain('saved-id.md');
  });

  it('fails clearly for missing traces and trace-only sessions without writing output', async () => {
    await expect(exportSavedSession('latest', { format: 'md' })).rejects.toThrow('No traces found');
    await expect(exportSavedSession('missing', { format: 'md' })).rejects.toThrow('No trace found');
    trace('trace-only');
    await expect(exportSavedSession('trace-only', { format: 'md' })).rejects.toThrow('No saved transcript found');
    expect(existsSync(join(getAfkHome(), 'exports'))).toBe(false);
  });

  it('rejects unsafe selectors and reports unwritable explicit destinations', async () => {
    await expect(exportSavedSession('../escape', { format: 'md' })).rejects.toThrow();
    fixture();
    await expect(exportSavedSession('saved-id', { format: 'md', out: join(root, 'absent', 'out') })).rejects.toThrow();
  });

  it('replaces an existing file atomically with owner-only POSIX permissions', async () => {
    fixture();
    const out = join(root, 'out.md');
    writeFileSync(out, 'old', { mode: 0o644 });
    await exportSavedSession('saved-id', { format: 'md', out });
    expect(readFileSync(out, 'utf8')).toContain('# AFK Session Export');
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('keeps slash and CLI output in parity for both formats', async () => {
    const stats = fixture();
    for (const format of ['md', 'html'] as const) {
      const slashOut = join(root, `slash.${format}`);
      const cliOut = join(root, `cli.${format}`);
      const writer = { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
      await exportCmd.handler({ stats, out: writer } as unknown as SlashContext, `${format} ${slashOut}`);
      await exportSavedSession('saved-id', { format, out: cliOut });
      expect(writer.error).not.toHaveBeenCalled();
      const normalize = (text: string) => text.replace(/Exported by AFK.*(?:\n|<)/, 'Exported by AFK');
      expect(normalize(readFileSync(slashOut, 'utf8'))).toBe(normalize(readFileSync(cliOut, 'utf8')));
    }
  });
});
