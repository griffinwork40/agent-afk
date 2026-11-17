/** Child-session destructive-git gate, extracted to keep the gate chain
 * below the 350-code-line ceiling. Classification does not execute commands.
 */
import { classifyDestructiveGit } from './readonly-bash.tokenizer.js';
import { emitPreToolUseBlock, type PreDispatchGateDeps } from './dispatcher.pre-dispatch-gates.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';

/**
 * Child-session destructive-git gate. Returns an isError {@link ToolResult}
 * when `blockDestructiveGit` is true AND `call` is a `bash` invocation whose
 * command contains a working-tree-destructive git subcommand; otherwise
 * returns `null` (allow).
 *
 * Runs AFTER `checkReadOnlyBash` so read-only children that already block all
 * mutating bash never reach this gate.
 */
export async function checkDestructiveGitBash(
  call: ToolCall,
  deps: PreDispatchGateDeps,
): Promise<ToolResult | null> {
  if (!deps.blockDestructiveGit || call.name !== 'bash') return null;
  const input = call.input;
  const command =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)['command']
      : undefined;
  if (typeof command !== 'string') return null;
  const verdict = classifyDestructiveGit(command);
  if (!verdict.destructive) return null;
  const reason =
    `Bash command blocked: child sessions may not run working-tree-destructive ` +
    `git commands (${verdict.reason ?? 'destructive git command detected'}). ` +
    `To restore one file intentionally, use git show <ref>:<path> > <path> ` +
    `(quote paths and preserve local edits first); this overwrites that file. ` +
    `Otherwise, report the requirement to your caller.`;
  await emitPreToolUseBlock(call.name, reason, deps);
  return { content: reason, isError: true, failureClass: 'permission-denied' };
}
