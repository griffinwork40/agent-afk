/**
 * Tool schema for the structured read-only `git_read` tool (#3754).
 *
 * Advertised only while `AFK_READONLY_GIT_TOOL` is enabled (see
 * `readonly-git-surface.ts`); it then replaces generic `bash` on read-only
 * child surfaces. Kept out of `builtinToolSchemas` so the default (flag off)
 * tool surface is byte-identical to before.
 *
 * @module agent/tools/schemas.git-read
 */

import type { AnthropicToolDef } from './types.js';
import { GIT_READ_SUBCOMMANDS } from './git-read.policy.js';

export const gitReadTool: AnthropicToolDef = {
  name: 'git_read',
  category: 'read',
  concurrencySafe: true,
  description:
    'Run a read-only git query in the session working directory without a shell. ' +
    `Subcommands: ${GIT_READ_SUBCOMMANDS.join(', ')}. ` +
    // The prompt steers models toward `--max-count=<N>` as the preferred form
    // for count-limiting log/rev-list output. `-n <N>` and `-<N>` are also
    // accepted as fallback shorthands (the count-shorthand normalizer in
    // git-read.policy.ts rewrites them to `--max-count=<N>` before validation),
    // but this is not advertised here to keep usage consistent.
    'Only an allowlisted set of options is accepted per subcommand (e.g. log: --oneline, --stat, ' +
    '--max-count=N, --since=…, --author=…, --format=…; diff: --cached, --stat, --name-only; ' +
    'branch: --show-current, -a, --remotes; rev-list: --count, --left-right). ' +
    'Revisions (HEAD~3, main..HEAD, a SHA, v1.2.0) go in `args`; file paths go in `paths` and must stay ' +
    'inside the working directory. Options that write files or run programs (-c, --output, --ext-diff, ' +
    '--textconv, --exec, pagers, editors) are rejected. Output is capped by `max_bytes`.',
  input_schema: {
    type: 'object',
    properties: {
      subcommand: {
        type: 'string',
        enum: [...GIT_READ_SUBCOMMANDS],
        description: 'The git subcommand to run.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Allowlisted options and revisions, one token per entry (e.g. ["--oneline", "--max-count=20", "main..HEAD"]).',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional pathspecs, relative to the working directory. Passed after `--`.',
      },
      pattern: {
        type: 'string',
        description: 'Search pattern. Required for `grep`, invalid otherwise.',
      },
      max_bytes: {
        type: 'number',
        description: 'Maximum output bytes (default 51200, ceiling 204800). Longer output is truncated with a marker.',
      },
    },
    required: ['subcommand'],
  },
};
