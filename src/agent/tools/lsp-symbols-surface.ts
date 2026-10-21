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
 *
 * @param cwd - Session working directory for path resolution and rootUri.
 *   Threaded from `createBuiltinHandlers(permissionMode, cwd)` like
 *   `createGitReadHandler(cwd)`.
 */
export function createCodeSymbolsHandler(cwd?: string): ToolHandler | undefined {
  if (!isLspSymbolsEnabled()) return undefined;
  return async (input: unknown, _signal, context) => {
    const i = input as {
      file_path?: unknown;
      subcommand?: unknown;
      line?: unknown;
      col?: unknown;
    };

    // Finding 3: return validation errors instead of silent defaults.
    const file_path = typeof i.file_path === 'string' ? i.file_path : '';
    if (!file_path) return { content: '[LSP] code_symbols: file_path is required', isError: true };

    if (i.subcommand !== undefined && i.subcommand !== 'definition' && i.subcommand !== 'references') {
      return {
        content: `[LSP] code_symbols: invalid subcommand '${String(i.subcommand)}'. Must be 'definition' or 'references'.`,
        isError: true,
      };
    }
    const subcommand: SymbolSubcommand = (i.subcommand as SymbolSubcommand | undefined) ?? 'definition';

    if (i.line !== undefined && (typeof i.line !== 'number' || !Number.isFinite(i.line) || i.line < 1)) {
      return {
        content: `[LSP] code_symbols: invalid line '${String(i.line)}'. Must be a positive integer.`,
        isError: true,
      };
    }
    if (i.col !== undefined && (typeof i.col !== 'number' || !Number.isFinite(i.col) || i.col < 1)) {
      return {
        content: `[LSP] code_symbols: invalid col '${String(i.col)}'. Must be a positive integer.`,
        isError: true,
      };
    }
    // When line/col are absent the caller omitted them; default to 1:1
    // (beginning of file) which is a valid LSP position. Invalid values
    // were already rejected above.
    const line = typeof i.line === 'number' ? i.line : 1;
    const col = typeof i.col === 'number' ? i.col : 1;

    const content = await handleCodeSymbols({ file_path, subcommand, line, col }, context, cwd, undefined, _signal);
    return { content };
  };
}
