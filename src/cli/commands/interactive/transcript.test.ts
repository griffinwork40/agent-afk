/**
 * Regression tests for S2 (transcript file permissions 0o600) and for the
 * immediate user-message write (appendUser opens a turn at submission time;
 * appendTurn closes it without duplicating the user block).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Helper: mask off sticky/setuid/setgid bits to get rwxrwxrwx.
function permBits(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe('transcript — S2 file mode 0o600 regression', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('startTranscript creates file with mode 0o600', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-transcript-test-'));
    const { startTranscript } = await import('./transcript.js');
    const filePath = await startTranscript(tmpDir, 'claude-3-5-haiku-20241022');
    expect(permBits(filePath)).toBe(0o600);
  });

  it('initTranscript appendTurn writes to a file with mode 0o600', async () => {
    // Override AFK_STATE_DIR so transcript lands in our temp directory.
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-transcript-test-'));
    const savedEnv = process.env['AFK_STATE_DIR'];
    process.env['AFK_STATE_DIR'] = tmpDir;
    try {
      const { initTranscript } = await import('./transcript.js');
      const handle = await initTranscript(() => 'claude-3-5-haiku-20241022');
      await handle.appendTurn('hello', 'world');
      expect(permBits(handle.path())).toBe(0o600);
    } finally {
      if (savedEnv === undefined) {
        delete process.env['AFK_STATE_DIR'];
      } else {
        process.env['AFK_STATE_DIR'] = savedEnv;
      }
    }
  });
});

describe('transcript — immediate user-message write (appendUser)', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  async function makeHandle() {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-transcript-test-'));
    savedEnv = process.env['AFK_STATE_DIR'];
    process.env['AFK_STATE_DIR'] = tmpDir;
    const { initTranscript } = await import('./transcript.js');
    return initTranscript(() => 'test-model');
  }

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['AFK_STATE_DIR'];
    else process.env['AFK_STATE_DIR'] = savedEnv;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  const count = (body: string, needle: string) => body.split(needle).length - 1;

  it('appendUser persists the user block before any assistant text exists', async () => {
    const handle = await makeHandle();
    await handle.appendUser('hello from the user');
    const body = readFileSync(handle.path(), 'utf8');
    expect(body).toContain('## User\n\nhello from the user');
    expect(body).not.toContain('## Assistant');
  });

  it('appendTurn closes the open turn without duplicating the user block', async () => {
    const handle = await makeHandle();
    await handle.appendUser('the question');
    await handle.appendTurn('the question', 'the answer');
    const body = readFileSync(handle.path(), 'utf8');
    expect(count(body, 'the question')).toBe(1);
    expect(count(body, '## User')).toBe(1);
    expect(count(body, '## Assistant')).toBe(1);
    expect(body).toContain('## Assistant\n\nthe answer');
    // Turn is closed: a separator follows the assistant block.
    expect(body.trimEnd().endsWith('---')).toBe(true);
  });

  it('appendTurn with empty assistant text closes the open turn with a placeholder', async () => {
    const handle = await makeHandle();
    await handle.appendUser('tool-only turn');
    await handle.appendTurn('tool-only turn', '');
    const body = readFileSync(handle.path(), 'utf8');
    expect(body).toContain('_(no text response)_');
    expect(count(body, '## User')).toBe(1);
  });

  it('appendTurn without a matching open turn writes the legacy self-contained pair', async () => {
    const handle = await makeHandle();
    // Skill-dispatch path / late background completion: no appendUser first.
    await handle.appendTurn('/review --post', 'looks good');
    const body = readFileSync(handle.path(), 'utf8');
    expect(body).toContain('## User\n\n/review --post');
    expect(body).toContain('## Assistant\n\nlooks good');
  });

  it('appendTurn without a matching open turn no-ops on empty assistant text (legacy guard)', async () => {
    const handle = await makeHandle();
    const before = readFileSync(handle.path(), 'utf8');
    await handle.appendTurn('ignored', '');
    const body = readFileSync(handle.path(), 'utf8');
    expect(body).toBe(before);
  });

  it('a second appendUser self-heals a dangling turn (soft-stop / crash path)', async () => {
    const handle = await makeHandle();
    await handle.appendUser('first message — turn never completed');
    await handle.appendUser('second message');
    const body = readFileSync(handle.path(), 'utf8');
    expect(body).toContain('_(no response recorded)_');
    expect(count(body, '## User')).toBe(2);
    // Headings stay paired: the dangling turn was closed before the new one.
    expect(body.indexOf('_(no response recorded)_')).toBeLessThan(body.indexOf('second message'));
  });

  it('a backgrounded turn completing after a newer turn writes a self-contained pair', async () => {
    const handle = await makeHandle();
    await handle.appendUser('slow background task');   // turn A
    await handle.appendUser('quick question');          // turn B (A self-healed)
    await handle.appendTurn('quick question', 'quick answer');     // closes B
    await handle.appendTurn('slow background task', 'late result'); // A completes late
    const body = readFileSync(handle.path(), 'utf8');
    // A's late completion is fully attributed, not orphaned under B.
    expect(body).toContain('## User\n\nslow background task\n\n## Assistant\n\nlate result');
    expect(count(body, '## Assistant')).toBe(3); // healed A + B + late A
  });

  it('appendEnded closes a dangling turn before the ended marker', async () => {
    const handle = await makeHandle();
    await handle.appendUser('interrupted by shutdown');
    await handle.appendEnded();
    const body = readFileSync(handle.path(), 'utf8');
    expect(body).toContain('_(no response recorded)_');
    expect(body.indexOf('_(no response recorded)_')).toBeLessThan(body.indexOf('_ended:'));
  });
});
