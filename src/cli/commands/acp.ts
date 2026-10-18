/**
 * `afk acp` — Agent Client Protocol (ACP) stdio server.
 *
 * Starts a JSON-RPC 2.0 server over stdin/stdout so Zed, JetBrains, and
 * other ACP-capable editors can drive afk as a first-class agent backend.
 *
 * Protocol: newline-delimited JSON (NDJSON) on stdin → NDJSON on stdout.
 * The server speaks the ACP subset: initialize, session/new, session/prompt,
 * session/close, and session/cancel.  Each session/prompt streams intermediate
 * notifications (no id) followed by a final done response with the request id.
 *
 * @module cli/commands/acp
 */

import { Command } from 'commander';
import { runAcpServer } from './acp.server.js';
import { handleCommandError } from '../errors/index.js';
import { getModel } from '../shared-helpers.js';
import type { AgentModelInput } from '../../agent/types.js';

export function registerAcpCommand(program: Command): void {
  program
    .command('acp')
    .description(
      'Start an Agent Client Protocol (ACP) JSON-RPC 2.0 server over stdio ' +
        '(compatible with Zed, JetBrains, and other ACP clients)',
    )
    .option('-m, --model <model>', 'model to use for sessions (default: configured default)')
    .option(
      '--max-turns <n>',
      'maximum agent turns per prompt (default: 10)',
      '10',
    )
    // Fix #1: add --dangerously-skip-permissions flag
    .option(
      '--dangerously-skip-permissions',
      'Force bypass mode: skip all permission prompts for all sessions created by this server',
    )
    .action(
      async (options: {
        model?: AgentModelInput;
        maxTurns: string;
        dangerouslySkipPermissions?: boolean;
      }) => {
        try {
          await runAcpServer({
            model: options.model ?? getModel(),
            maxTurns: parseInt(options.maxTurns, 10),
            input: process.stdin,
            output: process.stdout,
            dangerouslySkipPermissions: options.dangerouslySkipPermissions,
          });
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}
