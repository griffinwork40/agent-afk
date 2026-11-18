/** Opt-in code_symbols registration. Mutation subcommands retain the same gate. */
import type { ToolHandler } from './types.js';
import { isLspSymbolsEnabled, handleCodeSymbols, type SymbolSubcommand } from './handlers/lsp-symbols.js';
import { handleLspRefactor } from './handlers/lsp-refactor.js';
import { REFACTOR_COMMANDS, validateRefactorInput, type LspRefactorInput } from './handlers/lsp-refactor-input.js';

export { isLspSymbolsEnabled };
export const LSP_SYMBOLS_TOOL_NAME = 'code_symbols';

export function createCodeSymbolsHandler(cwd?: string): ToolHandler | undefined {
  if (!isLspSymbolsEnabled()) return undefined;
  return async (input: unknown, signal, context) => {
    const fail = (content: string) => ({ content: `[LSP] code_symbols: ${content}`, isError: true });
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('input must be an object');
    const i = input as Record<string, unknown>;
    if (REFACTOR_COMMANDS.includes(i['subcommand'] as LspRefactorInput['subcommand'])) {
      const parsed = i as unknown as LspRefactorInput;
      const invalid = validateRefactorInput(parsed);
      if (invalid) return fail(invalid);
      return handleLspRefactor(parsed, context, cwd, undefined, signal);
    }
    const file_path = typeof i['file_path'] === 'string' ? i['file_path'] : '';
    if (!file_path) return fail('file_path is required');
    if (i['subcommand'] !== undefined && i['subcommand'] !== 'definition' && i['subcommand'] !== 'references') {
      return fail(`invalid subcommand '${String(i['subcommand'])}'. Must be definition, references, rename, document_symbols, workspace_symbols, or code_actions.`);
    }
    const subcommand = (i['subcommand'] as SymbolSubcommand | undefined) ?? 'definition';
    for (const key of ['line', 'col'] as const) {
      const value = i[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
        return fail(`invalid ${key} '${String(value)}'. Must be a positive integer.`);
      }
    }
    const line = typeof i['line'] === 'number' ? i['line'] : 1;
    const col = typeof i['col'] === 'number' ? i['col'] : 1;
    const content = await handleCodeSymbols({ file_path, subcommand, line, col }, context, cwd, undefined, signal);
    return { content };
  };
}
