import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveShell } from '../src/utils/resolve-shell.js';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8').replace(/\r\n/g, '\n');

describe('advisory onboarding observation workflow', () => {
  it('pins every action to a full SHA with a version comment', () => {
    const workflow = read('.github/workflows/onboarding-observe.yml');
    const actions = [...workflow.matchAll(/^\s+(?:- )?uses:\s*(.+)$/gm)];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action[1]).toMatch(/^[\w/-]+@[a-f0-9]{40} # v\d[^\n]*$/);
  });

  it('uses no secrets and grants only contents read permission', () => {
    const workflow = read('.github/workflows/onboarding-observe.yml');
    expect(workflow).not.toMatch(/secrets\s*[.\[]/i);
    expect(workflow).toMatch(/^permissions:\n  contents: read\n/m);
    expect(workflow.match(/permissions:/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/:\s*write\b|write-all|pull_request_target/);
  });

  it('stays independent of the required CI gate', () => {
    expect(read('.github/workflows/ci.yml')).not.toMatch(/onboarding-observe|scripts\/onboarding/);
  });

  it('keeps the ledger complete and its statuses honest', () => {
    const ledger = read('docs/onboarding-friction.md');
    const counts: Record<string, number> = { A: 7, B: 4, C: 5, D: 18, E: 16, F: 14, G: 3, H: 5, I: 7, J: 12 };
    const ids = [...ledger.matchAll(/^\| ([A-J]\d+) \|/gm)].map(match => match[1]);
    const expected = Object.entries(counts).flatMap(([stage, count]) =>
      Array.from({ length: count }, (_, index) => `${stage}${index + 1}`));
    expect(ids).toEqual(expected);
    expect(ledger).toContain('Nothing here has been observed on a real clean machine yet.');
    expect(ledger).toMatch(/\| D5 \|[^\n]+\| unresolved \|/);
    expect(ledger).toMatch(/\| A7 \|[^\n]+\| blind spot \|/);
  });

  it('does not change execution policy or request credentials', () => {
    const driver = read('scripts/onboarding/observe.mjs');
    const windows = read('scripts/onboarding/observe-windows.ps1');
    expect(driver + windows).not.toMatch(/Set-ExecutionPolicy|ExecutionPolicy Bypass|afk(?:\.cmd)? login|afk(?:\.cmd)? chat/);
    expect(driver).toContain('child.stdin.end()');
    expect(driver).toContain('900000');
    expect(windows).toContain('$info.EnvironmentVariables.Clear()');
    expect(driver).toContain('if (infrastructureError) process.exitCode = 1');
  });

  it('covers both platforms and supported and unsupported Node majors', () => {
    const workflow = read('.github/workflows/onboarding-observe.yml');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('scripts/onboarding/**');
    expect(workflow).toContain('node: [20, 22, 24, 26]');
    expect(workflow).toContain('os: [windows-2022, macos-15]');
    expect(workflow).toContain('if-no-files-found: error');
    expect(workflow).toContain('GITHUB_STEP_SUMMARY');
  });
});

// Invariant: observe.mjs is a top-level script that takes argv[2]=logPath and
// argv[3]=shellBinary. These tests exercise runtime behaviour (spawn, log
// writing, summary writing, infrastructure-error exit code) that the
// string-containment tests above cannot cover. Each test spawns observe.mjs as
// a subprocess so the actual spawn/appendFileSync/writeFileSync code paths run.
// Shell resolution uses resolveShell() so the shell string is platform-correct.
describe('observe.mjs runtime behaviour', () => {
  const observePath = fileURLToPath(new URL('../scripts/onboarding/observe.mjs', import.meta.url));
  const node = process.execPath;

  // Resolve a shell string suitable for passing to observe.mjs as argv[3].
  // resolveShell() returns { shell: true } on POSIX (use system default) and a
  // concrete binary path on Windows. 'sh' is on PATH everywhere POSIX.
  const resolved = resolveShell();
  const shellArg: string = resolved.shell === true ? 'sh' : resolved.shell;

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'observe-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a log file and summary file when each step exits cleanly', { timeout: 120_000 }, () => {
    const logPath = path.join(tmpDir, 'run', 'obs.log');
    const result = spawnSync(node, [observePath, logPath, shellArg], {
      env: { ...process.env },
      timeout: 90_000, // 30s was too tight for macOS CI runners (issue #5340)
      encoding: 'utf8',
    });
    expect(result.status, `stderr: ${result.stderr} signal: ${result.signal}`).toBe(0);
    expect(existsSync(logPath), 'log file should be created').toBe(true);
    expect(existsSync(`${logPath}.summary.md`), 'summary file should be created').toBe(true);
    const summary = readFileSync(`${logPath}.summary.md`, 'utf8');
    expect(summary).toContain('## Onboarding observation');
    expect(summary).toContain('| Step | Exit | Duration | Result |');
    // Every step row should be recorded (not 'skipped' unless keychain present)
    expect(summary).toMatch(/\| .+ \| \d+ \| /);
  });

  it('sets process exit code 1 when the shell binary does not exist (infrastructure error)', { timeout: 60_000 }, () => {
    const logPath = path.join(tmpDir, 'run', 'infra.log');
    const result = spawnSync(node, [observePath, logPath, 'nonexistent-shell-xyzzy-999'], {
      env: { ...process.env },
      timeout: 30_000,
      encoding: 'utf8',
    });
    // observe.mjs sets process.exitCode = 1 on infrastructureError
    expect(result.status).toBe(1);
    expect(existsSync(logPath), 'log file should still be created before the error').toBe(true);
    const logContent = readFileSync(logPath, 'utf8');
    expect(logContent).toContain('Onboarding observation');
    expect(logContent).toMatch(/spawn error|ENOENT/i);
  });

});
