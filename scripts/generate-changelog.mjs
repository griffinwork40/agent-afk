#!/usr/bin/env node
/**
 * generate-changelog.mjs — CI helper for auto-release workflow.
 *
 * Generates changelog entries from conventional commits, writes them into
 * the [Unreleased] section, then stamps the release heading.
 *
 * Usage: node scripts/generate-changelog.mjs <version>
 *   e.g. node scripts/generate-changelog.mjs 1.3.0
 *
 * Reuses the same parsing/formatting logic as the /changelog slash command
 * via src/changelog.ts (built to dist/changelog.js).
 *
 * WARNING: The import path "dist/changelog.js" mirrors tsconfig.json `outDir`.
 * No package.json `exports` map enforces this contract — if `outDir` ever
 * changes, this script silently breaks. The auto-release workflow guards
 * against a missing build with an explicit accessSync check before invocation.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/generate-changelog.mjs <version>');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

const { parseCommits, formatEntries, updateAndStampChangelog } = await import(
  resolve(repoRoot, 'dist', 'changelog.js')
);

const commits = parseCommits(repoRoot);

if (commits.length === 0) {
  console.log('No commits since last tag — changelog unchanged.');
  process.exit(0);
}

console.log(`${commits.length} commits since last tag`);

// CI passes includeHash: true so updateAndStampChangelog can dedup on
// repeated workflow runs. The /changelog slash command omits this flag
// to preserve plain `- <subject>` bullets in human-facing changelogs.
const formatted = formatEntries(commits, { includeHash: true });
console.log('Generated entries:\n' + formatted);

updateAndStampChangelog(repoRoot, formatted, version, today);

console.log(`Changelog updated for v${version}`);
