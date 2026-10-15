import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveNpmCli } from './update.js';

// Exercise npm's lifecycle boundary with a local, dependency-free fixture.
// No global installation, network registry access, or real service operation.
describe('update npm lifecycle suppression', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('ignore-scripts=%s controls postinstall even for an old package', (ignoreScripts) => {
    const npmCli = resolveNpmCli();
    expect(npmCli, 'npm must belong to the running Node installation').toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'afk-update-lifecycle-'));
    roots.push(root);
    const fixture = join(root, 'fixture');
    const prefix = join(root, 'prefix');
    const marker = join(root, 'postinstall-ran');
    mkdirSync(fixture);
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      name: 'agent-afk', version: '1.0.0', scripts: { postinstall: 'node postinstall.cjs' },
    }));
    writeFileSync(join(fixture, 'postinstall.cjs'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'no real services');`);
    const args = [npmCli!, 'install', '-g', '--prefix', prefix, '--offline', '--no-audit', '--no-fund',
      '--allow-scripts=agent-afk'];
    if (ignoreScripts) args.push('--ignore-scripts');
    args.push(fixture);
    execFileSync(process.execPath, args, { timeout: 20000, stdio: 'pipe' });
    expect(existsSync(marker)).toBe(!ignoreScripts);
  }, 30000);
});
