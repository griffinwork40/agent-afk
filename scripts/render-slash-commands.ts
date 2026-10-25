#!/usr/bin/env tsx
/** Run through lib/isolated-reference.ts: registerAll scans user/project roots.
 * Only public vendored TS skills from skills/all.ts survive filtering. Static
 * /skills, /agents, /marketplace management commands are core UI, not dynamic
 * plugin passthroughs, and therefore remain documented.
 */
import { registerAll } from '../src/cli/slash/index.js';
import { list, aliasEntries } from '../src/cli/slash/registry.js';
import { getSkill, listSkills, isSkillVisible } from '../src/skills/skill-registry.js';
import type { SkillMetadata } from '../src/skills/skill-types.js';
import type { SlashCommand } from '../src/cli/slash/types.js';
import { renderSlash } from './render-slash-commands.mdx.js';
import { isMain, writeReference } from './lib/docs-reference.js';

export function isPublicBuiltin(skill: Pick<SkillMetadata, 'origin' | 'audience'>): boolean {
  return (skill.origin === undefined || skill.origin === 'builtin') && isSkillVisible(skill, false);
}

export function partitionSlash(commands: readonly SlashCommand[], metadata: readonly SkillMetadata[]): { core: SlashCommand[]; skills: SlashCommand[]; excluded: string[] } {
  const skillNames = new Set(metadata.map((skill) => `/${skill.name}`));
  const publicNames = new Set(metadata.filter(isPublicBuiltin).map((skill) => `/${skill.name}`));
  // Read aliases from the authoritative registry, not only command metadata.
  const aliases = aliasEntries();
  const withAliases = (cmd: SlashCommand): SlashCommand => ({
    ...cmd, aliases: aliases.filter((entry) => entry.canonical === cmd.name).map((entry) => entry.alias),
  });
  return {
    core: commands.filter((cmd) => !skillNames.has(cmd.name) && !cmd.acceptsAttachments).map(withAliases),
    skills: commands.filter((cmd) => publicNames.has(cmd.name)).map(withAliases),
    excluded: [...new Set([...skillNames].filter((name) => !publicNames.has(name)).concat(commands.filter((cmd) => cmd.acceptsAttachments && !publicNames.has(cmd.name)).map((cmd) => cmd.name)))].sort(),
  };
}

export function collectSlash(): ReturnType<typeof partitionSlash> {
  registerAll();
  return partitionSlash(list(), listSkills().map(getSkill));
}

if (isMain(import.meta.url)) {
  const result = collectSlash();
  console.log(`${result.core.length} core slash commands; ${result.skills.length} public shipped TS skills; ${result.excluded.length} excluded registered skills (${result.excluded.join(', ')})`);
  process.exitCode = writeReference('slash-commands', renderSlash(result), process.argv.includes('--check'), undefined, 'scan:slash') ? 0 : 1;
}
