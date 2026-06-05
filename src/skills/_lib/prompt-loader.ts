/**
 * Multi-prompt loader that globs src/skills/<name>/prompts/*.md
 * and returns them in alphabetical key order.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Load all markdown prompts from a skill's prompts/ directory.
 * Returns a Record<filename, content> with keys in alphabetical order.
 *
 * @param name - The skill name (matches directory name under src/skills/)
 * @returns Record mapping filename to file content
 * @throws Error if skill directory or prompts/ subdirectory doesn't exist
 */
export function loadSkillPrompts(name: string): Record<string, string> {
  // P3 path-traversal guard: reject any name that could escape the skills/
  // directory. This is a defence-in-depth check for future callers who may
  // pass user-controlled input; today's callers already validate via getSkill().
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name.startsWith('.') ||
    name.includes('..')
  ) {
    throw new Error(`Skill name contains illegal path components: ${name}`);
  }

  // Resolve the prompts directory relative to this file's location
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(currentDir, '../..');
  const skillPath = join(projectRoot, 'skills', name);
  const promptsPath = join(skillPath, 'prompts');

  // Check if skill directory exists
  if (!existsSync(skillPath)) {
    // Get available skills by listing src/skills/
    const skillsDir = join(projectRoot, 'skills');
    let available: string[] = [];
    if (existsSync(skillsDir)) {
      try {
        available = readdirSync(skillsDir, { withFileTypes: true })
          .filter((ent) => ent.isDirectory() && !ent.name.startsWith('_'))
          .map((ent) => ent.name)
          .sort();
      } catch {
        // If we can't list, just use empty array
      }
    }

    const availableMsg = available.length > 0 ? `Available: ${available.join(', ')}` : '';
    throw new Error(
      `Unknown skill: ${name}. ${availableMsg}`.trim(),
    );
  }

  // Check if prompts/ directory exists
  if (!existsSync(promptsPath)) {
    throw new Error(
      `Skill ${name} has no prompts/ dir at ${promptsPath}`,
    );
  }

  // Read all .md files from prompts/
  const files = readdirSync(promptsPath, { withFileTypes: true });
  const prompts: Record<string, string> = {};

  // Sort filenames alphabetically
  const mdFiles = files
    .filter((ent) => ent.isFile() && ent.name.endsWith('.md'))
    .map((ent) => ent.name)
    .sort();

  for (const filename of mdFiles) {
    const filePath = join(promptsPath, filename);
    prompts[filename] = readFileSync(filePath, 'utf-8');
  }

  return prompts;
}
