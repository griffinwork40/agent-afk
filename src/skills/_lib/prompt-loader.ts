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
 * @param name - The skill name (matches a directory name under the skills root)
 * @param baseDir - Optional absolute path to the skills root that CONTAINS the
 *   `<name>/` directory. When omitted, resolves the in-tree skills root relative
 *   to this module (`dist/skills` at runtime, `src/skills` under tsx). Pass this
 *   so an out-of-tree plugin can load prompts bundled in its own package — e.g.
 *   `loadSkillPrompts('my-skill', join(dirname(fileURLToPath(import.meta.url)), 'skills'))`.
 * @returns Record mapping filename to file content
 * @throws Error if skill directory or prompts/ subdirectory doesn't exist
 */
export function loadSkillPrompts(name: string, baseDir?: string): Record<string, string> {
  // P3 path-traversal guard: reject any name that could escape the skills root.
  // This is the only segment that ever derives from a skill id; the guard keeps
  // a malicious `name` from climbing out of `baseDir` (or the in-tree root).
  // Today's in-tree callers already validate via getSkill(); plugins pass a
  // trusted baseDir, so the name remains the sole traversal vector here.
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name.startsWith('.') ||
    name.includes('..')
  ) {
    throw new Error(`Skill name contains illegal path components: ${name}`);
  }

  // Resolve the skills root: an explicit baseDir (plugin-supplied) wins; otherwise
  // derive the in-tree root relative to this module's location.
  const skillsDir =
    baseDir ?? join(dirname(fileURLToPath(import.meta.url)), '../..', 'skills');
  const skillPath = join(skillsDir, name);
  const promptsPath = join(skillPath, 'prompts');

  // Check if skill directory exists
  if (!existsSync(skillPath)) {
    // Get available skills by listing the skills root
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
