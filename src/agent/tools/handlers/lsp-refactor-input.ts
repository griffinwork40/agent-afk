/** Input contract and validation for the extended code_symbols surface. */
export const REFACTOR_COMMANDS = ['rename', 'document_symbols', 'workspace_symbols', 'code_actions'] as const;
export type RefactorCommand = typeof REFACTOR_COMMANDS[number];
export interface LspRefactorInput {
  subcommand: RefactorCommand;
  file_path?: string;
  line?: number;
  col?: number;
  end_line?: number;
  end_col?: number;
  new_name?: string;
  query?: string;
  apply?: boolean;
  action_index?: number;
  action_title?: string;
}

export function validateRefactorInput(input: LspRefactorInput): string | undefined {
  if (!REFACTOR_COMMANDS.includes(input.subcommand)) return 'invalid subcommand';
  if (input.subcommand !== 'workspace_symbols' && !input.file_path) return 'file_path is required';
  for (const key of ['file_path', 'query', 'new_name', 'action_title'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') return `invalid ${key}: expected string`;
  }
  for (const key of ['line', 'col', 'end_line', 'end_col'] as const) {
    const value = input[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) return `invalid ${key}: expected positive integer`;
  }
  if (input.apply !== undefined && typeof input.apply !== 'boolean') return 'invalid apply: expected boolean';
  if (input.subcommand === 'rename' && !input.new_name?.trim()) return 'new_name is required';
  if (input.action_index !== undefined && (!Number.isInteger(input.action_index) || input.action_index < 0)) {
    return 'action_index must be a non-negative integer';
  }
  if (input.action_index !== undefined && input.action_title !== undefined) return 'select by action_index OR action_title, not both';
  if (input.subcommand === 'code_actions' && input.apply && input.action_index === undefined && !input.action_title) {
    return 'apply requires action_index or action_title';
  }
  const startLine = input.line ?? 1;
  const startCol = input.col ?? 1;
  const endLine = input.end_line ?? startLine;
  const endCol = input.end_col ?? startCol;
  if (endLine < startLine || (endLine === startLine && endCol < startCol)) return 'range end precedes start';
  return undefined;
}
