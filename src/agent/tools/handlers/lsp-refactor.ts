/** Extended code_symbols operations using the same registry, pool, and permission boundary. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolHandlerContext, ToolResult } from '../types.js';
import { detectProjectLanguages } from '../../lsp/registry.js';
import { withPooledFile, withPooledWorkspace, type QueryContext } from '../../lsp/query.js';
import { resolveAndContain } from './_cwd-utils.js';
import { isLspSymbolsEnabled } from './lsp-symbols.js';
import { resolveLspServer } from './lsp-server.js';
import { lspInstallContext } from './lsp-install-consent.js';
import { getSymbolsTimeoutMs, lspFailureMessage } from './lsp-shared.js';
import { applyWorkspaceEdit } from './lsp-workspace-edit.js';
import { validateRefactorInput, type LspRefactorInput } from './lsp-refactor-input.js';
import { codeActions, editOptions, type RefactorEnvironment } from './lsp-refactor-actions.js';
import { record, symbolRows } from './lsp-refactor-symbols.js';
export type { LspRefactorInput } from './lsp-refactor-input.js';

async function rename(input: LspRefactorInput, ctx: QueryContext, env: RefactorEnvironment): Promise<ToolResult> {
  const params = { textDocument: { uri: ctx.sync.uri },
    position: { line: (input.line ?? 1) - 1, character: (input.col ?? 1) - 1 } };
  const options = () => ({ timeoutMs: ctx.remainingMs(), signal: env.signal });
  const capability = ctx.client.serverCapabilities['renameProvider'];
  if (capability === false) return { content: '[LSP] Rename is not supported by this server', isError: true };
  if (record(capability)?.['prepareProvider'] === true) {
    const prepared = await ctx.client.request('textDocument/prepareRename', params, options());
    if (prepared === null) return { content: '[LSP] Symbol cannot be renamed at this position', isError: true };
  }
  const edit = await ctx.client.request('textDocument/rename', { ...params, newName: input.new_name }, options());
  if (edit === null) return { content: '[LSP] Rename returned no edits' };
  return applyWorkspaceEdit(edit, { ...editOptions(ctx, env), dryRun: input.apply === false });
}

export async function handleLspRefactor(
  input: LspRefactorInput,
  context?: ToolHandlerContext,
  cwd?: string,
  serverCmd?: readonly string[],
  signal?: AbortSignal,
): Promise<ToolResult> {
  const fail = (message: string): ToolResult => ({ content: `[LSP] ${input.subcommand}: ${message}`, isError: true });
  if (!isLspSymbolsEnabled()) return fail('requires AFK_LSP_DIAGNOSTICS=1');
  const invalid = validateRefactorInput(input);
  if (invalid) return fail(invalid);
  if (signal?.aborted) return fail('Aborted');
  try {
    const sessionRoot = context?.resolveBase ?? cwd ?? process.cwd();
    // A workspace-only request needs a language, not an arbitrary file read.
    // Use a caller-supplied source file or the first detected project language.
    const definition = input.file_path ? undefined : detectProjectLanguages(sessionRoot)[0];
    if (!input.file_path && !definition && !serverCmd) return fail('No project language detected; provide file_path');
    const candidate = input.file_path ?? path.join(sessionRoot, `__afk_workspace${Object.keys(definition?.languageIds ?? { '.ts': '' })[0]}`);
    const filePath = resolveAndContain(candidate, context, 'read', cwd);
    const resolved = await resolveLspServer(filePath, { sessionRoot, serverCmd, installContext: lspInstallContext(context, signal) });
    if (resolved.kind !== 'resolved') return fail(resolved.error);
    const opts = { root: resolved.root, timeoutMs: getSymbolsTimeoutMs(), signal };
    if (input.subcommand === 'workspace_symbols') {
      return await withPooledWorkspace(resolved.spec, opts, async (ctx) => {
        const raw = await ctx.client.request('workspace/symbol', { query: input.query ?? '' }, { timeoutMs: ctx.remainingMs(), signal });
        return { content: JSON.stringify({ symbols: symbolRows(raw, undefined, context, cwd), limit: 1000 }) };
      });
    }
    const content = await readFile(filePath, 'utf8');
    return await withPooledFile(resolved.spec, filePath, content, opts, async (ctx) => {
      const deadlineSignal = AbortSignal.timeout(ctx.remainingMs());
      const operationSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
      const env = { context, cwd: sessionRoot, signal: operationSignal, expectedContents: ctx.client.documentContents() };
      if (input.subcommand === 'rename') return rename(input, ctx, env);
      if (input.subcommand === 'code_actions') return codeActions(input, ctx, env);
      const raw = await ctx.client.request('textDocument/documentSymbol', { textDocument: { uri: ctx.sync.uri } },
        { timeoutMs: ctx.remainingMs(), signal });
      return { content: JSON.stringify({ symbols: symbolRows(raw, ctx.sync.uri, context, cwd), limit: 1000 }) };
    });
  } catch (err) {
    return fail(lspFailureMessage(err, 'LSP operation timed out (increase AFK_LSP_SYMBOLS_TIMEOUT_MS)'));
  }
}
