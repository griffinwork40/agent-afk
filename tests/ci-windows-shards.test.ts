import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveShell } from '../src/utils/resolve-shell.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');

// Like check-audits-drift.test.ts, inspect job blocks without a YAML dependency.
function job(id: string): string {
  const block = workflow.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|$(?![\\s\\S]))`, 'm'))?.[1];
  expect(block, `Missing CI job ${id}`).toBeDefined();
  return block!;
}

function bashCommand(): string {
  const shell = resolveShell();
  if (shell.shell === true) return 'bash';
  if (typeof shell.shell === 'string' && /(?:^|[/\\])bash(?:\.exe)?$/i.test(shell.shell)) return shell.shell;
  // Windows runners ship Git Bash even when the default shell is PowerShell.
  const gitExec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (const relative of ['../../bin/bash.exe', '../../../bin/bash.exe']) {
    const candidate = resolve(gitExec, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('CI gate tests require Bash (Git Bash on Windows)');
}

describe('Windows CI sharding contract', () => {
  it('runs exactly two full-suite Windows shards without weakening failures', () => {
    const shards = job('test-windows-shards');
    expect(shards).toContain('name: Test (windows-2022, shard ${{ matrix.shard }}/2)');
    expect(shards).toContain('runs-on: windows-2022');
    expect(shards).toContain('timeout-minutes: 30');
    expect(shards).toContain('fail-fast: false');
    expect(shards).toMatch(/^        shard: \[1, 2\]$/m);
    expect(shards).toMatch(/^        run: pnpm test --shard=\$\{\{ matrix.shard \}\}\/2$/m);
    expect(shards).toContain('node-version: 22');
    expect(shards).toContain('run: pnpm install --frozen-lockfile');
    expect(shards).not.toMatch(/^\s+(?:if|continue-on-error|needs):/m);
    const actions = [...shards.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
    const coverageActions = [...job('test').matchAll(/uses: (\S+)/g)].map((match) => match[1]);
    expect(actions).toHaveLength(3);
    expect(actions).toEqual(coverageActions.slice(0, 3));
    for (const action of actions) expect(action).toMatch(/@[a-f0-9]{40}$/);
  });

  it('preserves the stable Windows check and runs its gate even after skipped/failed shards', () => {
    const gate = job('test-windows');
    expect(gate).toContain('name: Test (windows-2022)');
    expect(workflow.match(/^    name: Test \(windows-2022\)$/gm)).toHaveLength(1);
    expect(gate).toContain('needs: test-windows-shards');
    expect(gate).toContain('if: ${{ always() }}');
    expect(gate).toContain('SHARD_RESULT: ${{ needs.test-windows-shards.result }}');
    expect(gate).toContain('shell: bash');
    expect(gate).not.toContain('continue-on-error:');
  });

  it.each(['success', 'failure', 'cancelled', 'skipped', '', 'unexpected'])(
    'executes the actual aggregate script fail-closed for result %j', (result) => {
      const script = job('test-windows').match(/        run: \|\n((?:          .*\n|\n)+)/)?.[1];
      expect(script).toBeDefined();
      const execution = spawnSync(bashCommand(), ['-c', `SHARD_RESULT='${result}'\n${script}`], { encoding: 'utf8' });
      expect(execution.error).toBeUndefined();
      expect(execution.status).toBe(result === 'success' ? 0 : 1);
    },
  );

  it('keeps both coverage platforms, commands, artifact names and floors', () => {
    const coverage = job('test');
    expect(coverage).toContain('name: Test (${{ matrix.os }})');
    expect(coverage).toContain('os: [ubuntu-latest, macos-latest]');
    expect(coverage).not.toMatch(/^\s+include:/m);
    expect(coverage).toContain('test-cmd: [pnpm test:coverage]');
    expect(coverage).toContain('run: ${{ matrix.test-cmd }}');
    expect(coverage).toContain('name: coverage-report-${{ matrix.os }}');
    expect(coverage).toContain('retention-days: 14');
    expect(coverage).toContain('node-version: 22');
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8');
    for (const floor of ['statements: 84', 'branches: 78', 'functions: 84', 'lines: 86']) expect(config).toContain(floor);
    expect(config).toContain("pool: 'forks'");
    expect(config).not.toContain('isolate: false');
  });

  it('retains independent compatibility, PTY, smoke, build, docs and dashboard checks', () => {
    for (const version of [24, 26]) {
      const compatibility = job(`test-node${version}`);
      expect(compatibility).toContain(`name: Test (ubuntu-latest, Node ${version})`);
      expect(compatibility).toContain(`node-version: ${version}`);
      expect(compatibility).toMatch(/^        run: pnpm test$/m);
    }
    const checks = {
      'smoke-windows': 'Smoke test (Windows CLI)',
      'test-pty': 'Test (real PTY scrollback)',
      'lint-build': 'Lint & Build',
      docs: 'Docs Site (typecheck + build)',
      'test-dashboard': 'Test (dashboard)',
      'publish-bundle': 'Publish Bundle Smoke',
    };
    for (const [id, name] of Object.entries(checks)) {
      expect(job(id)).toContain(`name: ${name}`);
      expect(job(id)).not.toMatch(/^    (?:needs|continue-on-error):/m);
    }
    expect(job('smoke-windows')).toContain('runs-on: windows-2022');
    expect(job('test-pty')).toContain('run: pnpm test:pty');
  });
});
