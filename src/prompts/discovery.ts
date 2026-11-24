/**
 * Filesystem walker that discovers all PromptEntry records across the six
 * prompt kinds defined in types.ts.
 *
 * Contract: pure function — no singletons, no side effects, no env reads.
 * All paths arrive via DiscoveryOptions. Callers that need defaults should
 * supply them before calling discoverPrompts().
 */

import { join, relative, basename, dirname } from 'path';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
import type { PromptEntry } from './types.js';

export interface DiscoveryOptions {
  repoRoot: string;
  /** Defaults to join(homedir(), '.afk') */
  afkHome?: string;
  /** For project-scope .afk/skills/ discovery */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readContent(sourcePath: string): string {
  return readFileSync(sourcePath, 'utf-8');
}

function tokenEstimate(sourcePath: string): number {
  return Math.ceil(readContent(sourcePath).length / 4);
}

function makeLoad(sourcePath: string): () => string {
  return () => readFileSync(sourcePath, 'utf-8');
}

/** List immediate children of a directory; returns [] if dir doesn't exist. */
function safeReaddir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Return only entries that are directories. */
function subdirs(dir: string): string[] {
  return safeReaddir(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Return only entries that are files matching a suffix. */
function filesWithSuffix(dir: string, suffix: string): string[] {
  return safeReaddir(dir).filter((name) => {
    if (!name.endsWith(suffix)) return false;
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Per-kind walkers
// ---------------------------------------------------------------------------

function walkFramework(repoRoot: string): PromptEntry[] {
  const sourcePath = join(repoRoot, 'system-prompt.md');
  if (!existsSync(sourcePath)) return [];
  const relativePath = 'system-prompt.md';
  const id = `framework:${relativePath}`;
  return [
    {
      id,
      kind: 'framework',
      name: 'system-prompt',
      sourcePath,
      relativePath,
      editable: false,
      pinned: false,
      tokenEstimate: tokenEstimate(sourcePath),
      injectionContext: 'session system prompt',
      load: makeLoad(sourcePath),
    },
  ];
}

function walkSpine(repoRoot: string): PromptEntry[] {
  const spineDir = join(repoRoot, 'src', 'agent', 'spine', 'prompts');
  const entries: PromptEntry[] = [];
  for (const filename of filesWithSuffix(spineDir, '.md').sort()) {
    const sourcePath = join(spineDir, filename);
    const relativePath = relative(repoRoot, sourcePath);
    const id = `spine:${relativePath}`;
    const stem = basename(filename, '.md');
    entries.push({
      id,
      kind: 'spine',
      name: stem,
      sourcePath,
      relativePath,
      editable: false,
      pinned: false,
      tokenEstimate: tokenEstimate(sourcePath),
      injectionContext: 'spine classifier',
      load: makeLoad(sourcePath),
    });
  }
  return entries;
}

function walkSkillPhases(repoRoot: string): PromptEntry[] {
  const skillsRoot = join(repoRoot, 'src', 'skills');
  const entries: PromptEntry[] = [];
  for (const skillName of subdirs(skillsRoot).sort()) {
    // _agents and _lib are not user-facing skills
    if (skillName.startsWith('_')) continue;
    const promptsDir = join(skillsRoot, skillName, 'prompts');
    if (!existsSync(promptsDir)) continue;
    for (const filename of filesWithSuffix(promptsDir, '.md').sort()) {
      const sourcePath = join(promptsDir, filename);
      const relativePath = relative(repoRoot, sourcePath);
      const phase = basename(filename, '.md');
      const id = `skill-phase:${relativePath}`;
      entries.push({
        id,
        kind: 'skill-phase',
        name: `${skillName}/${phase}`,
        skill: skillName,
        phase,
        sourcePath,
        relativePath,
        editable: false,
        pinned: false,
        tokenEstimate: tokenEstimate(sourcePath),
        injectionContext: 'skill phase (fork)',
        load: makeLoad(sourcePath),
      });
    }
  }
  return entries;
}

function walkVendoredAgents(repoRoot: string): PromptEntry[] {
  const agentsPromptsDir = join(repoRoot, 'src', 'skills', '_agents', 'prompts');
  const entries: PromptEntry[] = [];
  for (const filename of filesWithSuffix(agentsPromptsDir, '.md').sort()) {
    const sourcePath = join(agentsPromptsDir, filename);
    const relativePath = relative(repoRoot, sourcePath);
    const stem = basename(filename, '.md');
    const id = `vendored-agent:${relativePath}`;
    entries.push({
      id,
      kind: 'vendored-agent',
      name: stem,
      sourcePath,
      relativePath,
      editable: false,
      pinned: true,
      tokenEstimate: tokenEstimate(sourcePath),
      injectionContext: 'named agent definition',
      load: makeLoad(sourcePath),
    });
  }
  return entries;
}

function walkBundledSkills(repoRoot: string): PromptEntry[] {
  const bundledSkillsRoot = join(
    repoRoot,
    'src',
    'bundled-plugins',
    'awa-bundled',
    'skills',
  );
  const entries: PromptEntry[] = [];
  for (const skillName of subdirs(bundledSkillsRoot).sort()) {
    const skillMdPath = join(bundledSkillsRoot, skillName, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;
    const relativePath = relative(repoRoot, skillMdPath);
    const id = `bundled-skill:${relativePath}`;
    entries.push({
      id,
      kind: 'bundled-skill',
      name: skillName,
      skill: skillName,
      sourcePath: skillMdPath,
      relativePath,
      editable: false,
      pinned: false,
      tokenEstimate: tokenEstimate(skillMdPath),
      injectionContext: 'bundled skill (fork/load)',
      load: makeLoad(skillMdPath),
    });
  }
  return entries;
}

function walkUserSkillsDir(dir: string, homeBase: string): PromptEntry[] {
  const entries: PromptEntry[] = [];
  for (const skillName of subdirs(dir).sort()) {
    const skillMdPath = join(dir, skillName, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;
    const relativePath = relative(homeBase, skillMdPath);
    const id = `user-skill:${relativePath}`;
    entries.push({
      id,
      kind: 'user-skill',
      name: skillName,
      skill: skillName,
      sourcePath: skillMdPath,
      relativePath,
      editable: true,
      pinned: false,
      tokenEstimate: tokenEstimate(skillMdPath),
      injectionContext: 'user skill',
      load: makeLoad(skillMdPath),
    });
  }
  return entries;
}

function walkUserSkills(afkHome: string, cwd?: string): PromptEntry[] {
  const userSkillsDir = join(afkHome, 'skills');
  const userHome = dirname(afkHome); // e.g. /Users/foo
  const entries: PromptEntry[] = walkUserSkillsDir(userSkillsDir, userHome);

  // Project-scope: <cwd>/.afk/skills/
  if (cwd !== undefined && cwd !== '') {
    const projectSkillsDir = join(cwd, '.afk', 'skills');
    entries.push(...walkUserSkillsDir(projectSkillsDir, cwd));
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function discoverPrompts(opts: DiscoveryOptions): PromptEntry[] {
  const { repoRoot, cwd } = opts;
  const afkHome = opts.afkHome ?? join(homedir(), '.afk');

  return [
    ...walkFramework(repoRoot),
    ...walkSpine(repoRoot),
    ...walkSkillPhases(repoRoot),
    ...walkVendoredAgents(repoRoot),
    ...walkBundledSkills(repoRoot),
    ...walkUserSkills(afkHome, cwd),
  ];
}
