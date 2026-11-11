/**
 * Tests for `afk resume` (registerResumeAllCommand).
 *
 * Mocks `fs.readFileSync` and the pause-controller helpers so no real lock
 * file is ever read or removed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before the module under test is imported.
// ---------------------------------------------------------------------------

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('../../agent/session/pause-controller.js', () => ({
  getPauseLockPath: vi.fn(() => '/fake/state/pause.lock'),
  removePauseLock: vi.fn(),
}));

// Import after mocks are in place.
import { readFileSync } from 'fs';
import { removePauseLock } from '../../agent/session/pause-controller.js';
import { registerResumeAllCommand } from './resume-all.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent process.exit in tests
  registerResumeAllCommand(program);
  return program;
}

function runResume(program: Command): void {
  program.parse(['node', 'afk', 'resume']);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerResumeAllCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.mocked(readFileSync).mockReset();
    vi.mocked(removePauseLock).mockReset();
  });

  it('registers a top-level `resume` command', () => {
    const program = makeProgram();
    const cmd = program.commands.find((c) => c.name() === 'resume');
    expect(cmd).toBeDefined();
  });

  it('calls removePauseLock', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const program = makeProgram();
    runResume(program);
    expect(removePauseLock).toHaveBeenCalledOnce();
  });

  it('outputs the resumed message', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const program = makeProgram();
    runResume(program);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('AFK resumed.');
  });

  it('shows (paused for ...) when lock file has a valid timestamp', () => {
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ pid: 1234, timestamp: past }),
    );
    const program = makeProgram();
    runResume(program);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/paused for/);
  });

  it('omits pause duration when lock file is missing', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    const program = makeProgram();
    runResume(program);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).not.toContain('paused for');
  });

  it('omits pause duration when lock file JSON has no timestamp', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ pid: 1234 }));
    const program = makeProgram();
    runResume(program);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).not.toContain('paused for');
  });
});
