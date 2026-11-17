import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Keep fixtures beside the real scripts so the subprocess resolves tsx locally,
// but give each one an isolated source tree and baseline.
const root = path.resolve(import.meta.dirname, '..');
const fixtureRoot = mkdtempSync(path.join(root, '.audit-console-test-'));
const rel = 'src/cli/commands/interactive/fixture.ts';

function runGate(source: string, baselineCount = 0) {
  const fixture = mkdtempSync(path.join(fixtureRoot, 'case-'));
  mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
  for (const script of ['audit-console.ts', 'audit-console-stderr-tags.ts']) {
    copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
  }
  writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(fixture, rel), source);
  writeFileSync(path.join(fixture, '.console-baseline.json'), JSON.stringify({
    entries: baselineCount ? { [rel]: { count: baselineCount, reason: 'fixture' } } : {},
  }));
  return spawnSync(process.execPath, [
    '--import', 'tsx/esm', path.join(fixture, 'scripts/audit-console.ts'), '--check',
  ], { encoding: 'utf8', cwd: root });
}

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe('audit-console gate regressions', () => {
  it('counts raw console independently of a grandfathered tagged stderr on the same line', () => {
    const result = runGate("process.stderr.write('[tag] warning'); console.warn('raw');", 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('1 → 2 (+1)');
  });

  it.each([
    "process.stderr.write( // diagnostic\n  '[afk] warning\\n',\n);",
    "process.stderr.write( /* diagnostic */\n\n // note\n /* more\n  detail */\n '[afk] warning\\n',\n);",
  ])('rejects tagged stderr after comments and blank lines: %s', (source) => {
    const result = runGate(source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('process.stderr.write [tag]');
    expect(result.stderr).toContain('(1 call(s))');
  });

  it('preserves standalone raw-console detection', () => {
    const result = runGate("console.warn('raw');");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('console.warn');
    expect(result.stderr).toContain('(1 call(s))');
  });
});
