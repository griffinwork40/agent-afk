/** Code action selection and explicit mutation execution. Server commands are never run while listing. */
import type { QueryContext } from '../../lsp/query.js';
import type { ToolHandlerContext, ToolResult } from '../types.js';
import { applyWorkspaceEdit } from './lsp-workspace-edit.js';
import type { LspRefactorInput } from './lsp-refactor-input.js';
import { record } from './lsp-refactor-symbols.js';

export interface RefactorEnvironment {
  context?: ToolHandlerContext;
  cwd: string;
  signal?: AbortSignal;
  expectedContents?: ReadonlyMap<string, string>;
}
export function editOptions(ctx: QueryContext, env: RefactorEnvironment) {
  return { ...env, client: ctx.client, documentVersion: (uri: string) => ctx.client.documentVersion(uri) };
}
const error = (content: string): ToolResult => ({ content: `[LSP] ${content}`, isError: true });

export async function codeActions(input: LspRefactorInput, ctx: QueryContext, env: RefactorEnvironment): Promise<ToolResult> {
  const start = { line: (input.line ?? 1) - 1, character: (input.col ?? 1) - 1 };
  const range = { start, end: { line: (input.end_line ?? input.line ?? 1) - 1,
    character: (input.end_col ?? input.col ?? 1) - 1 } };
  const options = () => ({ timeoutMs: ctx.remainingMs(), signal: env.signal });
  const raw = await ctx.client.request<unknown>('textDocument/codeAction', {
    textDocument: { uri: ctx.sync.uri }, range,
    context: { diagnostics: ctx.client.diagnostics.current(ctx.sync.uri, ctx.sync.version) },
  }, options());
  const actions = (Array.isArray(raw) ? raw : []).map(record)
    .filter((a): a is Record<string, unknown> => !!a && typeof a['title'] === 'string');
  if (!input.apply) {
    return { content: JSON.stringify({ actions: actions.map((a, index) => ({ index, title: a['title'],
      kind: a['kind'], disabled: record(a['disabled'])?.['reason'], preferred: a['isPreferred'] === true })) }) };
  }
  const matches = input.action_index !== undefined ? [actions[input.action_index]].filter(Boolean)
    : actions.filter((a) => a['title'] === input.action_title);
  if (matches.length !== 1) return error(matches.length ? 'Ambiguous action title; use action_index' : 'Code action not found');
  let selected = matches[0]!;
  if (selected['disabled']) return error('Selected code action is disabled');
  const provider = record(ctx.client.serverCapabilities['codeActionProvider']);
  if (!selected['edit'] && typeof selected['command'] !== 'string' && provider?.['resolveProvider'] === true) {
    const resolved = record(await ctx.client.request('codeAction/resolve', selected, options()));
    if (!resolved) return error('Invalid resolved code action');
    selected = resolved;
  }
  if (selected['disabled']) return error('Selected code action is disabled');
  const command = typeof selected['command'] === 'string' ? selected : record(selected['command']);
  if (!selected['edit'] && !command) return error('Selected code action has no edit or command');
  if (command && (typeof command['command'] !== 'string' || !command['command'])) return error('Invalid code action command');
  let editResult: ToolResult | undefined;
  if (selected['edit']) {
    editResult = await applyWorkspaceEdit(selected['edit'], editOptions(ctx, env));
    if (editResult.isError) return editResult;
  }
  if (!command) return editResult!;
  const applied: ToolResult[] = [];
  try {
    await ctx.client.withWorkspaceEditHandler(async (edit) => {
      const result = await applyWorkspaceEdit(edit, editOptions(ctx, {
        ...env, expectedContents: ctx.client.documentContents(),
      }));
      applied.push(result);
      return { applied: !result.isError, ...(result.isError ? { failureReason: result.content } : {}) };
    }, () => ctx.client.request('workspace/executeCommand', {
      command: command['command'], arguments: Array.isArray(command['arguments']) ? command['arguments'] : [],
    }, options()));
  } catch (err) {
    return error(`Code action command failed${editResult || applied.some((r) => !r.isError) ? ' after edits were applied (not rolled back)' : ''}: ${(err as Error).message}`);
  }
  const failed = applied.find((r) => r.isError);
  if (failed) return failed;
  return { content: JSON.stringify({ title: selected['title'], command: command['command'],
    status: 'executed', edits: [editResult, ...applied].filter(Boolean).map((r) => r!.content) }) };
}
