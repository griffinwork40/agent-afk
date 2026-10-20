/**
 * Opt-in surface registration for the `code_symbols` tool (phase 2 of #3904).
 *
 * Mirrors the `readonly-git-surface.ts` pattern: a flag check determines
 * whether the handler is registered at provider-construction time. When
 * `AFK_LSP_DIAGNOSTICS` is off (the default), the handler is never registered
 * and the tool is absent from the model's tool list — no runtime cost.
 *
 * The schema (`codeSymbolsTool`) is always included in `ALL_TOOL_SCHEMAS` for
 * closed-world classification (schema-classification.test.ts), matching the
 * `gitReadTool` precedent.
 *
 * @module agent/tools/lsp-symbols-surface
 */

import type { ToolHandler } from './types.js';
import { isLspSymbolsEnabled, handleCodeSymbols, type SymbolSubcommand } from './handlers/lsp-symbols.js';

export { isLspSymbolsEnabled };
export const LSP_SYMBOLS_TOOL_NAME = 'code_symbols';

/**
 * Build a `code_symbols` ToolHandler for registration in the built-in handler
 * map. Returns undefined when the feature is disabled so the caller can skip
 * the map insertion cleanly.
 */
export function createCodeSymbolsHandler(): ToolHandler | undefined {
  if (!isLspSymbolsEnabled()) return undefined;
  return async (input: unknown) => {
    const i = input as {
      file_path?: unknown;
      subcommand?: unknown;
      line?: unknown;
      col?: unknown;
    };
    const file_path = typeof i.file_path === 'string' ? i.file_path : '';
    const subcommand: SymbolSubcommand =
      i.subcommand === 'definition' || i.subcommand === 'references'
        ? i.subcommand
        : 'definition';
    const line = typeof i.line === 'number' ? i.line : 1;
    const col = typeof i.col === 'number' ? i.col : 1;
    if (!file_path) return { content: '[LSP] code_symbols: file_path is required', isError: true };
    const content = await handleCodeSymbols({ file_path, subcommand, line, col });
    return { content };
  };
}
