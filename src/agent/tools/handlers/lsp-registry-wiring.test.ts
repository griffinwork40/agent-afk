import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveServer, definitionForFile } from '../../lsp/registry.js';
import { ensureServerInstalled } from '../../lsp/install.js';
import { withPooledFile } from '../../lsp/query.js';
import { elicitationRouter } from '../../elicitation-router.js';
import { queryLspSymbol, handleCodeSymbols } from './lsp-symbols.js';
import { queryLspDiagnostics, appendLspDiagnostics } from './lsp-diagnostics.js';

vi.mock('../../lsp/registry.js', async original => ({
  ...await original<typeof import('../../lsp/registry.js')>(), resolveServer: vi.fn(),
}));
vi.mock('../../lsp/install.js', () => ({ ensureServerInstalled: vi.fn() }));
vi.mock('../../lsp/query.js', () => ({ withPooledFile: vi.fn(), awaitSyncDiagnostics: vi.fn() }));
vi.mock('../../elicitation-router.js', () => ({
  elicitationRouter: { hasHandler: vi.fn(), route: vi.fn() },
}));

let root: string;
let source: string;
const python = definitionForFile('a.py')!;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'afk-lsp-handler-wiring-')));
  source = path.join(root, 'main.py');
  writeFileSync(source, 'x = 1\n');
  vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
  vi.mocked(resolveServer).mockResolvedValue({ kind: 'missing', definition: python, root });
  vi.mocked(elicitationRouter.hasHandler).mockReturnValue(true);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

const input = () => ({ file_path: source, subcommand: 'definition' as const, line: 1, col: 1 });

describe('symbols and diagnostics registry integration', () => {
  it('routes a real code_symbols missing-server request through explicit human consent', async () => {
    vi.mocked(elicitationRouter.route).mockResolvedValue({ action: 'accept', content: { value: true } });
    vi.mocked(ensureServerInstalled).mockImplementation(async (_definition, ctx) => {
      expect(ctx.interactive).toBe(true);
      if (!await ctx.askConsent!('Install pyright?')) return { kind: 'declined' };
      vi.mocked(resolveServer).mockResolvedValue({ kind: 'resolved', root, spec: {
        definition: python, command: '/afk/pyright', args: ['--stdio'], source: 'afk-install',
      } });
      return { kind: 'installed', command: '/afk/pyright', freshInstall: true };
    });
    vi.mocked(withPooledFile).mockResolvedValue([]);
    const result = await handleCodeSymbols(input(), { resolveBase: root, lspInstallAllowed: true, sessionId: 'repl' });
    expect(result).toContain('no locations found');
    expect(elicitationRouter.route).toHaveBeenCalledOnce();
    expect(resolveServer).toHaveBeenCalledTimes(2);
    expect(resolveServer).toHaveBeenNthCalledWith(1, source, root);
    expect(resolveServer).toHaveBeenNthCalledWith(2, source, root);
    expect(withPooledFile).toHaveBeenCalledWith(expect.objectContaining({
      command: '/afk/pyright', definition: python,
    }), source, 'x = 1\n', expect.objectContaining({ root }), expect.any(Function));
  });

  it('declined approval never spawns a server', async () => {
    vi.mocked(ensureServerInstalled).mockResolvedValue({ kind: 'declined' });
    expect(await handleCodeSymbols(input(), { resolveBase: root, lspInstallAllowed: true })).toContain('declined');
    expect(withPooledFile).not.toHaveBeenCalled();
  });

  it('unattended callers supply no consent callback even when another router is active', async () => {
    vi.mocked(ensureServerInstalled).mockImplementation(async (_definition, ctx) => {
      expect(ctx.interactive).toBe(false);
      expect(ctx.askConsent).toBeUndefined();
      return { kind: 'refused-unattended' };
    });
    expect(await handleCodeSymbols(input(), { resolveBase: root, lspInstallAllowed: false })).toContain('requires human consent');
    expect(elicitationRouter.route).not.toHaveBeenCalled();
    expect(withPooledFile).not.toHaveBeenCalled();
  });

  it('passive diagnostics never prompt or install even with a live human router', async () => {
    expect(await appendLspDiagnostics(source, undefined, root)).toBe('');
    expect(resolveServer).toHaveBeenCalledWith(source, root);
    expect(ensureServerInstalled).not.toHaveBeenCalled();
    expect(elicitationRouter.route).not.toHaveBeenCalled();
    expect(withPooledFile).not.toHaveBeenCalled();
  });

  it('both handlers reuse resolved Python spec/root and do not substitute TS defaults', async () => {
    const spec = { definition: python, command: 'pyright-langserver', args: ['--stdio'], source: 'path' as const };
    vi.mocked(resolveServer).mockResolvedValue({ kind: 'resolved', spec, root });
    vi.mocked(withPooledFile).mockResolvedValueOnce([]).mockResolvedValueOnce({ diagnostics: [] });
    await queryLspSymbol(source, 'definition', 1, 1, root);
    await queryLspDiagnostics(source, undefined, root);
    expect(withPooledFile).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(withPooledFile).mock.calls) {
      expect(call[0]).toBe(spec);
      expect(call[3].root).toBe(root);
    }
    expect(ensureServerInstalled).not.toHaveBeenCalled();
  });

  it('path containment refusal happens before any install or resolution', async () => {
    expect(await handleCodeSymbols({ ...input(), file_path: '/etc/shadow' }, { resolveBase: root, lspInstallAllowed: true }))
      .toContain('[LSP] code_symbols:');
    expect(resolveServer).not.toHaveBeenCalled();
    expect(ensureServerInstalled).not.toHaveBeenCalled();
  });
});
