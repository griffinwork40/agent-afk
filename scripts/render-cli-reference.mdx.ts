import { type Command } from 'commander';
import { cell, code, pageHeader } from './lib/docs-reference.js';

const guides: Record<string, string> = {
  chat: '/surfaces/chat', interactive: '/surfaces/repl', daemon: '/surfaces/daemon',
  telegram: '/surfaces/telegram', web: '/surfaces/web', schedule: '/guides/scheduling',
  queue: '/guides/scheduling', service: '/guides/run-as-service', restart: '/guides/run-as-service',
  bg: '/guides/background-processes', worktree: '/guides/worktrees', branch: '/guides/worktrees',
  farm: '/guides/farm', trace: '/guides/observability', witness: '/guides/observability',
  transcript: '/guides/observability', captures: '/guides/background-processes',
  insights: '/guides/self-improvement', defects: '/guides/self-improvement', improve: '/guides/self-improvement',
  whatif: '/guides/whatif', usage: '/guides/usage-and-cost', browser: '/configuration/browser',
  config: '/configuration/editing-config', login: '/configuration/api-keys', provider: '/configuration/models-providers',
  doctor: '/troubleshooting', migrate: '/guides/migrate', plugin: '/guides/mcp-plugins', marketplace: '/guides/mcp-plugins',
  update: '/installation', completion: '/installation', 'shell-init': '/installation', status: '/surfaces/repl',
};

/** Commander Help is the public API for filtering hidden commands/options. */
function visible(cmd: Command): Command[] {
  // Commander synthesizes `help [command]`; do not recurse into implicit help.
  return cmd.createHelp().visibleCommands(cmd).filter((child) => cmd.commands.includes(child));
}

function renderCommand(cmd: Command, ancestors: string[], guide?: string): string[] {
  const path = [...ancestors, cmd.name()];
  const help = cmd.createHelp();
  const lines = [`## ${code(path.join(' '))}`, '', cell(cmd.description()), '',
    `Usage: ${code(`${path.slice(0, -1).join(' ')} ${cmd.name()} ${cmd.usage()}`.trim())}`, ''];
  if (cmd.aliases().length) lines.push(`Aliases: ${cmd.aliases().map(code).join(', ')}`, '');
  if (guide) lines.push(`Guide: [${guide.split('/').at(-1)}](${guide})`, '');
  if (cmd.registeredArguments.length) {
    lines.push('### Arguments', '', '| Argument | Description | Default |', '| --- | --- | --- |');
    for (const arg of cmd.registeredArguments) {
      const name = `${arg.required ? '<' : '['}${arg.name()}${arg.variadic ? '...' : ''}${arg.required ? '>' : ']'}`;
      lines.push(`| ${code(name)} | ${cell(arg.description)} | ${arg.defaultValue === undefined ? '' : code(JSON.stringify(arg.defaultValue))} |`);
    }
    lines.push('');
  }
  lines.push('### Options', '', '| Flags | Description | Default |', '| --- | --- | --- |');
  for (const option of help.visibleOptions(cmd)) {
    lines.push(`| ${code(option.flags)} | ${cell(option.description)} | ${option.defaultValue === undefined ? '' : code(JSON.stringify(option.defaultValue))} |`);
  }
  lines.push('');
  const children = visible(cmd);
  if (children.length) {
    lines.push('### Subcommands', '', '| Command | Description |', '| --- | --- |');
    for (const child of children) lines.push(`| ${code(child.name())} | ${cell(child.description())} |`);
    lines.push('');
  }
  for (const child of children) lines.push(...renderCommand(child, path, guide ?? guides[child.name()]));
  return lines;
}

export function renderCli(program: Command): string {
  const lines = pageHeader('CLI reference', 'Commands, arguments, and options accepted by afk.', 'scan:cli', 'the Commander command registrars');
  lines.push('Use `afk` for the interactive REPL or choose a command below. Commands follow stable registration order; hidden commands and options are omitted. Run `afk --version` for the installed version.', '');
  lines.push(...renderCommand(program, []));
  return lines.join('\n');
}
