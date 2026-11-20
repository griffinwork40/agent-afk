/**
 * `afk acp` — Agent Client Protocol (ACP) stdio server.
 *
 * Starts a JSON-RPC 2.0 server over stdin/stdout so an editor or GUI client
 * that implements the Agent Client Protocol, version 1, can drive afk.
 *
 * Protocol: newline-delimited JSON on stdin and stdout. The behavioural
 * contract (methods, capabilities, approval policy, error matrix) is
 * docs/acp-profile.md; the handlers live in acp.handlers.ts.
 *
 * @module cli/commands/acp
 */

import { Command } from 'commander';
import { exitAfterServer, runAcpServer } from './acp.server.js';
import { handleCommandError } from '../errors/index.js';
import { getModel } from '../shared-helpers.js';
import type { AgentModelInput } from '../../agent/types.js';

export function registerAcpCommand(program: Command): void {
  program
    .command('acp')
    .description(
      'Start an Agent Client Protocol (ACP) JSON-RPC 2.0 server over stdio ' +
        '(compatible with Zed and other ACP v1 clients; Zed configuration verified against Zed docs)',
    )
    .option('-m, --model <model>', 'model to use for sessions (default: configured default)')
    .option(
      '--max-turns <n>',
      'maximum messages sent per session (0 = uncapped; default: 0)',
      '0',
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
          // D17: every session is closed (journal closed, trace sealed) or
          // abandoned at its deadline; a timer left by session close must not
          // keep a client waiting for the process to end.
          await exitAfterServer(process.stdout, (code) => process.exit(code));
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}
