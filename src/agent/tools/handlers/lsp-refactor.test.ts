import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleLspRefactor } from './lsp-refactor.js';
import type { LspRefactorInput } from './lsp-refactor-input.js';
import { getLspPool } from '../../lsp/pool.js';
import { fakeServerCmd, messagesWithMethod, readFakeLog, writeFakeLspServer, type FakeServerConfig } from '../../lsp/__test-utils__/fake-lsp-server.js';
import { createCodeSymbolsHandler } from '../lsp-symbols-surface.js';

let dir: string;
let source: string;
let uri: string;
let script: string;
let log: string;
const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } };
beforeEach(async () => {
  vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
  vi.stubEnv('AFK_LSP_SYMBOLS_TIMEOUT_MS', '3000');
  dir = await mkdtemp(path.join(os.tmpdir(), 'afk-refactor-'));
  source = path.join(dir, 'main.ts');
  uri = pathToFileURL(source).href;
  script = path.join(dir, 'server.cjs');
  log = path.join(dir, 'messages.jsonl');
  await writeFile(source, 'const old = 1;\n');
});
afterEach(async () => {
  await getLspPool().disposeAll();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
function server(config: FakeServerConfig = {}) { writeFakeLspServer(script, { ...config, logFile: log }); }
function run(input: Partial<LspRefactorInput> & Pick<LspRefactorInput, 'subcommand'>) {
  return handleLspRefactor({ file_path: source, ...input }, { resolveBase: dir }, dir, fakeServerCmd(script));
}
function edit(target = uri) { return { changes: { [target]: [{ range, newText: 'newName' }] } }; }

describe('rename', () => {
  it('prepares when supported, edits multiple files, and resyncs changed documents', async () => {
    const second = path.join(dir, 'other.ts');
    await writeFile(second, 'const old = 2;\n');
    const changes = { ...edit().changes, ...edit(pathToFileURL(second).href).changes };
    server({ capabilities: { renameProvider: { prepareProvider: true } }, workspaceEdit: { changes } });
    const result = await run({ subcommand: 'rename', new_name: 'newName', line: 1, col: 7 });
    expect(result.isError).not.toBe(true);
    expect(await readFile(source, 'utf8')).toBe('const newName = 1;\n');
    expect(await readFile(second, 'utf8')).toBe('const newName = 2;\n');
    const methods = readFakeLog(log).flatMap((e) => e.msg?.method ?? []);
    expect(methods.indexOf('textDocument/prepareRename')).toBeLessThan(methods.indexOf('textDocument/rename'));
    expect(messagesWithMethod(log, 'textDocument/rename')[0]?.params.newName).toBe('newName');
  });
  it('does not rename when prepareRename returns null', async () => {
    server({ capabilities: { renameProvider: { prepareProvider: true } }, prepareRename: null, workspaceEdit: edit() });
    expect((await run({ subcommand: 'rename', new_name: 'newName' })).isError).toBe(true);
    expect(messagesWithMethod(log, 'textDocument/rename')).toHaveLength(0);
    expect(await readFile(source, 'utf8')).toContain('old');
  });
  it('previews without writes and skips unsupported prepareRename', async () => {
    server({ capabilities: { renameProvider: true }, workspaceEdit: edit() });
    const result = await run({ subcommand: 'rename', new_name: 'newName', apply: false });
    expect(result.isError).not.toBe(true);
    expect(await readFile(source, 'utf8')).toContain('old');
    expect(messagesWithMethod(log, 'textDocument/prepareRename')).toHaveLength(0);
  });
  it('rejects stale versioned edits', async () => {
    server({ workspaceEdit: { documentChanges: [{ textDocument: { uri, version: 999 }, edits: [{ range, newText: 'oops' }] }] } });
    expect((await run({ subcommand: 'rename', new_name: 'oops' })).isError).toBe(true);
    expect(await readFile(source, 'utf8')).toContain('old');
  });
});

describe('symbol outlines and search', () => {
  it('flattens document symbol hierarchy with 1-based positions', async () => {
    const sym = { name: 'old', kind: 13, range, selectionRange: range };
    server({ documentSymbols: [{ ...sym, children: [{ ...sym, name: 'child' }] }] });
    const result = JSON.parse((await run({ subcommand: 'document_symbols' })).content);
    expect(result.symbols).toMatchObject([{ name: 'old', line: 1, col: 7, depth: 0 }, { name: 'child', depth: 1 }]);
  });
  it('filters external locations and sends workspace query without opening a document', async () => {
    server({ workspaceSymbols: [
      { name: 'old', kind: 13, location: { uri, range } },
      { name: 'private', kind: 13, location: { uri: 'file:///outside/secret.ts', range } },
    ] });
    const result = JSON.parse((await run({ subcommand: 'workspace_symbols', query: 'old' })).content);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe('old');
    expect(messagesWithMethod(log, 'textDocument/didOpen')).toHaveLength(0);
    expect(messagesWithMethod(log, 'workspace/symbol')[0]?.params).toEqual({ query: 'old' });
  });
  it('detects the workspace language without a file_path', async () => {
    await writeFile(path.join(dir, 'package.json'), '{}');
    server();
    expect((await run({ subcommand: 'workspace_symbols', file_path: undefined })).isError).not.toBe(true);
    expect(messagesWithMethod(log, 'workspace/symbol')).toHaveLength(1);
  });
});

describe('code actions', () => {
  it('lists without edits or commands', async () => {
    server({ codeActions: [{ title: 'Fix', edit: edit() }, { title: 'Command', command: 'do.fix' }] });
    const result = await run({ subcommand: 'code_actions' });
    expect(JSON.parse(result.content).actions).toMatchObject([{ index: 0, title: 'Fix' }, { index: 1, title: 'Command' }]);
    expect(await readFile(source, 'utf8')).toContain('old');
    expect(messagesWithMethod(log, 'workspace/executeCommand')).toHaveLength(0);
  });
  it('applies by exact title', async () => {
    server({ codeActions: [{ title: 'Fix', edit: edit() }] });
    expect((await run({ subcommand: 'code_actions', apply: true, action_title: 'Fix' })).isError).not.toBe(true);
    expect(await readFile(source, 'utf8')).toContain('newName');
  });
  it('resolves a lazy action selected by index', async () => {
    server({ capabilities: { codeActionProvider: { resolveProvider: true } },
      codeActions: [{ title: 'Fix', data: 42 }], resolvedCodeAction: { title: 'Fix', edit: edit() } });
    expect((await run({ subcommand: 'code_actions', apply: true, action_index: 0 })).isError).not.toBe(true);
    expect(messagesWithMethod(log, 'codeAction/resolve')).toHaveLength(1);
    expect(await readFile(source, 'utf8')).toContain('newName');
  });
  it('executes selected command and routes server applyEdit through write policy', async () => {
    server({ codeActions: [{ title: 'Fix', command: { title: 'Fix', command: 'do.fix', arguments: [1] } }], commandEdit: edit() });
    const result = await run({ subcommand: 'code_actions', apply: true, action_index: 0 });
    expect(result.isError).not.toBe(true);
    expect(await readFile(source, 'utf8')).toContain('newName');
    expect(messagesWithMethod(log, 'workspace/executeCommand')[0]?.params).toEqual({ command: 'do.fix', arguments: [1] });
    expect(readFakeLog(log).find((e) => e.msg?.id === 'apply-1')?.msg?.result).toMatchObject({ applied: true });
  });
  it('refuses resource operations from a command and reports applyEdit failure', async () => {
    server({ codeActions: [{ title: 'Fix', command: 'do.fix' }], commandEdit: { documentChanges: [{ kind: 'delete', uri }] } });
    expect((await run({ subcommand: 'code_actions', apply: true, action_index: 0 })).isError).toBe(true);
    expect(await readFile(source, 'utf8')).toContain('old');
    expect(readFakeLog(log).find((e) => e.msg?.id === 'apply-1')?.msg?.result).toMatchObject({ applied: false });
  });
  it('rejects duplicate titles and disabled actions', async () => {
    server({ codeActions: [{ title: 'Fix', edit: edit() }, { title: 'Fix', disabled: { reason: 'not here' } }] });
    expect((await run({ subcommand: 'code_actions', apply: true, action_title: 'Fix' })).content).toContain('Ambiguous');
    expect((await run({ subcommand: 'code_actions', apply: true, action_index: 1 })).content).toContain('disabled');
    expect(await readFile(source, 'utf8')).toContain('old');
  });
});

describe('failure and validation', () => {
  it('returns structured timeout and abort errors', async () => {
    vi.stubEnv('AFK_LSP_SYMBOLS_TIMEOUT_MS', '50');
    server({ hangRequests: true });
    expect((await run({ subcommand: 'document_symbols' })).isError).toBe(true);
    const controller = new AbortController(); controller.abort();
    expect((await handleLspRefactor({ subcommand: 'document_symbols', file_path: source }, undefined, dir,
      fakeServerCmd(script), controller.signal)).content).toContain('Aborted');
  });
  it.each([
    { subcommand: 'rename', file_path: '/any.ts' },
    { subcommand: 'code_actions', file_path: '/any.ts', apply: true },
    { subcommand: 'document_symbols', file_path: '/any.ts', line: 1.5 },
    { subcommand: 'code_actions', file_path: '/any.ts', action_index: -1 },
    { subcommand: 'code_actions', file_path: '/any.ts', line: 2, end_line: 1 },
    { subcommand: 'code_actions', file_path: '/any.ts', apply: 'true' },
    null,
  ])('rejects invalid surface input %j', async (input) => {
    const handler = createCodeSymbolsHandler(dir)!;
    expect(await handler(input, new AbortController().signal)).toMatchObject({ isError: true });
  });
});
