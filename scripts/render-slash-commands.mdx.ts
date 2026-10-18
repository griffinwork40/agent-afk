import type { SlashCommand } from '../src/cli/slash/types.js';
import { cell, code, pageHeader } from './lib/docs-reference.js';

function section(title: string, commands: readonly SlashCommand[]): string[] {
  const lines = [`## ${title}`, ''];
  for (const cmd of [...commands].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`### ${code(cmd.name)}`, '', cell(cmd.summary), '',
      `Usage: ${code(cmd.usage ?? cmd.name)}`, '',
      `Aliases: ${cmd.aliases?.length ? cmd.aliases.map(code).join(', ') : 'None'}`, '',
      `Hint: ${cmd.hint ? cell(cmd.hint) : 'None'}`, '',
      `Flags: ${cmd.flags?.length ? cmd.flags.map(code).join(', ') : 'None'}`, '');
  }
  return lines;
}

export function renderSlash(input: { core: readonly SlashCommand[]; skills: readonly SlashCommand[] }): string {
  return [
    ...pageHeader('Slash commands', 'Core REPL commands and public shipped TypeScript skills.', 'scan:slash', 'the isolated slash command registry'),
    'Type these commands in the interactive REPL. Entries are sorted by canonical name. Plugin skill passthroughs, plugin agents, marketplace sourced skills, user skills, project skills, and internal skills are excluded; core plugin and marketplace management commands remain available.', '',
    ...section('Core commands', input.core),
    'The following public TypeScript skills are shipped in the package and require no user or plugin installation.', '',
    ...section('Shipped TypeScript skills', input.skills),
  ].join('\n');
}
