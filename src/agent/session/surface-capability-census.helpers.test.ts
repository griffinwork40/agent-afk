import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SurfaceRuntime } from './__test-utils__/surface-census-runtime.js';
import { productionSites } from './__test-utils__/surface-census-sites.js';

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'afk-surface-census-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('surface census detector contracts', () => {
  it('observes options assembled in a helper and spread, including their later removal/addition', () => {
    const root = fixture({
      'surface.ts': `import { wireExecutors } from './agent/session/wire-executors.js';
        import { options } from './options.js';
        export function build(enabled: boolean) { wireExecutors({ ...options(enabled) }); }`,
      'options.ts': `export function options(enabled: boolean) {
        const base = { cwd: 'project' }; return enabled ? { ...base, traceWriter: 'writer' } : base;
      }`,
    });
    const rt = new SurfaceRuntime(root, ['surface.ts', 'options.ts']);
    rt.load('surface.ts')['build'](true);
    rt.load('surface.ts')['build'](false);
    expect(rt.calls('wireExecutors').map((o) => o.args[0])).toEqual([
      { cwd: 'project', traceWriter: 'writer' }, { cwd: 'project' },
    ]);
  });

  it('fails closed when options move into an unreviewed helper, even with a familiar export name', () => {
    const root = fixture({
      'surface.ts': `import { loadConfig } from './new-options.js'; export function build() { return loadConfig(); }`,
      'new-options.ts': 'export function loadConfig() { return { cwd: "project" }; }',
    });
    expect(() => new SurfaceRuntime(root, ['surface.ts']).load('surface.ts'))
      .toThrow('Unreviewed census import new-options.ts');
  });

  it('discovers new production bootstraps, aliases and namespace calls, ignoring comments/tests', () => {
    const root = fixture({
      'new.ts': `import { AgentSession as S } from './session.js'; const Alias = S;
        new Alias({}); import * as wiring from './wiring.js'; wiring.wireExecutors({});`,
      'dynamic.ts': `async function run() { const { AgentSession: S } = await import('./session.js'); new S({}); }`,
      'comment.ts': '// new AgentSession({}); wireExecutors({})',
      'ignored.test.ts': 'new AgentSession({});',
    });
    expect(productionSites(root)).toEqual([
      'dynamic.ts:AgentSession', 'new.ts:AgentSession', 'new.ts:wireExecutors',
    ]);
  });
});
