/**
 * Characterization tests for the interactive-session transcript autosave.
 *
 * These pin the behavior of `startTranscript` — the module-level helper
 * that writes `<isoStamp>.md` into whatever directory it is given (the
 * caller `initTranscript` resolves that dir to `getTranscriptsDir()`, i.e.
 * `${AFK_STATE_DIR ?? $AFK_HOME/state}/transcripts/`) — plus a smoke test
 * for rotation (consecutive calls produce distinct files) so the
 * `/clear`-rotates-the-transcript flow is covered at the helper level.
 *
 * RED phase: commit 3.1 ships a `throw Error('not implemented')` stub, so
 * these tests fail at runtime. Commit 3.2 replaces the stub with the real
 * implementation and the suite goes green — the classic TDD red→green
 * pair the plan's Wave 3 is built around.
 *
 * Pattern (tmpdir + realpathSync + env override) mirrors
 * `tests/plugins-scanner.test.ts` so HOME-aware logic under test sees an
 * isolated filesystem per case.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTranscript } from './commands/interactive/transcript.js';

describe('transcript autosave — startTranscript', () => {
  let home: string;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'afk-transcript-')));
    originalHome = process.env['HOME'];
    originalStateDir = process.env['AFK_STATE_DIR'];
    process.env['HOME'] = home;
    process.env['AFK_STATE_DIR'] = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (originalStateDir === undefined) delete process.env['AFK_STATE_DIR'];
    else process.env['AFK_STATE_DIR'] = originalStateDir;
    rmSync(home, { recursive: true, force: true });
  });

  it('creates a file at <dir>/<ISO-timestamp>.md and writes the markdown header with model', async () => {
    const transcriptDir = join(home, 'transcripts');
    const p = await startTranscript(transcriptDir, 'claude-sonnet-4-5');

    expect(p.startsWith(transcriptDir + '/')).toBe(true);
    expect(p).toMatch(/\.md$/);
    const basename = p.slice(transcriptDir.length + 1);
    // ISO timestamp with `:` and `.` replaced by `-` so ls sorts correctly.
    expect(basename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.md$/);

    const body = await fs.readFile(p, 'utf8');
    expect(body).toContain('# Session — ');
    expect(body).toContain('- model: claude-sonnet-4-5');
    expect(body).toContain('---');
  });

  it('adds "(continued)" to the header when continued=true (the /clear rotation case)', async () => {
    const transcriptDir = join(home, 'transcripts');
    const p = await startTranscript(transcriptDir, 'sonnet', true);
    const body = await fs.readFile(p, 'utf8');
    expect(body).toContain('(continued)');
  });

  it('omits "(continued)" from the header by default', async () => {
    const transcriptDir = join(home, 'transcripts');
    const p = await startTranscript(transcriptDir, 'sonnet');
    const body = await fs.readFile(p, 'utf8');
    expect(body).not.toContain('(continued)');
  });

  it('creates the transcript directory if it does not exist (mkdir -p)', async () => {
    const nested = join(home, 'transcripts', 'nested', 'deep');
    const p = await startTranscript(nested, 'sonnet');
    expect(p.startsWith(nested + '/')).toBe(true);
    // The file exists and is readable.
    const body = await fs.readFile(p, 'utf8');
    expect(body.length).toBeGreaterThan(0);
  });

  it('consecutive startTranscript calls produce distinct files (the /clear rotation writes a new file)', async () => {
    const transcriptDir = join(home, 'transcripts');
    const p1 = await startTranscript(transcriptDir, 'sonnet');
    // Small delay so the millisecond stamp differs. 2ms is plenty; node
    // timers resolve at ~1ms granularity.
    await new Promise((r) => setTimeout(r, 2));
    const p2 = await startTranscript(transcriptDir, 'sonnet', true);

    expect(p1).not.toBe(p2);
    const entries = await fs.readdir(transcriptDir);
    expect(entries.length).toBe(2);
  });

  it('supports the per-turn append pattern (User/Assistant blocks)', async () => {
    const transcriptDir = join(home, 'transcripts');
    const p = await startTranscript(transcriptDir, 'sonnet');
    await fs.appendFile(p, `## User\n\nHello\n\n## Assistant\n\nHi there\n\n---\n\n`);
    const body = await fs.readFile(p, 'utf8');
    expect(body).toContain('## User');
    expect(body).toContain('Hello');
    expect(body).toContain('## Assistant');
    expect(body).toContain('Hi there');
  });
});
