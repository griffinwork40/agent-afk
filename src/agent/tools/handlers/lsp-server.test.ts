import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveServer, resolveServerWith } from '../../lsp/registry.js';
import { ensureServerInstalled } from '../../lsp/install.js';
import { resolveLspServer } from './lsp-server.js';
import type { EnsureInstalledResult } from '../../lsp/server-spec.js';

vi.mock('../../lsp/registry.js', async (original) => ({
  ...await original<typeof import('../../lsp/registry.js')>(), resolveServer: vi.fn(),
}));
vi.mock('../../lsp/install.js', () => ({ ensureServerInstalled: vi.fn() }));

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'afk-lsp-wiring-'));
  vi.mocked(resolveServer).mockImplementation(resolveServerWith({
    fsStat: p => p.startsWith(root + path.sep) && existsSync(p), pathLookup: () => undefined,
  }));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.resetAllMocks(); });

function file(relative: string): string {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, '');
  return target;
}

describe('shared LSP registry wiring', () => {
  it.each([
    ['a.ts', 'typescript'], ['a.tsx', 'typescriptreact'], ['a.mts', 'typescript'],
    ['a.cts', 'typescript'], ['a.js', 'javascript'], ['a.jsx', 'javascriptreact'],
    ['a.mjs', 'javascript'], ['a.cjs', 'javascript'], ['a.py', 'python'],
    ['a.pyi', 'python'], ['a.go', 'go'], ['a.rs', 'rust'], ['a.cpp', 'cpp'],
  ])('resolves %s through its registry definition, not a TS fallback', async (name, languageId) => {
    const resolved = await resolveLspServer(file(name), { serverCmd: ['fake-server', '--stdio'] });
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') return;
    expect(resolved.spec.definition.languageIds[path.extname(name)]).toBe(languageId);
    expect(resolved.spec.source).toBe('override');
    expect(ensureServerInstalled).not.toHaveBeenCalled();
  });

  it('uses nearest marker for symbols/diagnostics and never walks above session root', async () => {
    file('package.json');
    file('session/package/package.json');
    const nested = file('session/package/src/a.ts');
    const options = { sessionRoot: path.join(root, 'session'), serverCmd: ['fake'] };
    expect(await resolveLspServer(nested, options)).toMatchObject({ root: path.join(root, 'session/package') });
    const unmarked = file('session/other/a.ts');
    expect(await resolveLspServer(unmarked, options)).toMatchObject({ root: path.join(root, 'session') });
  });

  it('does not use an unrelated session root for an extra read-root file', async () => {
    file('package.json');
    const outside = file('external/a.ts');
    expect(await resolveLspServer(outside, { sessionRoot: path.join(root, 'session'), serverCmd: ['fake'] }))
      .toMatchObject({ root: path.join(root, 'external') });
  });

  it('never installs or asks on passive missing-server resolution', async () => {
    expect(await resolveLspServer(file('a.py'), { sessionRoot: root }))
      .toMatchObject({ kind: 'unavailable', error: expect.stringContaining('pyright-langserver') });
    expect(ensureServerInstalled).not.toHaveBeenCalled();
  });

  it('returns installed command with registry args/root and full Python settings', async () => {
    vi.mocked(ensureServerInstalled).mockResolvedValue({ kind: 'installed', command: '/afk/pyright', freshInstall: true });
    const installContext = { interactive: true, askConsent: vi.fn() };
    const result = await resolveLspServer(file('a.py'), { sessionRoot: root, installContext });
    expect(result).toMatchObject({ kind: 'resolved', root, spec: {
      command: '/afk/pyright', args: ['--stdio'], source: 'afk-install',
      definition: { settings: { 'python.analysis': { diagnosticMode: 'openFilesOnly' } } },
    } });
    expect(ensureServerInstalled).toHaveBeenCalledWith(expect.objectContaining({ language: 'python' }), installContext);
  });

  it.each<EnsureInstalledResult>([
    { kind: 'declined' }, { kind: 'refused-unattended' }, { kind: 'no-recipe' }, { kind: 'failed', reason: 'npm failed' },
  ])('reports %j without spawning a fallback server', async (result) => {
    vi.mocked(ensureServerInstalled).mockResolvedValue(result);
    expect(await resolveLspServer(file('a.py'), { installContext: { interactive: false } }))
      .toMatchObject({ kind: 'unavailable', error: expect.any(String) });
  });

  it('short-circuits an aborted install before resolution', async () => {
    expect(await resolveLspServer(file('a.py'), {
      installContext: { interactive: true, signal: AbortSignal.abort() },
    })).toEqual({ kind: 'unavailable', error: 'Aborted' });
    expect(resolveServer).not.toHaveBeenCalled();
    expect(ensureServerInstalled).not.toHaveBeenCalled();
  });

  it('rejects unsupported extensions and empty command overrides', async () => {
    expect(await resolveLspServer(file('a.txt'), { serverCmd: ['fake'] })).toMatchObject({ kind: 'unavailable' });
    expect(await resolveLspServer(file('a.ts'), { serverCmd: [] })).toMatchObject({ kind: 'unavailable' });
    expect(ensureServerInstalled).not.toHaveBeenCalled();
  });
});
