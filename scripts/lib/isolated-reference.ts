#!/usr/bin/env tsx
/** Registry imports run in a child with no access to operator or project assets.
 * audit:env:check scans src/ only, not this scripts/ wrapper.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './docs-reference.js';
import { ENV_REGISTRY } from '../../src/config/env.js';

/** Neutralize registered config and future AFK overrides, retaining OS plumbing. */
export function registryEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const configKeys = new Set<string>(ENV_REGISTRY.filter((entry) => entry.category !== 'process').map((entry) => entry.name));
  return Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith('AFK_') && !configKeys.has(key)));
}

const targets: Record<string, string> = {
  cli: 'render-cli-reference.ts', slash: 'render-slash-commands.ts', config: 'render-config-keys.ts',
};
const target = targets[process.argv[2] ?? ''];
if (!target) throw new Error('Expected cli, slash, or config');
const temp = mkdtempSync(join(tmpdir(), 'afk-reference-'));
const cwd = join(temp, 'cwd');
mkdirSync(cwd);
try {
  // External constraint: environment isolation must precede module evaluation.
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(repoRoot, 'scripts', target), ...process.argv.slice(3)], {
    cwd,
    env: {
      ...registryEnvironment(process.env), HOME: temp, USERPROFILE: temp,
      AFK_HOME: join(temp, 'afk'), AFK_STATE_DIR: join(temp, 'state'),
      AFK_FRAMEWORK_DIR: join(temp, 'framework'), CODEX_HOME: join(temp, 'codex'),
      AFK_INTERNAL: '0', AFK_DEBUG: '0',
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  // Registrars must be metadata-only: neither imports nor registration may write.
  const unexpected = readdirSync(temp).filter((entry) => entry !== 'cwd');
  if (unexpected.length || readdirSync(cwd).length) {
    throw new Error(`Registry import/registration wrote isolated state: ${unexpected.join(', ')}`);
  }
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
