/**
 * /where slash command — one-stop orientation for humans and agents.
 *
 * Shows workspace context (branch, cwd, dirty files), session identity,
 * and a "see also" hint pointing at deeper introspection tools.
 */

import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { gatherWorkspace } from '../../../agent/awareness/workspace-source.js';
import type { SlashCommand } from '../types.js';

export const whereCmd: SlashCommand = {
  name: '/where',
  aliases: ['/orient'],
  summary: 'Show workspace, session, and introspection surface at a glance',
  hint: 'When you feel lost — shows branch, cwd, session identity, and pointers to deeper inspection tools.',
  async handler(ctx) {
    const { stats, out } = ctx;
    const cwd = stats.cwd ?? process.cwd();
    const ws = gatherWorkspace(cwd);

    out.line();
    out.line(palette.bold('Where you are'));
    out.line(divider());

    // Workspace
    const branch = ws.branch ?? palette.dim('(detached)');
    const sha = ws.headSha ?? palette.dim('n/a');
    const dirtyLabel = ws.dirty === null
      ? palette.dim('unknown')
      : ws.dirty
        ? palette.warning(`${ws.dirtyCount} dirty`)
        : palette.success('clean');
    out.line(`  ${palette.dim('Branch'.padEnd(14))}${branch} @ ${sha}`);
    out.line(`  ${palette.dim('Working tree'.padEnd(14))}${dirtyLabel}`);
    out.line(`  ${palette.dim('Directory'.padEnd(14))}${cwd}`);

    // Session
    out.line();
    const name = stats.name ?? 'unnamed';
    const sessionId = stats.sessionId ?? palette.dim('not assigned');
    out.line(`  ${palette.dim('Session'.padEnd(14))}${name} (${sessionId})`);
    out.line(`  ${palette.dim('Model'.padEnd(14))}${palette.brand(stats.model)}`);
    out.line(`  ${palette.dim('Mode'.padEnd(14))}${stats.permissionMode}`);

    // Introspection pointers
    out.line();
    out.line(palette.dim('  Dig deeper:'));
    out.line(palette.dim('    /debug          SDK metadata, tools, MCP, plugins'));
    out.line(palette.dim('    /tools          list available tools'));
    out.line(palette.dim('    /info           session identity + usage'));
    out.line(palette.dim('    afk trace list  recent session traces'));
    out.line(palette.dim('    afk witness     search across session traces'));
    out.line();
    return 'continue';
  },
};
