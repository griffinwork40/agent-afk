/**
 * Tool schema for the `bash` built-in.
 *
 * Extracted into its own file to satisfy the 350-code-line ratchet on
 * `schemas.ts` (baselined files may shrink, never grow). Imported and
 * re-exported from `schemas.ts` so callers import from the primary module.
 *
 * The description adapts its shell-syntax guidance to whichever shell is
 * active at process start — POSIX `/bin/sh` on macOS/Linux, Git Bash or
 * PowerShell on Windows — so the model generates compatible commands.
 *
 * @module agent/tools/schemas.bash
 */

import type { AnthropicToolDef } from './types.js';
import { bashToolShellGuidance } from '../../utils/resolve-shell.js';

export const bashTool: AnthropicToolDef = {
  name: 'bash',
  category: 'shell',
  concurrencySafe: false,
  description:
    'Execute a shell command and return its stdout and stderr. ' +
    'Use for running programs, installing packages, git operations, and any task that requires a shell. ' +
    `${bashToolShellGuidance()} Long-running commands should use timeout_ms. ` +
    'Output is capped to a ~100KB head+tail view (the start and end are kept, the middle elided with a notice), so the command still runs to completion and you keep the real exit code and the tail (test/build summaries, final errors). For the full body of a verbose command, filter it (`| tail -n`, `--quiet`, narrower flags) or redirect to a file and read slices. Commands emitting extreme output (>8MB) are terminated. ' +
    'For reading or writing files — especially anything sensitive — prefer the typed file tools ' +
    '(read_file, write_file, edit_file): they support per-call user approval, and interpreter ' +
    'one-liners (python -c, node -e, sh -c, ...) that reference credential paths (SSH keys, cloud ' +
    'credentials, /etc/shadow) are blocked by the path-approval policy on interactive surfaces.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
      },
      timeout_ms: {
        type: 'number',
        description:
          'Optional timeout in milliseconds (default 120000, max 600000). ' +
          'The command is killed if it exceeds this duration.',
      },
    },
    required: ['command'],
  },
};
