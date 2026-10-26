/** The opt-in LSP surface; mutation risk is refined per subcommand by the dispatcher. */
import type { AnthropicToolDef } from './types.js';

export const codeSymbolsTool: AnthropicToolDef = {
  name: 'code_symbols',
  category: 'read',
  concurrencySafe: false,
  description:
    'Query and refactor code using a persistent language server. Requires AFK_LSP_DIAGNOSTICS=1. ' +
    'definition/references return locations; document_symbols lists a file outline; workspace_symbols searches ' +
    'the project (provide file_path to choose a language in mixed projects). Positions are 1-based UTF-16. ' +
    'rename applies a safe multi-file edit; apply:false previews it. code_actions lists available actions ' +
    'by zero-based index and title; apply:true plus action_index OR exact action_title applies one action. ' +
    'Selected actions may run language-server commands, including server-requested workspace edits. ' +
    'Edits use the normal write policy and checkpoints; file create/delete/rename resource operations are refused. ' +
    'Language servers run local executables: only enable trusted servers in trusted workspaces.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Source file path. Required except for workspace_symbols, which detects project language when omitted.' },
      subcommand: { type: 'string', enum: ['definition', 'references', 'rename', 'document_symbols', 'workspace_symbols', 'code_actions'] },
      line: { type: 'integer', minimum: 1, description: '1-based line; default 1.' },
      col: { type: 'integer', minimum: 1, description: '1-based UTF-16 column; default 1.' },
      end_line: { type: 'integer', minimum: 1, description: 'Code action range end line; defaults to line.' },
      end_col: { type: 'integer', minimum: 1, description: 'Code action range end column; defaults to col.' },
      new_name: { type: 'string', description: 'Required new symbol name for rename.' },
      query: { type: 'string', description: 'Workspace symbol search text; default empty.' },
      apply: { type: 'boolean', description: 'Rename: default true, false previews. Code actions: default false (list), true applies selection.' },
      action_index: { type: 'integer', minimum: 0, description: 'Zero-based index from code_actions; mutually exclusive with action_title.' },
      action_title: { type: 'string', description: 'Exact, unique code action title to apply.' },
    },
    // Contract: narrowed from ['file_path', 'subcommand', 'line', 'col'] in
    // wave 1 because workspace_symbols needs no file_path and document_symbols
    // needs no line/col. Per-subcommand validation lives in lsp-refactor-input.ts.
    required: ['subcommand'],
  },
};
