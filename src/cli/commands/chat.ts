import { Command } from 'commander';
import { applySharedChatOptions } from './shared-command-options.js';
import { runChatAction } from './chat.action-body.js';

export function registerChatCommand(program: Command): void {
  // Build the command with shared options, then append chat-specific flags.
  // NOTE: --stream is currently inert — use --format stream-json for headless
  // streaming. Reserved for future token-by-token terminal rendering.
  applySharedChatOptions(
    program
      .command('chat')
      .description('Send a message to the agent')
      // Message is optional: omit when piping via stdin (or pass `-` explicitly).
      .argument('[message]', 'Message to send; use `-` or omit to read from stdin'),
    { maxTurnsDefault: '10' },
  )
    .option('-s, --stream', '[no-op] reserved; use --format stream-json for headless streaming', false)
    .option('-f, --format <format>', 'Output format (text|json|stream-json)', 'text')
    .option('--max-budget-usd <usd>', 'Hard session cost ceiling in USD. Env: AFK_MAX_BUDGET_USD')
    .option('--task-budget <tokens>', 'Soft per-task token budget. Env: AFK_TASK_BUDGET')
    .option('--session-id <uuid>', 'Assign a specific UUID to this session (creates new; errors if already exists)')
    .option('--post <targets>', 'Headless publish of the final assistant message: github, telegram, or github,telegram')
    .option('--post-pr <ref>', 'PR number, URL, or branch for --post github (defaults to the current-branch PR)')
    .action(runChatAction);
}
