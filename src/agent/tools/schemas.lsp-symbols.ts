/**
 * Tool schema for the `code_symbols` built-in (phase 2 of #3904).
 *
 * Opt-in LSP symbol lookup: go-to-definition and find-references backed by
 * typescript-language-server. Enabled when AFK_LSP_DIAGNOSTICS=1.
 *
 * Extracted into its own file to keep `schemas.ts` within the 350-code-line
 * ceiling. Imported and added to `ALL_TOOL_SCHEMAS` in `schemas.ts`.
 *
 * @module agent/tools/schemas.lsp-symbols
 */

import type { AnthropicToolDef } from './types.js';

export const codeSymbolsTool: AnthropicToolDef = {
  name: 'code_symbols',
  category: 'read',
  concurrencySafe: true,
  description:
    'Look up the definition or all references of a symbol at a given position in a ' +
    'TypeScript or JavaScript file, using the language server (typescript-language-server). ' +
    'Requires AFK_LSP_DIAGNOSTICS=1 and typescript-language-server on PATH. ' +
    'Off by default — a missing or slow server returns an informative message rather than failing. ' +
    'Use `definition` to jump to where a symbol is declared; use `references` to find every ' +
    'call site or usage. Results are file paths with 1-based line and column numbers.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the TypeScript or JavaScript file containing the symbol.',
      },
      subcommand: {
        type: 'string',
        enum: ['definition', 'references'],
        description:
          '`definition` — go to the declaration of the symbol. ' +
          '`references` — find all usages of the symbol.',
      },
      line: {
        type: 'number',
        description: '1-based line number of the symbol position.',
      },
      col: {
        type: 'number',
        description: '1-based column number of the symbol position.',
      },
    },
    required: ['file_path', 'subcommand', 'line', 'col'],
  },
};
