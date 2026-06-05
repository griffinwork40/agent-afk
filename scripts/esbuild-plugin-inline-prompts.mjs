/**
 * esbuild plugin that inlines .md prompt files at build time.
 *
 * Handles two patterns:
 * A) Direct readFileSync calls with statically-resolvable paths to .md files
 *    → replaced with string literals
 * B) The prompt-loader.ts module (uses readdirSync + readFileSync in a loop)
 *    → replaced entirely with a generated module backed by a hardcoded lookup table
 *
 * Strategy: pre-build source transform. Before esbuild runs, copies src/ to a
 * temp directory with .md-reading code replaced. esbuild then bundles from the
 * transformed copy. This avoids fighting esbuild's built-in TypeScript resolver.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const srcRoot = join(repoRoot, 'src');

// ---------------------------------------------------------------------------
// Invariant: internal-tier IP must never ship in the public npm bundle.
//
// These prompts and skills contain calibrated rubrics and orchestration logic
// that is maintainer-only IP. They must NOT be inlined into the public npm
// bundle. `prepareSources()` operates on a TEMP COPY of src/ (via cpSync),
// so excluding them here affects only the published bundle — dev mode and
// tests run from the real src/ and are completely unaffected.
//
// INTERNAL_TIER_SKILL_DIRS:
//   Skill directories under src/skills/ whose prompts/ contents are internal.
//   buildPromptTable() skips these entire directories so none of their .md
//   files ever enter the inlined lookup table.
//
// INTERNAL_TIER_PROMPT_BASENAMES:
//   Individual agent prompt basenames under src/skills/_agents/prompts/ that
//   are internal IP. Pattern A (readFileSync inliner) stubs these out instead
//   of inlining the real content, so the replacement still produces valid code
//   and nothing throws at import time.
// ---------------------------------------------------------------------------
const INTERNAL_TIER_SKILL_DIRS = new Set([
  'forge', // internal-tier skill: excluded from public build
]);

const INTERNAL_TIER_PROMPT_BASENAMES = new Set([
  'qualify.md', // internal-tier agent prompt — excluded from public build
]);

/** Stub string emitted in place of excluded internal-tier prompt content. */
const INTERNAL_TIER_STUB = '[internal-tier prompt excluded from public build]';

function buildPromptTable() {
  const skillsDir = join(srcRoot, 'skills');
  const table = {};

  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(ent => ent.isDirectory() && !ent.name.startsWith('_'));

  for (const skillDir of skillDirs) {
    // Internal-tier: skip skill directories whose prompts must not ship publicly.
    if (INTERNAL_TIER_SKILL_DIRS.has(skillDir.name)) {
      console.log(`  [inline-prompts] Skipping internal-tier skill: ${skillDir.name}`);
      continue;
    }

    const promptsDir = join(skillsDir, skillDir.name, 'prompts');
    if (!existsSync(promptsDir)) continue;

    const mdFiles = readdirSync(promptsDir, { withFileTypes: true })
      .filter(ent => ent.isFile() && ent.name.endsWith('.md'))
      .map(ent => ent.name)
      .sort();

    if (mdFiles.length === 0) continue;

    table[skillDir.name] = {};
    for (const file of mdFiles) {
      table[skillDir.name][file] = readFileSync(join(promptsDir, file), 'utf-8');
    }
  }

  return table;
}

function generatePromptLoaderModule(table) {
  const json = JSON.stringify(table);
  return `
const PROMPTS: Record<string, Record<string, string>> = ${json};
export function loadSkillPrompts(name: string): Record<string, string> {
  const entry = PROMPTS[name];
  if (!entry) {
    const available = Object.keys(PROMPTS).sort();
    const availableMsg = available.length > 0 ? "Available: " + available.join(", ") : "";
    throw new Error("Unknown skill: " + name + ". " + availableMsg);
  }
  return entry;
}
`;
}

function escapeForTemplate(str) {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

function tryResolveReadFileSyncPath(callText, fileDir) {
  const joinMatch = callText.match(
    /readFileSync\(\s*(?:join|resolve)\s*\(\s*(?:__dirname|here)\s*,\s*(.+?)\)\s*,\s*['"]utf-?8['"]\s*\)/
  );
  if (joinMatch) {
    const argsStr = joinMatch[1];
    const parts = argsStr.split(',').map(s => {
      const trimmed = s.trim();
      const strMatch = trimmed.match(/^['"](.+)['"]$/);
      return strMatch ? strMatch[1] : null;
    });
    if (parts.every(p => p !== null)) {
      const resolved = join(fileDir, ...parts);
      if (resolved.endsWith('.md') && existsSync(resolved)) {
        return resolved;
      }
    }
  }
  return null;
}

/**
 * Pre-build transform: copies src/ to a temp directory with prompt-reading
 * code replaced by inlined string literals. Returns the temp src root path.
 */
export function prepareSources() {
  const tmpBase = join(tmpdir(), 'afk-build-' + randomBytes(4).toString('hex'));
  const tmpSrc = join(tmpBase, 'src');
  const stats = { inlinedFiles: 0, replacedCalls: 0, promptLoaderReplaced: false, stubbed: 0 };

  // Copy entire src/ tree
  cpSync(srcRoot, tmpSrc, { recursive: true });

  // Also copy the root prompts/ directory if it exists
  const rootPrompts = join(repoRoot, 'prompts');
  if (existsSync(rootPrompts)) {
    cpSync(rootPrompts, join(tmpBase, 'prompts'), { recursive: true });
  }

  // BONUS: stub forge/index.ts in the temp copy to a no-op so forge's
  // orchestration code is excluded from the public bundle entirely.
  // forge is audience:'internal' (AFK_INTERNAL=1 required) and imports
  // internal-tier dependencies that have no meaning in public builds.
  // all.ts imports it for its registerSkill() side-effect only — an
  // empty module satisfies that import without pulling in any forge code.
  const forgeTmpIndex = join(tmpSrc, 'skills', 'forge', 'index.ts');
  if (existsSync(forgeTmpIndex)) {
    writeFileSync(forgeTmpIndex, '// internal-tier skill excluded from public build\nexport {};\n');
    console.log('  [inline-prompts] Stubbed internal-tier skill code: skills/forge/index.ts');
  }

  // Pattern B: replace prompt-loader.ts entirely
  const promptLoaderPath = join(tmpSrc, 'skills', '_lib', 'prompt-loader.ts');
  if (existsSync(promptLoaderPath)) {
    const table = buildPromptTable();
    const skillCount = Object.keys(table).length;
    const fileCount = Object.values(table).reduce((sum, s) => sum + Object.keys(s).length, 0);
    console.log(`  [inline-prompts] Replacing prompt-loader with ${fileCount} prompts from ${skillCount} skills (internal-tier skills excluded)`);
    writeFileSync(promptLoaderPath, generatePromptLoaderModule(table));
    stats.promptLoaderReplaced = true;
  }

  // Pattern A: walk all .ts files and inline readFileSync calls pointing to .md
  function walk(dir, originalDir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const tmpPath = join(dir, ent.name);
      const origPath = join(originalDir, ent.name);
      if (ent.isDirectory()) {
        walk(tmpPath, origPath);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.ts')) continue;
      if (tmpPath === promptLoaderPath) continue;

      const content = readFileSync(tmpPath, 'utf-8');
      if (!content.includes('readFileSync') || !/\.md['"]/.test(content)) continue;

      // Use the ORIGINAL directory for path resolution (tmp copy won't have .md files
      // if they're not in the ts tree, but the original src does)
      const origFileDir = dirname(origPath);
      const pattern = /readFileSync\(\s*(?:join|resolve)\s*\([^)]*\)\s*,\s*['"]utf-?8['"]\s*\)/g;
      let result = content;

      const matches = [...content.matchAll(pattern)];
      for (const match of matches.reverse()) {
        const mdPath = tryResolveReadFileSyncPath(match[0], origFileDir);
        if (mdPath) {
          // Internal-tier: emit a stub instead of the real content when the
          // resolved .md basename is in the denylist. This keeps the
          // readFileSync replacement syntactically valid (no import-time throw)
          // while ensuring the calibrated rubric / internal prompt never
          // reaches the public bundle.
          const mdBasename = basename(mdPath);
          const relPath = relative(srcRoot, mdPath);
          let mdContent;
          if (INTERNAL_TIER_PROMPT_BASENAMES.has(mdBasename)) {
            mdContent = INTERNAL_TIER_STUB;
            console.log(`  [inline-prompts] Stubbed internal-tier prompt: ${relPath}`);
            stats.stubbed++;
          } else {
            mdContent = readFileSync(mdPath, 'utf-8');
            console.log(`  [inline-prompts] Inlined ${relPath}`);
            stats.inlinedFiles++;
          }
          const replacement = '`' + escapeForTemplate(mdContent) + '`';
          result = result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
          stats.replacedCalls++;
        }
      }

      if (result !== content) {
        writeFileSync(tmpPath, result);
      }
    }
  }

  walk(tmpSrc, srcRoot);

  // Pattern C: inline the root-level system prompt in shared-helpers.ts
  // The code uses a two-line pattern: resolve(...) into a variable, then readFileSync(variable)
  const sharedHelpersPath = join(tmpSrc, 'cli', 'shared-helpers.ts');
  const systemPromptPath = join(repoRoot, 'prompts', 'system-prompt.md');
  if (existsSync(sharedHelpersPath) && existsSync(systemPromptPath)) {
    let shContent = readFileSync(sharedHelpersPath, 'utf-8');
    const systemPrompt = readFileSync(systemPromptPath, 'utf-8');
    const escaped = escapeForTemplate(systemPrompt);
    // Find and replace the exact function body using string search
    const oldFn = `export function loadSystemPrompt(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = resolve(here, '..', '..', 'prompts', 'system-prompt.md');
  if (!existsSync(promptPath)) return undefined;
  try {
    return readFileSync(promptPath, 'utf-8');
  } catch {
    return undefined;
  }
}`;
    const newFn = 'export function loadSystemPrompt(): string | undefined {\n  return `' + escaped + '`;\n}';
    if (shContent.includes(oldFn)) {
      shContent = shContent.replace(oldFn, newFn);
      writeFileSync(sharedHelpersPath, shContent);
      console.log(`  [inline-prompts] Inlined prompts/system-prompt.md into loadSystemPrompt()`);
      stats.inlinedFiles++;
      stats.replacedCalls++;
    } else {
      console.log(`  [inline-prompts] WARNING: Could not find loadSystemPrompt() in shared-helpers.ts`);
    }
  }

  console.log(`  [inline-prompts] Summary: ${stats.inlinedFiles} files inlined, ${stats.stubbed} internal-tier stubs, ${stats.replacedCalls} readFileSync calls replaced, prompt-loader ${stats.promptLoaderReplaced ? 'replaced' : 'NOT replaced (warning!)'}`);

  return { tmpSrc, tmpBase };
}
