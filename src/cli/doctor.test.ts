import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { registerDoctorCommand } from './commands/doctor.js';

// Mock the keychain fallback so a real Claude Code-credentials entry on the
// dev machine doesn't satisfy the missing-API-key checks this suite asserts.
// Two mock paths needed: the re-export shim and the canonical source that
// credential-resolver.ts imports directly.
vi.mock('./keychain.js', () => ({
  loadClaudeCodeOauthToken: () => undefined,
}));
vi.mock('../agent/auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: () => undefined,
  refreshClaudeCodeOauthToken: () => Promise.resolve(undefined),
  parseAccountIdentifier: () => undefined,
}));

// Mock child_process so checkNpmBinOnPath doesn't invoke a real npm subprocess.
// Specifier must match the import in doctor.ts exactly ('child_process').
// Use importOriginal to preserve other exports (execFile, etc.) used by skills.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(() => '/usr/local\n'),
  };
});
import { execSync } from 'child_process';

describe('afk doctor', () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    registerDoctorCommand(program);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
    vi.stubEnv('OPENAI_API_KEY', undefined);
    vi.stubEnv('CODEX_API_KEY', undefined);
    vi.stubEnv('AFK_TELEGRAM_BOT_TOKEN', undefined);
    // Deterministic PATH for the npm-bin check: /usr/local/bin is NOT on this path,
    // so checkNpmBinOnPath() returns 'fail' in most tests.
    vi.stubEnv('PATH', '/usr/bin:/bin');
    // Reset the execSync mock to return a deterministic prefix.
    vi.mocked(execSync).mockReturnValue('/usr/local\n' as unknown as ReturnType<typeof execSync>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('should run text mode without throwing when env is empty', async () => {
    await expect(program.parseAsync(['node', 'afk', 'doctor'])).resolves.not.toThrow();
    expect(exitSpy).toHaveBeenCalled();
  });

  it('should print output containing "API" in text mode', async () => {
    await program.parseAsync(['node', 'afk', 'doctor']);
    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(output.toLowerCase()).toMatch(/api/);
  });

  it('should produce valid JSON with --format json', async () => {
    let jsonOutput: string = '';
    const captureLog = vi.fn((msg: string) => {
      jsonOutput = msg;
    });
    logSpy.mockImplementation(captureLog);

    await program.parseAsync(['node', 'afk', 'doctor', '--format', 'json']);

    const parsed = JSON.parse(jsonOutput);
    expect(parsed).toHaveProperty('checks');
    expect(parsed).toHaveProperty('summary');
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.summary).toHaveProperty('passed');
    expect(parsed.summary).toHaveProperty('warned');
    expect(parsed.summary).toHaveProperty('failed');
  });

  it('should have checks with name, state, and optional fix', async () => {
    let jsonOutput: string = '';
    const captureLog = vi.fn((msg: string) => {
      jsonOutput = msg;
    });
    logSpy.mockImplementation(captureLog);

    await program.parseAsync(['node', 'afk', 'doctor', '--format', 'json']);

    const parsed = JSON.parse(jsonOutput);
    expect(parsed.checks.length).toBeGreaterThan(0);
    parsed.checks.forEach((check: Record<string, unknown>) => {
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('state');
      expect(['pass', 'warn', 'fail']).toContain(check.state);
      if (check.state === 'fail') {
        expect(check).toHaveProperty('fix');
      }
    });
  });

  it('should have at least one fail when API keys missing', async () => {
    let jsonOutput: string = '';
    const captureLog = vi.fn((msg: string) => {
      jsonOutput = msg;
    });
    logSpy.mockImplementation(captureLog);

    await program.parseAsync(['node', 'afk', 'doctor', '--format', 'json']);

    const parsed = JSON.parse(jsonOutput);
    const hasFail = parsed.checks.some((check: Record<string, unknown>) => check.state === 'fail');
    expect(hasFail).toBe(true);
  });

  it('should exit with code 1 when at least one check fails', async () => {
    await program.parseAsync(['node', 'afk', 'doctor']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should exit with code 0 when all checks pass or warn', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-12345');
    // Make the npm bin check pass by putting /usr/local/bin on PATH.
    vi.stubEnv('PATH', '/usr/local/bin:/usr/bin:/bin');
    vi.mocked(execSync).mockReturnValue('/usr/local\n' as unknown as ReturnType<typeof execSync>);
    exitSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await program.parseAsync(['node', 'afk', 'doctor']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should include fix hint for missing anthropic key', async () => {
    let jsonOutput: string = '';
    const captureLog = vi.fn((msg: string) => {
      jsonOutput = msg;
    });
    logSpy.mockImplementation(captureLog);

    await program.parseAsync(['node', 'afk', 'doctor', '--format', 'json']);

    const parsed = JSON.parse(jsonOutput);
    const anthropicCheck = parsed.checks.find(
      (check: Record<string, unknown>) => (check.name as string).toLowerCase().includes('anthropic'),
    );
    expect(anthropicCheck).toBeDefined();
    expect(anthropicCheck.state).toBe('fail');
    expect(anthropicCheck.fix).toBeTruthy();
    expect((anthropicCheck.fix as string).toLowerCase()).toMatch(/(api_key|login)/);
  });

  it('should warn (not fail) when codex key missing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-12345');
    let jsonOutput: string = '';
    const captureLog = vi.fn((msg: string) => {
      jsonOutput = msg;
    });
    logSpy.mockImplementation(captureLog);

    await program.parseAsync(['node', 'afk', 'doctor', '--format', 'json']);

    const parsed = JSON.parse(jsonOutput);
    const codexCheck = parsed.checks.find(
      (check: Record<string, unknown>) => (check.name as string).toLowerCase().includes('codex'),
    );
    expect(codexCheck).toBeDefined();
    expect(codexCheck.state).toBe('warn');
  });

  it('should respect -f shorthand for --format', async () => {
    let jsonOutput: string = '';
    const captureLog = vi.fn((msg: string) => {
      jsonOutput = msg;
    });
    logSpy.mockImplementation(captureLog);

    await program.parseAsync(['node', 'afk', 'doctor', '-f', 'json']);

    const parsed = JSON.parse(jsonOutput);
    expect(parsed).toHaveProperty('checks');
  });

  // ─── checkNpmBinOnPath tests ────────────────────────────────────────────────

  it('checkNpmBinOnPath: returns pass when npm bin is on PATH', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-12345');
    vi.stubEnv('PATH', '/usr/local/bin:/usr/bin:/bin');
    vi.mocked(execSync).mockReturnValue('/usr/local\n' as unknown as ReturnType<typeof execSync>);

    let jsonOutput: string = '';
    logSpy.mockImplementation((msg: string) => { jsonOutput = msg; });

    await program.parseAsync(['node', 'afk', 'doctor', '--format', 'json']);

    const parsed = JSON.parse(jsonOutput);
    const npmCheck = parsed.checks.find(
      (c: Record<string, unknown>) => (c.name as string) === 'npm bin on PATH',
    );
    expect(npmCheck).toBeDefined();
    expect(npmCheck.state).toBe('pass');
    expect(npmCheck.detail).toBe('/usr/local/bin');
  });

  it('checkNpmBinOnPath: returns fail when npm bin is NOT on PATH', async () => {
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.mocked(execSync).mockReturnValue('/usr/local\n' as unknown as ReturnType<typeof execSync>);

    let jsonOutput: string = '';
    logSpy.mockImplementation((msg: string) => { jsonOutput = msg; });

    await program.parseAsync(['node', 'afk', 'doctor', '--format', 'json']);

    const parsed = JSON.parse(jsonOutput);
    const npmCheck = parsed.checks.find(
      (c: Record<string, unknown>) => (c.name as string) === 'npm bin on PATH',
    );
    expect(npmCheck).toBeDefined();
    expect(npmCheck.state).toBe('fail');
    expect(npmCheck.detail).toBe('/usr/local/bin');
    expect(npmCheck.fix).toMatch(/usr\/local\/bin/);
  });

  it('checkNpmBinOnPath: returns warn when execSync throws', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('npm not found'); });

    let jsonOutput: string = '';
    logSpy.mockImplementation((msg: string) => { jsonOutput = msg; });

    await program.parseAsync(['node', 'afk', 'doctor', '--format', 'json']);

    const parsed = JSON.parse(jsonOutput);
    const npmCheck = parsed.checks.find(
      (c: Record<string, unknown>) => (c.name as string) === 'npm bin on PATH',
    );
    expect(npmCheck).toBeDefined();
    expect(npmCheck.state).toBe('warn');
    expect(npmCheck.detail).toMatch(/could not query/);
  });
});
